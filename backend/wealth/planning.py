"""Versioned intentions, reconciliation and cash forecasts; never posts money."""

from copy import deepcopy
from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone

from finance_math.calculations import add_months, available_cash, loan_schedule
from .common import catalog_queryset
from .common import DomainError, audit, day, dec, get_obj, serial
from .ledger import LIABILITIES, balance, position
from .models import (
    Account,
    Event,
    FxRate,
    ImportBatch,
    Instrument,
    Occurrence,
    Resource,
    ResourceRevision,
    Snapshot,
    SourceRecord,
    Workspace,
)

KINDS = {
    "plans",
    "loans",
    "goals",
    "scenarios",
    "reservations",
    "notes",
    "budgets",
    "reconciliations",
    "strategies",
    "todos",
    "watchlist",
}
ZERO = Decimal("0")
MONEY_FIELDS = {
    "amount",
    "principal",
    "interest",
    "fees",
    "fee",
    "budget",
    "target_amount",
    "monthly_income",
    "monthly_expense",
    "linked_freeze_amount",
    "remaining_principal",
}
DATE_FIELDS = {
    "start_date",
    "end_date",
    "target_date",
    "due_date",
    "first_due_date",
    "as_of",
    "effective_from",
    "date",
}
RESOURCE_REFS = {
    "goal_id": "goals",
    "plan_id": "plans",
    "loan_id": "loans",
    "scenario_id": "scenarios",
    "reservation_id": "reservations",
    "note_id": "notes",
    "budget_id": "budgets",
    "strategy_id": "strategies",
}


def today(space):
    return datetime.now(ZoneInfo(space.timezone)).date()


def _integer(value, label, maximum=10000):
    if isinstance(value, bool):
        raise DomainError(f"{label}必须为正整数")
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        raise DomainError(f"{label}必须为正整数")
    if str(parsed) != str(value) or not 1 <= parsed <= maximum:
        raise DomainError(f"{label}须为 1—{maximum} 的整数")
    return parsed


def _normalize(space, value, key=""):
    """All declared relation fields, including nested payment nodes, are scoped."""
    if isinstance(value, dict):
        return {name: _normalize(space, item, name) for name, item in value.items()}
    if isinstance(value, list):
        if key.endswith("_ids"):
            return [_normalize(space, item, key[:-1]) for item in value]
        return [_normalize(space, item) for item in value]
    if key.endswith("_id") and value not in (None, ""):
        if key in RESOURCE_REFS:
            obj = get_obj(Resource, space, value, kind=RESOURCE_REFS[key])
        elif key in {
            "account_id",
            "target_account_id",
            "liability_account_id",
            "source_account_id",
            "holding_account_id",
        }:
            obj = get_obj(Account, space, value)
        elif key == "instrument_id":
            obj = get_obj(Instrument, space, value)
        elif key in {"event_id", "related_event_id", "payment_event_id"}:
            obj = get_obj(Event, space, value)
        elif key == "occurrence_id":
            obj = get_obj(Occurrence, space, value)
        elif key == "snapshot_id":
            obj = get_obj(Snapshot, space, value)
        elif key in {"batch_id", "import_batch_id"}:
            obj = get_obj(ImportBatch, space, value)
        elif key in {"record_id", "source_record_id"}:
            obj = get_obj(SourceRecord, space, value)
        else:
            raise DomainError(f"不支持的关联字段：{key}")
        return str(obj.pk)
    if key in MONEY_FIELDS and value not in (None, ""):
        return str(dec(value, nonnegative=True))
    if key in {"annual_rate", "quantity"} and value not in (None, ""):
        return str(dec(value, nonnegative=True, places=18))
    if key in DATE_FIELDS and value not in (None, ""):
        return str(day(value))
    if isinstance(value, float):
        raise DomainError("计划中的数值须使用十进制字符串，不接受浮点数")
    return serial(value)


def _remember(resource, user):
    ResourceRevision.objects.get_or_create(
        tenant=resource.tenant,
        resource=resource,
        version=resource.version,
        defaults={"created_by": user, "data": deepcopy(resource.data)},
    )


def _currency(space, data, account=None):
    currency = data.get("currency") or (
        account.currency if account else space.base_currency
    )
    if currency not in {"CNY", "HKD", "USD"}:
        raise DomainError("首版支持 CNY、HKD、USD")
    if account and currency != account.currency:
        raise DomainError("计划币种必须与来源账户一致")
    data["currency"] = currency


def _active_reservation(space, data, scenario_override=None):
    if data.get("status", "active") != "active" or data.get("paid", False):
        return False
    scenario_id = data.get("scenario_id")
    if scenario_id:
        scenario = get_obj(Resource, space, scenario_id, kind="scenarios")
        if scenario_override and scenario.data.get(
            "goal_id"
        ) == scenario_override.data.get("goal_id"):
            return scenario.pk == scenario_override.pk
        return scenario.data.get("status") == "active"
    return True


def _check_reservations(space, account, replacing=None, candidate=None):
    rows = []
    for resource in Resource.objects.filter(tenant=space, kind="reservations"):
        if replacing and resource.pk == replacing.pk:
            continue
        if resource.data.get("account_id") == str(account.pk) and _active_reservation(
            space, resource.data
        ):
            rows.append(dict(resource.data, id=str(resource.pk)))
    if candidate and _active_reservation(space, candidate):
        rows.append(
            dict(candidate, id=str(replacing.pk) if replacing else "new-reservation")
        )
    try:
        result = available_cash(balance(space, account, "cash"), account.frozen, rows)
    except ValueError as error:
        raise DomainError(str(error))
    if result["available"] < ZERO:
        raise DomainError(
            "预留超过已交收可安排资金，请先调整金额或资金来源", "insufficient_cash", 409
        )


def _loan_rows(data):
    try:
        return loan_schedule(
            data.get("principal"),
            data.get("annual_rate", "0"),
            _integer(data.get("term_months", data.get("periods")), "贷款期数", 1200),
            data.get("first_due_date"),
            method=data.get("method", "annuity"),
            custom_rows=data.get("custom_rows"),
            day_policy=data.get("day_policy", "clamp"),
            rate_basis=data.get("rate_basis", "nominal"),
            anchor_day=data.get("anchor_day"),
        )["rows"]
    except ValueError as error:
        raise DomainError(str(error))


def _schedule_rows(space, resource, horizon_date):
    data = resource.data
    if resource.kind == "loans":
        offset = int(data.get("_sequence_offset", 0))
        return [
            dict(row, sequence=row["installment"] + offset, amount=row["payment"])
            for row in _loan_rows(data)
            if row["due_date"] <= horizon_date
        ]
    if resource.kind != "plans":
        raise DomainError("仅贷款和周期计划可以生成期次")
    start = day(data["start_date"])
    last = (
        min(day(data["end_date"]), horizon_date)
        if data.get("end_date")
        else horizon_date
    )
    frequency = data.get("frequency", "monthly")
    amount = dec(data["amount"], nonnegative=True)
    interval = _integer(data.get("interval", 1), "间隔", 365)
    count = _integer(data.get("count", 10000), "期数")
    from .subscription_calendar import subscription_rule, subscription_day

    rule = (
        subscription_rule(get_obj(Instrument, space, data["instrument_id"]))
        if data.get("kind") == "dca" and data.get("instrument_id")
        else None
    )
    rows = []
    for index in range(count):
        try:
            due = (
                add_months(start, index * interval, data.get("day_policy", "clamp"))
                if frequency == "monthly"
                else start
                + timedelta(days=index * interval * (7 if frequency == "weekly" else 1))
            )
        except (ValueError, OverflowError) as error:
            raise DomainError(str(error))
        if due > last:
            break
        row = {"sequence": index + 1, "due_date": due, "amount": amount}
        if rule:
            row["subscription_day"] = subscription_day(due, rule=rule)
            row["auto_skip"] = row["subscription_day"]["is_open"] is False
        rows.append(row)
    else:
        if "count" not in data and rows and rows[-1]["due_date"] < last:
            raise DomainError("计划跨度超过单次 10000 期，请缩小日期范围")
    return rows


def _reconcile(space, data):
    account = get_obj(Account, space, data.get("account_id"))
    _currency(space, data, account)
    as_of = day(data.get("as_of"))
    data["as_of"] = str(as_of)
    scope = data.get("kind", data.get("scope", "balance"))
    observed = dec(
        data.get("institution_value", data.get("amount")),
        nonnegative=scope in {"position", "loan", "liability"},
        places=18 if scope == "position" else 12,
    )
    data["institution_value"] = str(observed)
    system = None
    if scope in {"balance", "cash"}:
        system = balance(space, account, "cash", as_of)
    elif scope in {"liability", "loan"}:
        if account.kind not in LIABILITIES:
            raise DomainError("本金核对须选择负债账户")
        system = -balance(space, account, "liability", as_of)
    elif scope == "position":
        instrument = get_obj(Instrument, space, data.get("instrument_id"))
        system = position(space, account, instrument, as_of)[0]
    elif scope == "equity":
        from .account_opening import effective_snapshots

        snapshot = (
            effective_snapshots(space, account)
            .filter(
                economic_date=as_of,
                complete=True,
                includes_options__isnull=False,
            )
            .order_by("-created_at")
            .first()
        )
        if snapshot:
            system = snapshot.equity
        else:
            data["missing_reason"] = "该时点没有覆盖范围已核实的完整机构权益快照"
    else:
        raise DomainError("不支持的核对口径")
    difference = None if system is None else observed - system
    data.update(
        system_value=serial(system),
        difference=serial(difference),
        status="matched" if difference == ZERO else "in_progress",
        ledger_revision=space.revision,
    )


@transaction.atomic
def save_resource(space, user, kind, data, obj=None):
    if kind not in KINDS or not isinstance(data, dict):
        raise DomainError("不支持的资源或数据格式")
    Workspace.objects.select_for_update().get(pk=space.pk)
    if obj:
        obj = get_obj(Resource, space, obj.pk, kind=kind)
    incoming = {
        key: value
        for key, value in data.items()
        if key
        not in {
            "id",
            "version",
            "tenant_id",
            "created_by_id",
            "created_at",
            "published_at",
        }
        and not key.startswith("_")
    }
    clean = _normalize(space, {**(obj.data if obj else {}), **incoming})
    clean.setdefault(
        "status", "draft" if kind in {"goals", "scenarios", "notes"} else "active"
    )
    allowed_statuses = (
        {"draft", "published", "archived"}
        if kind == "notes"
        else {"active", "released", "consumed"}
        if kind == "reservations"
        else {"draft", "active", "paused", "completed", "archived"}
        if kind in {"plans", "loans", "goals", "scenarios"}
        else None
    )
    if allowed_statuses and clean["status"] not in allowed_statuses:
        raise DomainError("不支持的资源状态")
    account = (
        get_obj(Account, space, clean["account_id"])
        if clean.get("account_id")
        else None
    )
    if kind in {"plans", "loans", "reservations", "budgets"} and not account:
        raise DomainError("请选择账户")
    if kind in {"plans", "loans", "reservations", "goals", "scenarios", "budgets"}:
        _currency(space, clean, account)
    if kind in {"plans", "loans", "reservations"} and account.kind in LIABILITIES:
        raise DomainError("计划收付或预留须选择现金资产账户")
    if account and account.archived:
        raise DomainError("账户已归档")
    if kind == "plans":
        if dec(clean.get("amount"), nonnegative=True) <= ZERO or not clean.get(
            "start_date"
        ):
            raise DomainError("请填写正数计划金额和首期日期")
        if clean.get("frequency", "monthly") not in {"daily", "weekly", "monthly"}:
            raise DomainError("支持每日、每周、每月计划")
        if clean.get("kind", "expense") not in {"expense", "income", "dca"}:
            raise DomainError("计划类别须为收入、支出或定投")
        if clean.get("end_date") and day(clean["end_date"]) < day(clean["start_date"]):
            raise DomainError("结束日期不能早于首期日期")
        if clean.get("kind") == "dca" and not clean.get("instrument_id"):
            raise DomainError("定投计划须关联具体产品身份")
        from .dca_automation import validate_configuration

        validate_configuration(space, clean)
    if kind == "loans":
        liability = get_obj(Account, space, clean.get("liability_account_id"))
        if liability.kind not in LIABILITIES or liability.currency != clean["currency"]:
            raise DomainError("请选择相同币种的负债账户")
        clean["term_months"] = _integer(
            clean.get("term_months", clean.get("periods")), "贷款期数", 1200
        )
        _loan_rows(clean)
        if obj:
            paid = (
                obj.occurrences.filter(tenant=space, event__isnull=False)
                .order_by("-sequence")
                .first()
            )
            financial = {
                "principal",
                "annual_rate",
                "term_months",
                "method",
                "first_due_date",
                "custom_rows",
                "day_policy",
            }
            if paid and any(clean.get(key) != obj.data.get(key) for key in financial):
                if day(clean["first_due_date"]) <= paid.due_date:
                    raise DomainError(
                        "变更未来还款请填下次还款日期与接续剩余本金，已发生期保持不变"
                    )
                clean["_sequence_offset"] = paid.sequence
    if kind in {"goals", "scenarios"}:
        if kind == "scenarios" and not clean.get("goal_id"):
            raise DomainError("比较方案须关联目标")
        if clean.get("amount") is not None:
            dec(clean["amount"], nonnegative=True)
        if clean.get("payment_nodes") is not None:
            if not isinstance(clean["payment_nodes"], list):
                raise DomainError("付款节点须为列表")
            seen = set()
            allocated_events = {}
            for index, node in enumerate(clean["payment_nodes"]):
                if not isinstance(node, dict) or not (
                    node.get("date") or node.get("due_date")
                ):
                    raise DomainError("每个付款节点须包含日期与金额")
                dec(node.get("amount"), nonnegative=True)
                if node.get("status") in {"paid", "completed"} and not (
                    node.get("event_id") or node.get("payment_event_id")
                ):
                    raise DomainError(
                        "付款节点完成须关联真实事项；预计到期不能冒充已支付"
                    )
                event_id = node.get("event_id") or node.get("payment_event_id")
                if (
                    node.get("event_id")
                    and node.get("payment_event_id")
                    and node["event_id"] != node["payment_event_id"]
                ):
                    raise DomainError("同一付款节点不能关联两笔不同事项")
                if event_id:
                    event = get_obj(Event, space, event_id)
                    currency = node.get("currency", clean["currency"])
                    if (
                        event.reverses_id
                        or hasattr(event, "reversal")
                        or event.kind
                        not in {
                            "expense",
                            "property_purchase",
                            "repayment",
                            "settlement",
                            "fund_debit",
                        }
                    ):
                        raise DomainError(
                            "付款节点须关联未冲正的实际现金付款，不能关联收入或内部划转"
                        )
                    paid = -sum(
                        (
                            line.amount
                            for line in event.lines.filter(
                                code="cash", currency=currency
                            )
                            if line.amount < ZERO
                        ),
                        ZERO,
                    )
                    allocated_events[event_id] = allocated_events.get(
                        event_id, ZERO
                    ) + dec(node["amount"])
                    if paid <= ZERO or allocated_events[event_id] > paid:
                        raise DomainError(
                            "节点分配金额超过该真实事项已付现金，或币种不一致"
                        )
                if node.get("reservation_id"):
                    reserve = get_obj(
                        Resource, space, node["reservation_id"], kind="reservations"
                    )
                    expected_goal = (
                        clean.get("goal_id")
                        if kind == "scenarios"
                        else (str(obj.pk) if obj else None)
                    )
                    if (
                        reserve.data.get("goal_id")
                        and reserve.data["goal_id"] != expected_goal
                    ):
                        raise DomainError("付款节点不能使用其他目标的资金预留")
                    if reserve.data.get("currency") != node.get(
                        "currency", clean["currency"]
                    ):
                        raise DomainError("付款节点与预留币种不一致")
                node.setdefault("id", str(index + 1))
                if str(node["id"]) in seen:
                    raise DomainError("付款节点编号重复")
                seen.add(str(node["id"]))
    if kind == "reservations":
        amount = dec(clean.get("amount"), nonnegative=True)
        linked = dec(clean.get("linked_freeze_amount", "0"), nonnegative=True)
        clean["linked_freeze_amount"] = str(linked)
        if linked > amount:
            raise DomainError("关联冻结金额不能超过该笔预留")
        if clean.get("scenario_id"):
            scenario = get_obj(Resource, space, clean["scenario_id"], kind="scenarios")
            if clean.get("goal_id") and clean["goal_id"] != scenario.data.get(
                "goal_id"
            ):
                raise DomainError("预留方案与目标不一致")
            clean["goal_id"] = scenario.data["goal_id"]
        _check_reservations(space, account, obj, clean)
    if kind == "notes":
        if (
            not str(clean.get("title", "")).strip()
            or not str(clean.get("body", "")).strip()
        ):
            raise DomainError("笔记须填写标题与正文")
        if len(str(clean["body"])) > 200000:
            raise DomainError("笔记正文过长")
        tags = clean.get("tags", [])
        if isinstance(tags, str):
            tags = tags.replace("，", ",").split(",")
        if not isinstance(tags, list) or len(tags) > 30:
            raise DomainError("笔记标签须为不超过 30 项的列表")
        clean["tags"] = list(
            dict.fromkeys(str(tag).strip()[:40] for tag in tags if str(tag).strip())
        )
        if clean.get("status") == "published":
            clean["published_at"] = (
                obj.data.get("published_at") if obj else None
            ) or timezone.now().isoformat()
    if kind == "watchlist" and not clean.get("instrument_id"):
        raise DomainError("自选须关联具体资产")
    if kind == "reconciliations":
        _reconcile(space, clean)
    if obj:
        _remember(obj, user)
        obj.data = serial(clean)
        obj.version += 1
        obj.save(update_fields=["data", "version"])
    else:
        obj = Resource.objects.create(
            tenant=space, created_by=user, kind=kind, data=serial(clean)
        )
    _remember(obj, user)
    changed_accounts = set()
    if kind == "scenarios" and clean["status"] == "active":
        for other in Resource.objects.filter(tenant=space, kind="scenarios").exclude(
            pk=obj.pk
        ):
            if (
                other.data.get("goal_id") == clean["goal_id"]
                and other.data.get("status") == "active"
            ):
                _remember(other, user)
                other.data["status"] = "draft"
                other.version += 1
                other.save(update_fields=["data", "version"])
                _remember(other, user)
        changed_accounts = {
            row.data.get("account_id")
            for row in Resource.objects.filter(tenant=space, kind="reservations")
            if row.data.get("scenario_id") == str(obj.pk)
        }
    if kind in {"goals", "scenarios", "reservations"}:
        from .reservations import sync_reservation_payments

        sync_reservation_payments(space, user)
        obj.refresh_from_db()
    for account_id in changed_accounts:
        _check_reservations(space, get_obj(Account, space, account_id))
    audit(space, user, f"{kind}.saved", obj, {"version": obj.version})
    from .common import bump

    bump(space, user, invalidate_reconciliations=False)
    if kind == "plans" and clean["status"] == "active":
        generate_schedule(space, user, obj)
    return obj


@transaction.atomic
def generate_schedule(space, user, resource, horizon_date=None):
    Workspace.objects.select_for_update().get(pk=space.pk)
    resource = get_obj(Resource, space, resource.pk, kind__in={"plans", "loans"})
    if resource.data.get("status", "active") != "active":
        return list(resource.occurrences.filter(tenant=space).order_by("sequence"))
    horizon = (
        day(horizon_date)
        if horizon_date
        else (
            day("9999-12-31")
            if resource.kind == "loans"
            else today(space) + timedelta(days=365)
        )
    )
    rows = _schedule_rows(space, resource, horizon)
    current = {row.sequence: row for row in resource.occurrences.filter(tenant=space)}
    included = set()
    changed = 0
    for row in rows:
        sequence, due = row["sequence"], row["due_date"]
        included.add(sequence)
        old = current.get(sequence)
        if old and (
            old.event_id
            or (old.status == "skipped" and not old.details.get("auto_skip"))
            or old.due_date < today(space)
            or old.details.get("permanently_removed") is True
        ):
            continue
        details = serial(
            {
                **row,
                "account_id": resource.data["account_id"],
                "liability_account_id": resource.data.get("liability_account_id"),
                "instrument_id": resource.data.get("instrument_id"),
                "plan_kind": resource.data.get(
                    "kind", "loan" if resource.kind == "loans" else "expense"
                ),
                "plan_version": resource.version,
            }
        )
        values = {
            "due_date": due,
            "amount": row["amount"],
            "currency": resource.data["currency"],
            "details": details,
            "status": "skipped"
            if row.get("auto_skip")
            else "pending"
            if due <= today(space)
            else "scheduled",
        }
        if old:
            if any(getattr(old, key) != value for key, value in values.items()):
                for key, value in values.items():
                    setattr(old, key, value)
                old.version += 1
                old.save()
                changed += 1
        else:
            Occurrence.objects.create(
                tenant=space,
                created_by=user,
                plan=resource,
                sequence=sequence,
                **values,
            )
            changed += 1
    for sequence, old in current.items():
        if (
            sequence not in included
            and old.due_date <= horizon
            and old.due_date >= today(space)
            and not old.event_id
            and old.status != "cancelled"
        ):
            old.status = "cancelled"
            old.version += 1
            old.save(update_fields=["status", "version"])
            changed += 1
    if changed:
        from .common import bump

        bump(space, user, invalidate_reconciliations=False)
        audit(
            space,
            user,
            "schedule.generated",
            resource,
            {
                "horizon": str(horizon),
                "plan_version": resource.version,
                "changed": changed,
            },
        )
    return list(resource.occurrences.filter(tenant=space).order_by("sequence"))


@transaction.atomic
def confirm_occurrence(space, user, occ, event_id):
    Workspace.objects.select_for_update().get(pk=space.pk)
    occ = get_obj(Occurrence, space, occ.pk)
    event = get_obj(Event, space, event_id)
    if occ.event_id:
        if occ.event_id == event.pk:
            return occ
        raise DomainError("该期已有实际事项", "conflict", 409)
    if (
        (
            occ.status == "cancelled"
            or (occ.status == "skipped" and not occ.details.get("auto_skip"))
        )
        or event.reverses_id
        or hasattr(event, "reversal")
    ):
        raise DomainError("已取消期次或已冲正事项不能确认")
    if Occurrence.objects.filter(tenant=space, event=event).exclude(pk=occ.pk).exists():
        raise DomainError("实际事项已关联其他期次", "conflict", 409)
    account_id = occ.details.get("account_id") or occ.plan.data.get("account_id")
    account = get_obj(Account, space, account_id)
    if (
        event.payload.get("account_id") != str(account.pk)
        or event.payload.get("currency") != occ.currency
    ):
        raise DomainError("实际事项账户或币种与该期计划不一致")
    plan_kind = occ.details.get("plan_kind", occ.plan.data.get("kind", "expense"))
    allowed = (
        {"income"}
        if plan_kind == "income"
        else ({"fund_debit", "buy"} if plan_kind == "dca" else {"expense"})
    )
    if occ.plan.kind == "loans":
        allowed = {"repayment"}
        expected = occ.details.get("liability_account_id") or occ.plan.data.get(
            "liability_account_id"
        )
        if event.payload.get("target_account_id") != expected:
            raise DomainError("实际还款对应的负债账户与计划不一致")
    if event.kind not in allowed or dec(event.payload.get("amount")) != occ.amount:
        raise DomainError("实际事项类型或金额与计划不一致，请先处理差异")
    if (
        plan_kind == "dca"
        and event.payload.get("instrument_id")
        and event.payload["instrument_id"] != occ.details.get("instrument_id")
    ):
        raise DomainError("实际投资产品与定投计划不一致")
    occ.event = event
    occ.status = "confirmed"
    occ.version += 1
    occ.save(update_fields=["event", "status", "version"])
    if occ.plan.data.get("reservation_id"):
        from .reservations import sync_reservation_payments

        sync_reservation_payments(space, user)
    from .common import bump

    bump(space, user, invalidate_reconciliations=False)
    audit(space, user, "occurrence.confirmed", occ, {"event_id": str(event.pk)})
    return occ


def forecast(space, body):
    if not isinstance(body, dict):
        raise DomainError("预测参数须为对象")
    days = _integer(body.get("days", 90), "预测天数", 365)
    if days not in {30, 90, 365}:
        raise DomainError("预测区间支持 30、90、365 天")
    start = today(space)
    end = start + timedelta(days=days)
    base = space.base_currency
    gaps, rows, opening, holds = [], [], ZERO, ZERO
    selected = (
        get_obj(Resource, space, body["scenario_id"], kind="scenarios")
        if body.get("scenario_id")
        else None
    )
    rate_cache = {base: Decimal(1)}

    def convert(amount, currency, label):
        if currency not in rate_cache:
            direct = (
                FxRate.objects.filter(
                    tenant=space,
                    base=currency,
                    quote=base,
                    purpose="valuation",
                    economic_date__lte=start,
                )
                .order_by("-economic_date", "-created_at")
                .first()
            )
            inverse = (
                None
                if direct
                else FxRate.objects.filter(
                    tenant=space,
                    base=base,
                    quote=currency,
                    purpose="valuation",
                    economic_date__lte=start,
                )
                .order_by("-economic_date", "-created_at")
                .first()
            )
            rate_cache[currency] = (
                direct.rate
                if direct and direct.rate > ZERO
                else (
                    Decimal(1) / inverse.rate
                    if inverse and inverse.rate > ZERO
                    else None
                )
            )
        rate = rate_cache[currency]
        if rate is None:
            gaps.append(f"{label}缺少 {currency}/{base} 汇率，未纳入合计")
            return None
        return dec(amount) * rate

    reservations = {}
    accounts = list(
        catalog_queryset(Account, space)
        .filter(tenant=space, archived=False)
        .exclude(kind__in=LIABILITIES)
    )
    for account in accounts:
        if account.valuation_mode == "snapshot":
            gaps.append(f"{account.name}采用机构权益口径，可动用现金尚未独立核实")
            continue
        value = convert(
            balance(space, account, "cash", start), account.currency, account.name
        )
        if value is None:
            continue
        opening += value
        holds += convert(account.frozen, account.currency, account.name) or ZERO
        for resource in Resource.objects.filter(tenant=space, kind="reservations"):
            if resource.data.get("account_id") != str(
                account.pk
            ) or not _active_reservation(space, resource.data, selected):
                continue
            amount = dec(resource.data["amount"])
            overlap = dec(resource.data.get("linked_freeze_amount", "0"))
            holds += convert(amount - overlap, account.currency, "资金预留") or ZERO
            reservations[str(resource.pk)] = {
                "amount": amount,
                "currency": account.currency,
            }

    def append(identifier, when, amount, currency, label, reservation_id=None):
        when = day(when)
        if when > end:
            return
        if when < start:
            gaps.append(f"{label}已经到期但未有实账关联，按待支付纳入起始日")
            when = start
        value = convert(amount, currency, label)
        if value is None:
            return
        if len(rows) >= 20000:
            raise DomainError("预测项目超过交互式计算上限，请缩小范围或合并重复计划")
        release = ZERO
        if reservation_id and value < ZERO and reservation_id in reservations:
            reserve = reservations[reservation_id]
            if reserve["currency"] != currency:
                raise DomainError("付款节点与预留币种不符")
            used = min(-dec(amount), reserve["amount"])
            reserve["amount"] -= used
            release = convert(used, currency, label) or ZERO
        rows.append(
            {
                "id": identifier,
                "date": when,
                "amount": value,
                "label": label,
                "release": release,
            }
        )

    for resource in Resource.objects.filter(tenant=space, kind__in={"plans", "loans"}):
        if resource.data.get("status", "active") != "active":
            continue
        existing = {
            row.sequence: row for row in resource.occurrences.filter(tenant=space)
        }
        for planned in _schedule_rows(space, resource, end):
            if planned.get("auto_skip"):
                continue
            occurrence = existing.get(planned["sequence"])
            if occurrence and (
                occurrence.event_id or occurrence.status in {"cancelled", "skipped"}
            ):
                continue
            when = occurrence.due_date if occurrence else planned["due_date"]
            amount = occurrence.amount if occurrence else planned["amount"]
            currency = occurrence.currency if occurrence else resource.data["currency"]
            sign = (
                1
                if resource.kind == "plans" and resource.data.get("kind") == "income"
                else -1
            )
            append(
                f"plan:{resource.pk}:{planned['sequence']}",
                when,
                sign * amount,
                currency,
                resource.data.get("name", "计划期次"),
                resource.data.get("reservation_id"),
            )
    for goal in Resource.objects.filter(tenant=space, kind="goals"):
        if goal.data.get("status") != "active" and not (
            selected and selected.data.get("goal_id") == str(goal.pk)
        ):
            continue
        scenario = (
            selected
            if selected and selected.data.get("goal_id") == str(goal.pk)
            else next(
                (
                    item
                    for item in Resource.objects.filter(tenant=space, kind="scenarios")
                    if item.data.get("goal_id") == str(goal.pk)
                    and item.data.get("status") == "active"
                ),
                None,
            )
        )
        data = scenario.data if scenario else goal.data
        nodes = data.get("payment_nodes") or (
            [
                {
                    "id": "total",
                    "date": data.get("target_date"),
                    "amount": data.get("amount"),
                }
            ]
            if data.get("target_date") and data.get("amount") is not None
            else []
        )
        for node in nodes:
            if (
                node.get("event_id")
                or node.get("payment_event_id")
                or node.get("status") in {"paid", "completed"}
            ):
                continue
            append(
                f"goal:{(scenario or goal).pk}:{node['id']}",
                node.get("date") or node.get("due_date"),
                -dec(node["amount"]),
                node.get("currency", data.get("currency", base)),
                data.get("name", goal.data.get("name", "目标付款")),
                node.get("reservation_id"),
            )
    income = dec(body.get("monthly_income", "0"), nonnegative=True)
    expense = dec(body.get("monthly_expense", "0"), nonnegative=True)
    for index in range(1, 13):
        when = add_months(start, index)
        if when > end:
            break
        if income:
            append(f"assumption:income:{index}", when, income, base, "额外月收入假设")
        if expense:
            append(
                f"assumption:expense:{index}", when, -expense, base, "额外月支出假设"
            )
    values, current_cash, current_holds = [], opening, holds
    minimum, first_deficit = opening - holds, start if opening - holds < ZERO else None
    for when in [start + timedelta(days=index) for index in range(days + 1)]:
        daily = [row for row in rows if row["date"] == when]
        inflow = sum((row["amount"] for row in daily if row["amount"] > ZERO), ZERO)
        outflow = -sum((row["amount"] for row in daily if row["amount"] < ZERO), ZERO)
        current_cash += inflow - outflow
        current_holds -= sum((row["release"] for row in daily), ZERO)
        available = current_cash - current_holds
        minimum = min(minimum, available)
        if available < ZERO and first_deficit is None:
            first_deficit = when
        values.append(
            {
                "date": when,
                "inflow": inflow,
                "outflow": outflow,
                "balance": available,
                "settled_cash": current_cash,
                "holds": current_holds,
                "items": [
                    {"id": row["id"], "label": row["label"], "amount": row["amount"]}
                    for row in daily
                ],
            }
        )
    return serial(
        {
            "currency": base,
            "start_date": start,
            "end_date": end,
            "is_forecast": True,
            "scenario_id": selected.pk if selected else None,
            "opening_cash": opening,
            "opening_available": opening - holds,
            "minimum_balance": minimum,
            "closing_balance": current_cash - current_holds,
            "first_deficit_date": first_deficit,
            "completeness": "partial" if gaps else "complete",
            "gaps": list(dict.fromkeys(gaps)),
            "items": values,
            "intraday_order": "unknown",
            "assumptions": [
                "额外月收支从一个月后开始，未包含在已有计划中",
                "使用当前已知汇率，未来汇率不作收益承诺",
            ],
            "policy_version": "cashflow-plans-v1",
        }
    )
