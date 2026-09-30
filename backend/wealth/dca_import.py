"""Explicitly confirmed DCA imports with durable, stage-specific provenance."""

from collections import defaultdict
from decimal import Decimal

from django.db import transaction
from django.db.models import Q

from .common import DomainError, audit, day, dec, digest, get_obj, money_round, serial
from .institution_funding import available_funding_cash
from .investments import validate_investment_account
from .ledger import post_event
from .models import (
    Account,
    Event,
    Instrument,
    Occurrence,
    PositionMovement,
    Resource,
    ResourceRevision,
    Workspace,
)

KIND = "dca_import_periods"
ZERO = Decimal(0)
ROW_FIELDS = {
    "scheduled_date",
    "debit_date",
    "amount",
    "funding_account_id",
    "status",
    "confirmation_date",
    "quantity",
    "nav",
    "fee",
    "rounding_adjustment",
    "rounding_confirmed",
    "entry_basis",
}
BODY_FIELDS = {
    "holding_account_id",
    "rows",
    "expected_revision",
    "expected_plan_version",
    "validation_digest",
    "confirm_actual_records",
    "confirm_preview_entries",
}
ENTRY_BASES = {"institution", "preview_confirmed"}
DEBIT_FIELDS = ("debit_date", "amount", "funding_account_id")
CONFIRM_FIELDS = ("confirmation_date", "quantity", "nav", "fee", "rounding_adjustment")


def _error(error):
    return {"code": error.code, "message": error.message}


def _record(resource):
    data = {**resource.data, "id": str(resource.pk), "version": resource.version}
    # Older imports required an explicit institution-record confirmation. Do not
    # rewrite these resources merely to expose the backward-compatible default.
    data.setdefault("entry_basis", "institution")
    data.setdefault("debit_entry_basis", data["entry_basis"])
    data.setdefault(
        "confirmation_entry_basis",
        data["entry_basis"] if data.get("confirmation_event_id") else None,
    )
    data["contains_preview_entries"] = "preview_confirmed" in {
        data["debit_entry_basis"],
        data["confirmation_entry_basis"],
    }
    return data


def _plan(space, plan_id):
    plan = get_obj(Resource, space, plan_id, kind="plans")
    if (
        plan.data.get("kind") != "dca"
        or plan.data.get("frequency") != "daily"
        or str(plan.data.get("interval", 1)) != "1"
    ):
        raise DomainError(
            "仅支持每日定投计划的实际记录补录", "dca_frequency_unsupported"
        )
    instrument = get_obj(Instrument, space, plan.data.get("instrument_id"))
    if instrument.kind != "fund" or (instrument.specification or {}).get(
        "is_derivative"
    ):
        raise DomainError("此入口只补录基金申购与份额确认")
    return plan, instrument


def import_status(space, plan_id):
    plan, _ = _plan(space, plan_id)
    return {
        "items": [
            _record(row)
            for row in Resource.objects.filter(
                tenant=space, kind=KIND, data__plan_id=str(plan.pk)
            ).order_by("data__scheduled_date")
        ],
        "data_revision": Workspace.objects.get(pk=space.pk).revision,
        "plan_version": plan.version,
    }


def _date(value, label):
    if not value:
        raise DomainError(
            f"请填写{label}，缺失日期不能自动补造", "actual_date_required"
        )
    when = day(value)
    if when > day():
        raise DomainError(f"{label}不能晚于今天")
    return when


def _baseline(space, account, when):
    opening = (
        Event.objects.filter(tenant=space, kind="opening", reversal__isnull=True)
        .filter(Q(lines__account=account) | Q(movements__account=account))
        .order_by("economic_date")
        .first()
    )
    if opening and when < opening.economic_date:
        raise DomainError(
            f"{account.name} 的期初为 {opening.economic_date}，不能再扣除期初已包含的历史交易；请先核对更早期初或改用已核实存量持仓录入",
            "before_opening",
        )


def _occurrence(space, plan, scheduled, existing):
    rows = list(Occurrence.objects.filter(tenant=space, plan=plan, due_date=scheduled))
    if len(rows) > 1:
        raise DomainError(
            "同一计划日期有多个期次，请先整理计划", "dca_occurrence_conflict"
        )
    if rows:
        row = rows[0]
        if row.status == "cancelled" or (
            row.status == "skipped" and not row.details.get("auto_skip")
        ):
            raise DomainError(
                "该期次已跳过或取消，请先核对计划状态", "dca_occurrence_conflict"
            )
        if row.event_id and (
            not existing or str(row.event_id) != existing.get("debit_event_id")
        ):
            raise DomainError(
                "该日期已关联其他实际事项，不能再次扣款", "dca_occurrence_conflict"
            )
        return row
    if existing:
        raise DomainError(
            "已导入期次缺少原计划关联，请先核对记录", "dca_registry_conflict"
        )
    sequence = (scheduled - day(plan.data.get("start_date"))).days + 1
    if (
        sequence < 1
        or Occurrence.objects.filter(
            tenant=space, plan=plan, sequence=sequence
        ).exists()
    ):
        raise DomainError(
            "计划开始日或期次已变更，不能用预览序号覆盖已有期次",
            "dca_occurrence_conflict",
        )
    return None


def validate_import(space, plan_id, body):
    if not isinstance(body, dict) or set(body) - BODY_FIELDS:
        raise DomainError("实际补录含不支持的参数")
    plan, instrument = _plan(space, plan_id)
    holding = get_obj(Account, space, body.get("holding_account_id"))
    validate_investment_account(holding, instrument)
    if holding.valuation_mode != "detailed":
        raise DomainError("快照账户请核对机构权益，不能叠加份额持仓")
    currency = instrument.currency
    if plan.data.get("currency", currency) != currency:
        raise DomainError("计划与基金币种不一致，请先核对份额类别", "dca_currency")
    raw_rows = body.get("rows")
    if not isinstance(raw_rows, list) or not 1 <= len(raw_rows) <= 500:
        raise DomainError("每次请核对 1 至 500 个实际期次")
    revision = Workspace.objects.get(pk=space.pk).revision
    registry = list(
        Resource.objects.filter(tenant=space, kind=KIND, data__plan_id=str(plan.pk))
    )
    existing_by_day = {row.data["scheduled_date"]: _record(row) for row in registry}
    blockers, warnings, output = [], [], []
    if len(existing_by_day) != len(registry):
        blockers.append(
            {
                "code": "dca_registry_conflict",
                "message": "该计划有重复补录身份，请先核对",
            }
        )
    managed_ids, confirmation_ids = set(), set()
    for record in existing_by_day.values():
        if record.get("holding_account_id") != str(holding.pk) or record.get(
            "instrument_id"
        ) != str(instrument.pk):
            blockers.append(
                {
                    "code": "dca_identity_conflict",
                    "message": "该计划曾导入到其他账户或产品，不能改变既有补录身份",
                }
            )
        for key in ("debit_event_id", "confirmation_event_id"):
            if not record.get(key):
                continue
            event = Event.objects.filter(
                tenant=space,
                pk=record[key],
                reversal__isnull=True,
                reverses__isnull=True,
            ).first()
            is_debit = key == "debit_event_id"
            expected_account = (
                record.get("funding_account_id")
                if is_debit
                else record.get("holding_account_id")
            )
            expected_date = (
                record.get("debit_date")
                if is_debit
                else record.get("confirmation_date")
            )
            expected_stage = f"{space.pk}:dca:{plan.pk}:{record['scheduled_date']}:{'debit' if is_debit else 'confirm'}"
            valid = (
                event
                and event.stage_key == expected_stage
                and event.payload.get("dca_import_plan_id") == str(plan.pk)
                and event.payload.get("dca_import_date") == record["scheduled_date"]
                and event.kind == ("fund_debit" if is_debit else "fund_confirm")
                and event.payload.get("account_id") == expected_account
                and event.payload.get("instrument_id") == record.get("instrument_id")
                and event.payload.get("entry_basis", "institution")
                == record[
                    "debit_entry_basis" if is_debit else "confirmation_entry_basis"
                ]
                and str(event.economic_date) == expected_date
                and dec(event.payload["amount"]) == dec(record["amount"])
                and (
                    not event.related_id
                    if is_debit
                    else str(event.related_id) == record.get("debit_event_id")
                )
            )
            if valid and not is_debit:
                valid = (
                    dec(event.payload.get("quantity"), places=18)
                    == dec(record["quantity"], places=18)
                    and dec(event.payload.get("price"), places=18)
                    == dec(record["nav"], places=18)
                    and dec(event.payload.get("fee")) == dec(record["fee"])
                    and dec(event.payload.get("rounding_adjustment", "0"))
                    == dec(record.get("rounding_adjustment", "0"))
                )
            if not valid:
                blockers.append(
                    {
                        "code": "dca_registry_conflict",
                        "message": "已有补录被撤销或关联不一致，请先处理该期次，不能重复创建",
                    }
                )
            else:
                managed_ids.add(str(event.pk))
                if key == "confirmation_event_id":
                    confirmation_ids.add(str(event.pk))
                if (
                    event.following.filter(reversal__isnull=True, reverses__isnull=True)
                    .exclude(pk=record.get("confirmation_event_id"))
                    .exists()
                ):
                    blockers.append(
                        {
                            "code": "dca_dependency",
                            "message": "原扣款已有本入口之外的确认、退款或后续事项，请先核对",
                        }
                    )
    active = Event.objects.filter(
        tenant=space, reversal__isnull=True, reverses__isnull=True
    )
    # Catch positions, dividend/split/cash orders, and pending manual subscriptions.
    funding_scope = {
        str(holding.pk),
        *(record.get("funding_account_id") for record in existing_by_day.values()),
        *(row.get("funding_account_id") for row in raw_rows if isinstance(row, dict)),
    }
    other = (
        active.filter(
            Q(movements__instrument=instrument, movements__account=holding)
            | Q(
                payload__instrument_id=str(instrument.pk),
                payload__account_id=str(holding.pk),
            )
            | Q(
                payload__instrument_id=str(instrument.pk),
                payload__target_account_id=str(holding.pk),
            )
        )
        .exclude(pk__in=managed_ids)
        .distinct()
    )
    # A debit has no position yet. A completed chain to another account is
    # distinct; an unassigned/pending manual debit on the same payer is ambiguous.
    ambiguous_debits = active.filter(
        kind="fund_debit",
        payload__instrument_id=str(instrument.pk),
        payload__account_id__in=[value for value in funding_scope if value],
    ).exclude(pk__in=managed_ids)
    ambiguous = False
    for debit in ambiguous_debits:
        confirmations = list(
            debit.following.filter(
                kind="fund_confirm", reversal__isnull=True, reverses__isnull=True
            )
        )
        allocated = sum((dec(event.payload["amount"]) for event in confirmations), ZERO)
        if allocated != dec(debit.payload["amount"]) or any(
            event.movements.filter(account=holding, instrument=instrument).exists()
            for event in confirmations
        ):
            ambiguous = True
            break
    if other.exists() or ambiguous:
        blockers.append(
            {
                "code": "dca_existing_history",
                "message": "该产品已有其他存量持仓或实际流水，不能叠加历史估算；请先核对已有记录或明确归属",
            }
        )
    seen = set()
    accounts = {str(holding.pk): holding}
    for raw in raw_rows:
        row = {
            "scheduled_date": raw.get("scheduled_date")
            if isinstance(raw, dict)
            else None,
            "action": None,
            "normalized": None,
            "existing": None,
            "errors": [],
            "warnings": [],
            "suggested_rounding_adjustment": None,
            "rounding_limit": None,
        }
        output.append(row)
        try:
            if not isinstance(raw, dict) or set(raw) - ROW_FIELDS:
                raise DomainError("期次含不支持的字段")
            scheduled = _date(raw.get("scheduled_date"), "原计划日期")
            key = str(scheduled)
            if key in seen:
                raise DomainError(
                    "同次提交不能重复选择同一个计划日期", "dca_duplicate_period"
                )
            seen.add(key)
            existing = existing_by_day.get(key)
            row["existing"] = existing
            data = {**(existing or {}), **raw}
            entry_basis = data.get("entry_basis", "institution")
            if not isinstance(entry_basis, str) or entry_basis not in ENTRY_BASES:
                raise DomainError("请选择按机构记录或按预览补录", "dca_entry_basis")
            if (
                existing
                and (
                    existing["status"] == "confirmed" or data.get("status") == "debited"
                )
                and entry_basis != existing["entry_basis"]
            ):
                raise DomainError(
                    "已记录期次的补录来源不能改写；后补确认只记录新确认阶段的来源",
                    "dca_entry_basis_conflict",
                )
            if not existing and (
                scheduled < day(plan.data.get("start_date"))
                or plan.data.get("end_date")
                and scheduled > day(plan.data["end_date"])
            ):
                raise DomainError("该期超出计划起止日期，请先核对计划设置")
            debit_day = _date(data.get("debit_date"), "实际扣款日期")
            amount = dec(data.get("amount"), nonnegative=True)
            if amount <= ZERO:
                raise DomainError("实际扣款金额须大于零")
            source = get_obj(Account, space, data.get("funding_account_id"))
            accounts[str(source.pk)] = source
            if source.currency != currency:
                raise DomainError(
                    "付款与持仓账户币种须一致；不会补造历史换汇", "dca_currency"
                )
            # Also validates non-archived cash account kinds, even for resume.
            available_funding_cash(space, source, debit_day)
            status = data.get("status")
            if status not in {"debited", "confirmed"}:
                raise DomainError("请按实际记录选择已扣未确认或已确认份额")
            normalized = {
                "scheduled_date": key,
                "debit_date": str(debit_day),
                "amount": str(amount),
                "funding_account_id": str(source.pk),
                "status": status,
                "entry_basis": entry_basis,
                "debit_entry_basis": existing["debit_entry_basis"]
                if existing
                else entry_basis,
                "confirmation_entry_basis": entry_basis
                if status == "confirmed"
                else None,
            }
            row["normalized"] = normalized
            if existing and any(
                normalized[field] != existing[field]
                and (field != "amount" or amount != dec(existing[field]))
                for field in DEBIT_FIELDS
            ):
                raise DomainError(
                    "该期已有真实扣款，不能修改扣款日期、金额或付款账户；需使用冲正核对流程",
                    "dca_debit_conflict",
                )
            occurrence = _occurrence(space, plan, scheduled, existing)
            if occurrence and occurrence.event_id and not existing:
                raise DomainError("该期已记录实际扣款", "dca_occurrence_conflict")
            if not existing:
                _baseline(space, source, debit_day)
            row["action"] = "skip" if existing else "create_debit"
            if status == "confirmed":
                confirmation_day = _date(data.get("confirmation_date"), "实际确认日期")
                if confirmation_day < debit_day:
                    raise DomainError("实际确认日期不能早于实际扣款日期")
                quantity = dec(data.get("quantity"), nonnegative=True, places=18)
                nav = dec(data.get("nav"), nonnegative=True, places=18)
                fee = dec(data.get("fee"), nonnegative=True)
                if quantity <= ZERO or nav <= ZERO or fee >= amount:
                    raise DomainError("实际份额及确认净值须大于零，费用须小于扣款总额")
                calculated = money_round(quantity * nav + fee)
                adjustment = dec(data.get("rounding_adjustment", "0"))
                suggested = amount - calculated
                limit = min(
                    Decimal(1),
                    nav * Decimal("0.01") + Decimal("0.01"),
                    amount * Decimal("0.01"),
                )
                row.update(
                    suggested_rounding_adjustment=suggested, rounding_limit=limit
                )
                normalized.update(
                    confirmation_date=str(confirmation_day),
                    quantity=str(quantity),
                    nav=str(nav),
                    fee=str(fee),
                    rounding_adjustment=str(adjustment),
                    rounding_confirmed=data.get("rounding_confirmed") is True,
                )
                if (
                    adjustment != suggested
                    or abs(adjustment) > limit
                    or adjustment
                    and data.get("rounding_confirmed") is not True
                ):
                    raise DomainError(
                        "实际金额与份额、净值、费用有差异；请逐项核实，小额份额舍入尾差须明确认可，不能自动作为手续费",
                        "dca_rounding_unconfirmed",
                    )
                _baseline(space, holding, confirmation_day)
                if existing and existing.get("status") == "confirmed":
                    if any(
                        normalized[field] != existing[field]
                        and (
                            field == "confirmation_date"
                            or dec(normalized[field], places=18)
                            != dec(existing[field], places=18)
                        )
                        for field in CONFIRM_FIELDS
                    ):
                        raise DomainError(
                            "该期已确认份额，不得重复增加或改写原确认",
                            "dca_confirmation_conflict",
                        )
                    row["action"] = "skip"
                else:
                    row["action"] = (
                        "confirm_existing" if existing else "create_and_confirm"
                    )
                    later = PositionMovement.objects.filter(
                        tenant=space,
                        account=holding,
                        instrument=instrument,
                        event__economic_date__gt=confirmation_day,
                        event__reversal__isnull=True,
                        event__reverses__isnull=True,
                    ).exclude(event_id__in=confirmation_ids)
                    if later.exists():
                        raise DomainError(
                            "实际确认日之后已有其他持仓变动，请先核对，不能改填今天绕过历史依赖",
                            "historical_dependency",
                        )
            if amount != dec(plan.data["amount"]):
                row["warnings"].append(
                    "实际金额与计划不同；仅该期按已核实金额关联，原计划金额保留不变"
                )
            if str(source.pk) != plan.data.get("account_id"):
                row["warnings"].append(
                    "本期使用所选实际付款账户，原计划的未来付款配置不变"
                )
            if entry_basis == "preview_confirmed" and row["action"] != "skip":
                from .subscription_calendar import subscription_day

                if subscription_day(scheduled, instrument)["is_open"] is not True:
                    raise DomainError(
                        "该期为休市日或日历未核实，不能按估算补录；已有实际扣款请选择机构记录",
                        "subscription_closed",
                    )
            if entry_basis == "preview_confirmed":
                row["warnings"].append(
                    "按已确认的预览补录，份额与确认时间仍为推算来源，未标记为机构已核实记录"
                )
        except DomainError as error:
            row["errors"].append(_error(error))
    reserved = defaultdict(lambda: ZERO)
    for row in sorted(
        [item for item in output if not item["errors"]],
        key=lambda item: item["normalized"]["debit_date"],
    ):
        if row["action"] not in {"create_debit", "create_and_confirm"}:
            continue
        data = row["normalized"]
        source = accounts[data["funding_account_id"]]
        available = (
            available_funding_cash(space, source, day(data["debit_date"]))
            - reserved[str(source.pk)]
        )
        amount = dec(data["amount"])
        if amount > available:
            row["errors"].append(
                {
                    "code": "insufficient_source_cash",
                    "message": f"{source.name} 在 {data['debit_date']} 或后续已记日期的可用资金不足；不会借用未来存款或自动补资",
                }
            )
        reserved[str(source.pk)] += amount
    effects = defaultdict(
        lambda: {
            "cash_change": ZERO,
            "transit_change": ZERO,
            "investment_cost_change": ZERO,
        }
    )
    summary = {
        "new_debits": 0,
        "new_confirmations": 0,
        "skipped": 0,
        "debit_amount": ZERO,
        "confirmed_amount": ZERO,
    }
    for row in output:
        if row["errors"]:
            continue
        data, action = row["normalized"], row["action"]
        amount = dec(data["amount"])
        if action in {"create_debit", "create_and_confirm"}:
            summary["new_debits"] += 1
            summary["debit_amount"] += amount
            effects[data["funding_account_id"]]["cash_change"] -= amount
            effects[data["funding_account_id"]]["transit_change"] += amount
        if action in {"create_and_confirm", "confirm_existing"}:
            summary["new_confirmations"] += 1
            summary["confirmed_amount"] += amount
            effects[data["funding_account_id"]]["transit_change"] -= amount
            effects[str(holding.pk)]["investment_cost_change"] += amount
        if action == "skip":
            summary["skipped"] += 1
    signature = digest(
        {
            "plan_id": str(plan.pk),
            "plan_version": plan.version,
            "revision": revision,
            "holding_account_id": str(holding.pk),
            "rows": raw_rows,
        }
    )
    return serial(
        {
            "ready": not blockers and not any(row["errors"] for row in output),
            "data_revision": revision,
            "plan_version": plan.version,
            "validation_digest": signature,
            "holding_account_id": str(holding.pk),
            "rows": output,
            "blockers": blockers,
            "warnings": warnings,
            "summary": summary,
            "account_effects": [
                {
                    "account_id": ident,
                    "name": accounts[ident].name,
                    "currency": currency,
                    **values,
                }
                for ident, values in effects.items()
            ],
        }
    )


def _save_period(
    space, user, plan, holding, instrument, row, debit, confirmation, resource=None
):
    data = {
        **row,
        "plan_id": str(plan.pk),
        "holding_account_id": str(holding.pk),
        "instrument_id": str(instrument.pk),
        "debit_event_id": str(debit.pk),
        "confirmation_event_id": str(confirmation.pk) if confirmation else None,
    }
    if resource:
        resource.data = data
        resource.version += 1
        resource.save()
    else:
        resource = Resource.objects.create(
            tenant=space, created_by=user, kind=KIND, data=data
        )
    ResourceRevision.objects.create(
        tenant=space,
        created_by=user,
        resource=resource,
        version=resource.version,
        data=data,
    )
    audit(
        space,
        user,
        "dca.period_imported",
        resource,
        {
            "plan_id": str(plan.pk),
            "scheduled_date": row["scheduled_date"],
            "debit_event_id": str(debit.pk),
            "confirmation_event_id": data["confirmation_event_id"],
            "entry_basis": data["entry_basis"],
            "debit_entry_basis": data["debit_entry_basis"],
            "confirmation_entry_basis": data["confirmation_entry_basis"],
        },
    )
    return resource


@transaction.atomic
def commit_import(space, user, plan_id, body):
    from .planning import confirm_occurrence

    locked = Workspace.objects.select_for_update().get(pk=space.pk)
    space.revision = locked.revision
    if locked.deleted_at:
        raise DomainError("空间已移入回收站", "not_found", 404)
    validation = validate_import(space, plan_id, body)
    if (
        isinstance(body.get("expected_revision"), bool)
        or str(body.get("expected_revision")) != str(locked.revision)
        or str(body.get("expected_plan_version")) != str(validation["plan_version"])
        or body.get("validation_digest") != validation["validation_digest"]
    ):
        raise DomainError(
            "核对后账簿、计划或表单已变化，请重新校验再提交", "version_conflict", 412
        )
    if not validation["ready"]:
        raise DomainError(
            "本批次尚有未解决问题，未写入任何记录",
            "dca_import_blocked",
            fields={"validation": validation},
        )
    entry_bases = {row["normalized"]["entry_basis"] for row in validation["rows"]}
    if (
        "preview_confirmed" in entry_bases
        and body.get("confirm_preview_entries") is not True
    ):
        raise DomainError(
            "请确认按本次预览及已展示的份额尾差补录；这些记录会保留预览来源标记",
            "preview_confirmation_required",
        )
    if "institution" in entry_bases and body.get("confirm_actual_records") is not True:
        raise DomainError(
            "请明确确认所填为机构实际扣款与确认记录",
            "actual_confirmation_required",
        )
    plan, instrument = _plan(space, plan_id)
    holding = get_obj(Account, space, body["holding_account_id"])
    confirmation_ids = {
        str(row.data["confirmation_event_id"])
        for row in Resource.objects.filter(
            tenant=space, kind=KIND, data__plan_id=str(plan.pk)
        )
        if row.data.get("confirmation_event_id")
    }
    results = []
    # Post all cash facts in actual debit-date order. Confirmations are then
    # posted in actual confirmation-date order, not preview/plan sequence.
    pending = []
    for item in sorted(
        validation["rows"], key=lambda item: item["normalized"]["debit_date"]
    ):
        data = item["normalized"]
        existing = item["existing"]
        if item["action"] == "skip":
            results.append(
                {
                    "scheduled_date": data["scheduled_date"],
                    "action": "skip",
                    "period": existing,
                }
            )
            continue
        scheduled = day(data["scheduled_date"])
        resource = (
            get_obj(Resource, space, existing["id"], kind=KIND) if existing else None
        )
        if existing:
            debit = get_obj(Event, space, existing["debit_event_id"])
        else:
            source = get_obj(Account, space, data["funding_account_id"])
            if available_funding_cash(space, source, day(data["debit_date"])) < dec(
                data["amount"]
            ):
                raise DomainError(
                    "历史可用资金不足，本批次已全部回滚", "insufficient_source_cash"
                )
            debit = post_event(
                space,
                user,
                {
                    "kind": "fund_debit",
                    "account_id": str(source.pk),
                    "holding_account_id": str(holding.pk),
                    "instrument_id": str(instrument.pk),
                    "economic_date": data["debit_date"],
                    "amount": data["amount"],
                    "dca_import_plan_id": str(plan.pk),
                    "dca_import_date": data["scheduled_date"],
                    "entry_basis": data["debit_entry_basis"],
                    "description": "按预览补录历史定投扣款"
                    if data["debit_entry_basis"] == "preview_confirmed"
                    else "核实历史定投实际扣款",
                },
                stage_key=f"{space.pk}:dca:{plan.pk}:{scheduled}:debit",
            )
            occurrence = _occurrence(space, plan, scheduled, None)
            if not occurrence:
                occurrence = Occurrence.objects.create(
                    tenant=space,
                    created_by=user,
                    plan=plan,
                    sequence=(scheduled - day(plan.data["start_date"])).days + 1,
                    due_date=scheduled,
                    amount=dec(data["amount"]),
                    currency=instrument.currency,
                    status="pending",
                    details={},
                )
            else:
                occurrence.version += 1
            occurrence.details = {
                **occurrence.details,
                "original_plan_amount": str(plan.data["amount"]),
                "original_plan_account_id": plan.data["account_id"],
                "account_id": data["funding_account_id"],
                "instrument_id": str(instrument.pk),
                "plan_kind": "dca",
                "dca_import": True,
                "dca_entry_basis": data["debit_entry_basis"],
            }
            occurrence.amount = dec(data["amount"])
            occurrence.save()
            confirm_occurrence(space, user, occurrence, debit.pk)
        if data["status"] == "debited":
            saved = _save_period(
                space, user, plan, holding, instrument, data, debit, None, resource
            )
            results.append(
                {
                    "scheduled_date": data["scheduled_date"],
                    "action": item["action"],
                    "period": _record(saved),
                }
            )
        else:
            pending.append((item, debit, resource))
    for item, debit, resource in sorted(
        pending, key=lambda row: row[0]["normalized"]["confirmation_date"]
    ):
        data = item["normalized"]
        confirmation = post_event(
            space,
            user,
            {
                "kind": "fund_confirm",
                "account_id": str(holding.pk),
                "instrument_id": str(instrument.pk),
                "related_event_id": str(debit.pk),
                "economic_date": data["confirmation_date"],
                "amount": data["amount"],
                "quantity": data["quantity"],
                "price": data["nav"],
                "fee": data["fee"],
                "rounding_adjustment": data["rounding_adjustment"],
                "rounding_confirmed": data["rounding_confirmed"],
                "dca_import_plan_id": str(plan.pk),
                "dca_import_date": data["scheduled_date"],
                "entry_basis": data["confirmation_entry_basis"],
                "debit_entry_basis": data["debit_entry_basis"],
                "description": "按预览补录历史定投份额确认"
                if data["confirmation_entry_basis"] == "preview_confirmed"
                else "核实历史定投实际份额确认",
            },
            stage_key=f"{space.pk}:dca:{plan.pk}:{data['scheduled_date']}:confirm",
            _fund_confirmation={
                "confirmed_amount": data["amount"],
                "rounding_adjustment": data["rounding_adjustment"],
                "plan_id": str(plan.pk),
                "allow_later_event_ids": list(confirmation_ids),
            },
        )
        confirmation_ids.add(str(confirmation.pk))
        saved = _save_period(
            space, user, plan, holding, instrument, data, debit, confirmation, resource
        )
        results.append(
            {
                "scheduled_date": data["scheduled_date"],
                "action": item["action"],
                "period": _record(saved),
            }
        )
    return serial(
        {
            "items": sorted(results, key=lambda row: row["scheduled_date"]),
            "summary": validation["summary"],
            "data_revision": space.revision,
            "creates_ledger_event": bool(
                validation["summary"]["new_debits"]
                or validation["summary"]["new_confirmations"]
            ),
        }
    )
