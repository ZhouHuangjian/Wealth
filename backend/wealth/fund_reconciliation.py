"""Institutional fund statement evidence on the existing immutable event ledger.

A file proves only the facts its row actually supplies. A matching price feed is
not trade evidence. Missing fields never become zero, and date/amount similarity
alone never authorizes an automatic match or a duplicate payment.
"""

from decimal import Decimal

from django.db import transaction

from .common import (
    DomainError,
    audit,
    bump,
    day,
    dec,
    digest,
    get_obj,
    money_round,
    record,
)
from .models import (
    Account,
    Event,
    EvidenceLink,
    Instrument,
    Occurrence,
    PositionMovement,
    Resource,
    SourceFact,
    Workspace,
)
from .planning import _remember, today

PARSER = "fund-confirmation-1"
SETTINGS = "fund_statement_mappings"
REPLACEMENTS = "fund_statement_corrections"
ALIASES = {
    "code": ["基金代码", "产品代码", "code"],
    "application_date": ["申请日期", "申请时间", "application_date"],
    "payment_date": ["扣款日期", "交易日期", "payment_date", "date"],
    "confirmation_date": ["确认日期", "份额确认日期", "confirmation_date"],
    "amount": ["实际金额", "申购金额", "扣款金额", "交易金额", "金额", "amount"],
    "quantity": ["确认份额", "实际份额", "份额", "quantity"],
    "nav": ["确认净值", "成交净值", "单位净值", "nav"],
    "fee": ["实际费用", "申购费", "手续费", "费用", "fee"],
    "external_id": ["订单号", "申请编号", "交易流水号", "external_id"],
    "source_row_id": ["来源行号", "记录编号", "source_row_id"],
    "currency": ["币种", "currency"],
}
LABELS = {key: names[0] for key, names in ALIASES.items()}
CONFIRM_FIELDS = ("amount", "quantity", "nav", "fee", "confirmation_date")


def settings(space, account_id=None, source="standard_fund"):
    if account_id:
        get_obj(Account, space, account_id)
    row = Resource.objects.filter(
        tenant=space,
        kind=SETTINGS,
        data__account_id=str(account_id or ""),
        data__source=source,
    ).first()
    return {
        "fields": [
            {"key": key, "label": LABELS[key], "aliases": aliases}
            for key, aliases in ALIASES.items()
        ],
        "mapping": row.data.get("mapping", {}) if row else {},
        "format": "standard_fund",
        "native_institution_adapter": False,
    }


def _fingerprint(n):
    # Physical row numbers are identity locators, not institutional facts.
    return digest({k: v for k, v in n.items() if k != "source_row_id"})


def _date(value):
    if not value:
        return None
    return str(day(str(value).strip().replace("/", "-")[:10]))


def _normalise(space, batch, raw, mapping, account, instrument, funding):
    data = {key: str(raw.get(mapping.get(key), "") or "").strip() for key in ALIASES}
    code = data["code"]
    if code.endswith(".0") and code[:-2].isdigit():
        code = code[:-2]
    if code.isdigit():
        code = code.zfill(6)
    if instrument:
        if code and code != instrument.code:
            raise DomainError("文件基金代码与所选产品不符")
    else:
        matches = list(
            Instrument.objects.filter(tenant=space, kind="fund", code=code)[:2]
        )
        if len(matches) != 1:
            raise DomainError("基金代码未唯一匹配，请先录入产品或选择本文件的基金")
        instrument = get_obj(Instrument, space, matches[0].pk)
    if (
        instrument.kind != "fund"
        or instrument.specification.get("trading_channel") == "exchange"
    ):
        raise DomainError("此入口核对场外基金申购确认记录")
    from .investments import validate_investment_account

    validate_investment_account(account, instrument)
    currency = data["currency"] or instrument.currency
    if currency != instrument.currency or currency != account.currency:
        raise DomainError("基金、持仓账户与账单币种不一致")
    n = {
        "instrument_id": str(instrument.pk),
        "code": instrument.code,
        "account_id": str(account.pk),
        "funding_account_id": str(funding.pk) if funding else None,
        "currency": currency,
        "external_id": data["external_id"] or None,
        "source_row_id": data["source_row_id"] or None,
    }
    for key in ("application_date", "payment_date", "confirmation_date"):
        n[key] = _date(data[key])
        if n[key] and day(n[key]) > today(space):
            raise DomainError(f"{LABELS[key]}尚未到达，不能作为已发生的实际事实")
    if not (n["application_date"] or n["payment_date"]):
        raise DomainError("至少提供申请日期或扣款日期")
    for key in ("amount", "quantity", "nav", "fee"):
        value = (
            dec(
                data[key],
                nonnegative=True,
                places=18 if key in ("quantity", "nav") else 12,
            )
            if data[key]
            else None
        )
        if key != "fee" and value is not None and value <= 0:
            raise DomainError(f"{LABELS[key]}须大于零")
        n[key] = format(value.normalize(), "f") if value is not None else None
    if n["amount"] is None:
        raise DomainError("请提供实际申购金额；未知份额、净值和费用可留空")
    if n["confirmation_date"] and day(n["confirmation_date"]) < day(
        n["application_date"] or n["payment_date"]
    ):
        raise DomainError("份额确认日不能早于申请日")
    if n["fee"] is not None and dec(n["fee"]) >= dec(n["amount"]):
        raise DomainError("费用不能达到申购金额")
    if all(n.get(k) is not None for k in CONFIRM_FIELDS):
        gross, nav = dec(n["amount"]), dec(n["nav"], places=18)
        difference = gross - money_round(
            dec(n["quantity"], places=18) * nav + dec(n["fee"])
        )
        if abs(difference) > min(
            Decimal(1), nav * Decimal(".01") + Decimal(".01"), gross * Decimal(".01")
        ):
            raise DomainError("金额与份额×净值＋费用差异超过合理尾差，请核对账单字段")
    return n


@transaction.atomic
def preview(space, user, batch, body):
    if body.get("refresh_only") is True:
        if (
            set(body) != {"refresh_only"}
            or batch.parser_version != PARSER
            or batch.status == "reversed"
        ):
            raise DomainError("当前批次不能仅刷新核对")
        batch.version += 1
        batch.ledger_revision = space.revision
        batch.save(update_fields=["version", "ledger_revision"])
        return batch_preview(space, batch)
    if batch.status in {"committed", "partially_committed", "reversed"}:
        raise DomainError("已处理批次不能重新映射，请查看原预览", "conflict", 409)
    account = get_obj(Account, space, body.get("account_id") or batch.account_id)
    if account.valuation_mode != "detailed":
        raise DomainError("基金核对需要交易明细账户")
    instrument = (
        get_obj(Instrument, space, body["instrument_id"])
        if body.get("instrument_id")
        else None
    )
    funding = (
        get_obj(Account, space, body["funding_account_id"])
        if body.get("funding_account_id")
        else None
    )
    headers = batch.diagnostics.get("headers", [])
    mapping = body.get("mapping")
    if mapping is None:
        mapping = settings(space, account.pk, batch.source)["mapping"] or {
            key: next((a for a in aliases if a in headers), "")
            for key, aliases in ALIASES.items()
        }
    if (
        not isinstance(mapping, dict)
        or set(mapping) - set(ALIASES)
        or any(v and v not in headers for v in mapping.values())
    ):
        raise DomainError("字段映射必须指向文件中已有的列")
    batch.account, batch.mapping, batch.parser_version = account, mapping, PARSER
    batch.diagnostics = {
        **batch.diagnostics,
        "fund_context": {
            "account_id": str(account.pk),
            "instrument_id": str(instrument.pk) if instrument else None,
            "funding_account_id": str(funding.pk) if funding else None,
        },
    }
    rows = list(batch.rows.order_by("row_number"))
    identities = set()
    for row in rows:
        row.errors, row.normalized, row.identity = [], {}, ""
        try:
            row.normalized = _normalise(
                space, batch, row.raw, mapping, account, instrument, funding
            )
            n = row.normalized
            locator = (
                ["order", n["external_id"]]
                if n["external_id"]
                else ["file", batch.digest, n["source_row_id"] or row.row_number]
            )
            row.identity = digest(
                [
                    "fund_statement",
                    str(space.pk),
                    batch.source,
                    str(account.pk),
                    n["instrument_id"],
                    locator,
                ]
            )
            if row.identity in identities:
                raise DomainError("同一文件中来源订单号或来源行号重复，请核对分笔记录")
            identities.add(row.identity)
        except DomainError as exc:
            row.errors = [exc.message]
        row.save(update_fields=["normalized", "errors", "identity"])
    if body.get("save_mapping") is True:
        pref = Resource.objects.filter(
            tenant=space,
            kind=SETTINGS,
            data__account_id=str(account.pk),
            data__source=batch.source,
        ).first()
        data = {
            "account_id": str(account.pk),
            "source": batch.source,
            "mapping": mapping,
        }
        if pref:
            if pref.data != data:
                _remember(pref, user)
                pref.data, pref.version = data, pref.version + 1
                pref.save(update_fields=["data", "version"])
        else:
            Resource.objects.create(
                tenant=space, created_by=user, kind=SETTINGS, data=data
            )
    batch.version += 1
    batch.ledger_revision = space.revision
    batch.preview_hash = digest(
        [(str(r.pk), r.normalized, r.errors, r.identity) for r in rows]
    )
    batch.status = "needs_review" if any(r.errors for r in rows) else "ready"
    batch.save()
    audit(
        space,
        user,
        "import.fund_previewed",
        batch,
        {"rows": len(rows), "mapping": mapping},
    )
    return batch_preview(space, batch)


def resolved_event(space, event):
    """Follow only explicit reconciler-created replacements, never any reversal."""
    seen = set()
    while event and hasattr(event, "reversal") and str(event.pk) not in seen:
        seen.add(str(event.pk))
        replacement = (
            Resource.objects.filter(
                tenant=space, kind=REPLACEMENTS, data__old_event_id=str(event.pk)
            )
            .order_by("-created_at")
            .first()
        )
        if not replacement:
            break
        event = (
            Event.objects.filter(
                tenant=space, pk=replacement.data.get("new_event_id")
            ).first()
            or event
        )
    return event


def event_evidence(space, event):
    """Trade evidence is independent of official/estimated market-price quality."""
    links = (
        list(
            EvidenceLink.objects.filter(
                tenant=space,
                event=event,
                active=True,
                record__batch__parser_version=PARSER,
            ).select_related("record__batch")
        )
        if event.kind in {"fund_debit", "fund_confirm"}
        else []
    )
    valid = []
    for link in links:
        n = link.record.normalized
        # A debit-only record never proves inferred shares or a price.
        if event.kind == "fund_confirm" and not all(
            n.get(k) is not None for k in CONFIRM_FIELDS
        ):
            continue
        valid.append(link)
    if valid and not hasattr(event, "reversal"):
        return {
            "basis": "actual",
            "status": "institution_confirmed",
            "record_ids": [str(l.record_id) for l in valid],
            "source": "institution_statement",
            "sources": [l.record.batch.filename for l in valid],
            "external_ids": [
                l.record.normalized["external_id"]
                for l in valid
                if l.record.normalized.get("external_id")
            ],
            "facts": ["payment", "quantity", "nav", "fee"]
            if event.kind == "fund_confirm"
            else ["payment"],
            "market_nav_verified": False,
        }
    return {
        "basis": "estimated" if event.payload.get("automatic_estimate") else "manual",
        "status": "estimated" if event.payload.get("automatic_estimate") else "manual",
        "record_ids": [],
        "source": event.payload.get("entry_basis") or "manual",
        "facts": [],
    }


def _difference(n, debit, confirmation):
    fields = [("amount", debit.payload.get("amount"))]
    # Payment day is an actual debit fact; application day is not assumed to equal it.
    if n.get("payment_date"):
        fields.append(("payment_date", str(debit.economic_date)))
    if confirmation:
        fields += [
            ("confirmation_date", str(confirmation.economic_date)),
            ("quantity", confirmation.payload.get("quantity")),
            ("nav", confirmation.payload.get("price")),
            ("fee", confirmation.payload.get("fee", "0")),
        ]
    elif any(n.get(k) is not None for k in ("quantity", "nav", "confirmation_date")):
        fields += [(k, None) for k in ("confirmation_date", "quantity", "nav", "fee")]
    differences = []
    for field, value in fields:
        actual = n.get(field)
        if actual is None:
            continue
        equals = value is not None and (
            dec(actual, places=18) == dec(value, places=18)
            if field in ("amount", "quantity", "nav", "fee")
            else actual == value
        )
        if not equals:
            differences.append(
                {
                    "field": field,
                    "label": LABELS[field],
                    "recorded": value,
                    "actual": actual,
                }
            )
    return differences


def _correction_block(space, debit, confirmation, n):
    if not all(n.get(k) is not None for k in CONFIRM_FIELDS):
        return (
            "更正确认记录需提供实际确认日、金额、份额、净值和费用，未知费用不按零处理"
        )
    changes_paid_fact = dec(debit.payload["amount"]) != dec(n["amount"]) or (
        n.get("payment_date") and n["payment_date"] != str(debit.economic_date)
    )
    if (confirmation or changes_paid_fact) and not (confirmation or debit).payload.get(
        "automatic_estimate"
    ):
        return "仅自动推算记录可在这里更正；实际记录请从交易记录处理"
    if confirmation and event_evidence(space, confirmation)["basis"] == "actual":
        return "该确认已有实际账单证据，需先撤销原核对再更正"
    if (
        debit.following.filter(reversal__isnull=True, reverses__isnull=True)
        .exclude(pk=confirmation.pk if confirmation else None)
        .exists()
    ):
        return "扣款还有其他后续阶段，请先处理依赖"
    if (
        confirmation
        and PositionMovement.objects.filter(
            tenant=space,
            account_id=n["account_id"],
            instrument_id=n["instrument_id"],
            event__created_at__gt=confirmation.created_at,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        ).exists()
    ):
        return "此笔之后已有持仓变动，请按逆序处理依赖后再更正"
    if (
        PositionMovement.objects.filter(
            tenant=space,
            account_id=n["account_id"],
            instrument_id=n["instrument_id"],
            event__economic_date__gt=day(n["confirmation_date"]),
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        )
        .exclude(event=confirmation)
        .exists()
    ):
        return "确认日期早于其他持仓记录，请先处理依赖"
    return None


def _candidates(space, n):
    dates = {d for d in (n.get("payment_date"), n.get("application_date")) if d}
    events = Event.objects.filter(
        tenant=space,
        kind="fund_debit",
        reverses__isnull=True,
        reversal__isnull=True,
        payload__instrument_id=n["instrument_id"],
        payload__currency=n["currency"],
    )
    if n.get("funding_account_id"):
        events = events.filter(payload__account_id=n["funding_account_id"])
    candidates = []
    for debit in events.filter(economic_date__in=dates).order_by("created_at"):
        confirms = list(
            debit.following.filter(
                kind="fund_confirm", reverses__isnull=True, reversal__isnull=True
            )
        )
        confirmation = confirms[0] if len(confirms) == 1 else None
        holding = (
            confirmation.payload.get("account_id") if confirmation else None
        ) or debit.payload.get("holding_account_id")
        if holding != n["account_id"]:
            continue
        differences = _difference(n, debit, confirmation)
        complete = all(n.get(k) is not None for k in CONFIRM_FIELDS)
        blocked = (
            "存在分笔确认，请从交易记录核对"
            if len(confirms) > 1
            else _correction_block(space, debit, confirmation, n)
        )
        candidates.append(
            {
                "debit_event_id": str(debit.pk),
                "confirmation_event_id": str(confirmation.pk) if confirmation else None,
                "exact": bool(complete and confirmation and not differences),
                "link_allowed": bool(
                    not differences and (n.get("payment_date") or complete)
                ),
                "differences": differences,
                "correction_allowed": blocked is None,
                "blocked_reason": blocked,
                "debit_amount": debit.payload["amount"],
                "payment_date": str(debit.economic_date),
                "correction_impact": {
                    "cash_delta": str(dec(debit.payload["amount"]) - dec(n["amount"]))
                    if not debit.payload.get("untracked_funding")
                    else "0",
                    "old_amount": debit.payload["amount"],
                    "new_amount": n["amount"],
                    "holding_account_id": n["account_id"],
                    "funding_account_id": debit.payload.get("account_id"),
                    "requires_reversal": bool(confirmation),
                },
            }
        )
    return candidates


def _source_compatibility(space, row, fact):
    records = [
        link.record
        for link in EvidenceLink.objects.filter(
            tenant=space, record__identity=row.identity, active=True
        ).select_related("record")
    ]
    if not records:
        # Retraction removes corroboration, but it does not erase source identity.
        records = [
            link.record
            for link in EvidenceLink.objects.filter(
                tenant=space, record__identity=row.identity
            ).select_related("record")
        ]
    relevant = {
        "instrument_id",
        "account_id",
        "currency",
        "application_date",
        "payment_date",
        "confirmation_date",
        "amount",
        "quantity",
        "nav",
        "fee",
        "external_id",
    }
    for prior in records:
        for key in relevant:
            old, new = prior.normalized.get(key), row.normalized.get(key)
            if old is not None and new is not None and old != new:
                return False
    return bool(records) or fact.fingerprint == _fingerprint(row.normalized)


def _same_business(space, first, second):
    first, second = resolved_event(space, first), resolved_event(space, second)
    first_debit = first.related if first.kind == "fund_confirm" else first
    second_debit = second.related if second.kind == "fund_confirm" else second
    return first_debit.pk == second_debit.pk


def _row_preview(space, row):
    n = row.normalized
    base = {
        "id": str(row.pk),
        "row_number": row.row_number,
        "normalized": n,
        "errors": row.errors,
        "candidates": [],
        "suggested_action": None,
        "missing_fields": [key for key in CONFIRM_FIELDS if n.get(key) is None],
    }
    if row.errors or not n:
        return {**base, "status": "error"}
    if EvidenceLink.objects.filter(tenant=space, record=row, active=True).exists():
        return {**base, "status": "applied"}
    fact = SourceFact.objects.filter(tenant=space, identity=row.identity).first()
    if fact:
        event = resolved_event(space, fact.event)
        if not _source_compatibility(space, row, fact) or hasattr(event, "reversal"):
            return {
                **base,
                "status": "review",
                "errors": [
                    "同一来源订单已有不同事实或原记录已撤销，请核对来源版本，不能重复导入"
                ],
            }
        debit = event.related if event.kind == "fund_confirm" else event
        candidates = [
            c for c in _candidates(space, n) if c["debit_event_id"] == str(debit.pk)
        ]
        if not candidates:
            return {
                **base,
                "status": "review",
                "errors": ["来源订单关联已改变，请核对原记录"],
            }
        if candidates[0]["differences"]:
            return {
                **base,
                "status": "review",
                "candidates": candidates,
                "note": "同一来源订单新增实际事实，请核对与原推算的差异",
            }
        return {
            **base,
            "status": "duplicate",
            "source_event_id": str(event.pk),
            "candidates": candidates,
            "suggested_action": "link",
        }
    candidates = _candidates(space, n)
    for candidate in candidates:
        debit = get_obj(Event, space, candidate["debit_event_id"])
        if _occupied_by_other_order(space, row, debit):
            candidate["exact"] = False
            candidate["link_allowed"] = False
            candidate["blocked_reason"] = "该事项已关联另一来源订单号，不能合并"
            candidate["correction_allowed"] = False
        candidate["already_has_other_evidence"] = (
            EvidenceLink.objects.filter(
                tenant=space,
                event=debit,
                active=True,
                record__batch__parser_version=PARSER,
            )
            .exclude(record__identity=row.identity)
            .exists()
        )
    unique = (
        len(candidates) == 1
        and candidates[0]["exact"]
        and not candidates[0]["already_has_other_evidence"]
    )
    return {
        **base,
        "candidates": candidates,
        "status": "exact_match" if unique else "review" if candidates else "unmatched",
        "suggested_action": "link" if unique else None,
        "note": None
        if candidates
        else "未找到同一基金和账户的申购记录，请先在基金买入中录入已知交易再核对",
    }


def batch_preview(space, batch, offset=0, limit=500):
    if batch.parser_version != PARSER:
        return {
            "batch": record(batch),
            "headers": batch.diagnostics.get("headers", []),
            "mapping": batch.mapping,
            "context": batch.diagnostics.get(
                "fund_context",
                {"account_id": str(batch.account_id) if batch.account_id else None},
            ),
            "rows": [],
            "summary": {},
            "preview_version": batch.version,
            "ledger_revision": batch.ledger_revision,
            "preview_hash": batch.preview_hash,
        }
    # Summary covers the full batch; pagination never changes the apply set.
    rows = [_row_preview(space, row) for row in batch.rows.order_by("row_number")]
    claims = {}
    for row in rows:
        if row["status"] == "exact_match":
            claims.setdefault(row["candidates"][0]["debit_event_id"], []).append(row)
    for same_target in claims.values():
        if len(same_target) > 1:
            for row in same_target:
                row.update(
                    status="review",
                    suggested_action=None,
                    note="文件内多行对应同一申购，请逐条核对来源身份",
                )
    summary = {
        key: sum(row["status"] == key for row in rows)
        for key in (
            "exact_match",
            "review",
            "unmatched",
            "duplicate",
            "applied",
            "error",
        )
    }
    return {
        "batch": record(batch),
        "headers": batch.diagnostics.get("headers", []),
        "mapping": batch.mapping,
        "context": batch.diagnostics.get("fund_context", {}),
        "preview_version": batch.version,
        "ledger_revision": batch.ledger_revision,
        "preview_hash": batch.preview_hash,
        "rows": rows[offset : offset + limit],
        "summary": summary,
        "count": len(rows),
        "offset": offset,
        "limit": limit,
        "has_more": offset + limit < len(rows),
    }


def _remember_replacement(space, user, row, old, new, reason):
    if old:
        replacement = Resource.objects.create(
            tenant=space,
            created_by=user,
            kind=REPLACEMENTS,
            data={
                "old_event_id": str(old.pk),
                "new_event_id": str(new.pk),
                "source_record_id": str(row.pk),
                "batch_id": str(row.batch_id),
                "reason": reason,
                "original": record(old),
            },
        )
        audit(space, user, "import.fund_event_corrected", replacement, replacement.data)


def _revise_resource(resource, user, updates):
    if all(resource.data.get(k) == v for k, v in updates.items()):
        return
    _remember(resource, user)
    resource.data = {**resource.data, **updates}
    resource.version += 1
    resource.save(update_fields=["data", "version"])


def _correct(space, user, row, debit, confirmation, reason):
    from .ledger import post_event, reverse_event

    n = row.normalized
    blocked = _correction_block(space, debit, confirmation, n)
    if blocked:
        raise DomainError(blocked, "dependency", 409)
    old_debit, old_confirmation = debit, confirmation
    occurrences = list(Occurrence.objects.filter(tenant=space, event=debit))
    if confirmation:
        reverse_event(space, user, confirmation, reason)
    change_debit = dec(debit.payload["amount"]) != dec(n["amount"]) or (
        n.get("payment_date") and str(debit.economic_date) != n["payment_date"]
    )
    if change_debit:
        reverse_event(space, user, debit, reason)
        data = {
            **debit.payload,
            "amount": n["amount"],
            "economic_date": n.get("payment_date") or str(debit.economic_date),
            "automatic_estimate": False,
            "entry_basis": "institution_statement",
            "source_record_id": str(row.pk),
            "description": "按机构账单更正申购扣款",
        }
        if not debit.payload.get("untracked_funding"):
            from .institution_funding import available_funding_cash

            account = get_obj(Account, space, data["account_id"])
            if available_funding_cash(space, account, day(data["economic_date"])) < dec(
                n["amount"]
            ):
                raise DomainError("实际扣款金额超过来源账户可用资金，请核对账户余额")
        debit = post_event(
            space,
            user,
            data,
            stage_key=f"{space.pk}:fund-statement:{row.pk}:debit",
            _untracked_funding=bool(old_debit.payload.get("untracked_funding")),
        )
        _remember_replacement(space, user, row, old_debit, debit, reason)
    adjustment = dec(n["amount"]) - money_round(
        dec(n["quantity"], places=18) * dec(n["nav"], places=18) + dec(n["fee"])
    )
    data = {
        **(confirmation.payload if confirmation else {}),
        "kind": "fund_confirm",
        "account_id": n["account_id"],
        "instrument_id": n["instrument_id"],
        "related_event_id": str(debit.pk),
        "economic_date": n["confirmation_date"],
        "quantity": n["quantity"],
        "price": n["nav"],
        "fee": n["fee"],
        "amount": n["amount"],
        "currency": n["currency"],
        "automatic_estimate": False,
        "entry_basis": "institution_statement",
        "source_record_id": str(row.pk),
        "rounding_confirmed": True,
        "description": "按机构账单记录实际确认份额",
    }
    confirmation = post_event(
        space,
        user,
        data,
        stage_key=f"{space.pk}:fund-statement:{row.pk}:confirm",
        _fund_confirmation={
            "confirmed_amount": n["amount"],
            "rounding_adjustment": str(adjustment),
        },
    )
    _remember_replacement(space, user, row, old_confirmation, confirmation, reason)
    for occurrence in occurrences:
        before = record(occurrence)
        occurrence.event, occurrence.amount = debit, dec(n["amount"])
        occurrence.due_date = debit.economic_date
        occurrence.status = "confirmed"
        occurrence.details = {
            **occurrence.details,
            "scheduled_date": occurrence.details.get("scheduled_date")
            or before["due_date"],
            "actual_source_record_id": str(row.pk),
        }
        occurrence.version += 1
        occurrence.save(
            update_fields=[
                "event",
                "amount",
                "due_date",
                "status",
                "details",
                "version",
            ]
        )
        audit(
            space,
            user,
            "occurrence.statement_corrected",
            occurrence,
            {"before": before, "after": record(occurrence)},
        )
    for resource in Resource.objects.filter(
        tenant=space,
        kind__in=["fund_orders", "dca_import_periods"],
        data__debit_event_id=str(old_debit.pk),
    ):
        updates = {
            "debit_event_id": str(debit.pk),
            "confirmation_event_id": str(confirmation.pk),
            "amount": n["amount"],
            "quantity": n["quantity"],
            "fee": n["fee"],
            "confirmation_date": n["confirmation_date"],
            "actual_source_record_id": str(row.pk),
        }
        if resource.kind == "fund_orders":
            updates.update(
                status="confirmed",
                price=n["nav"],
                payment_date=str(debit.economic_date),
                note="已按机构账单核实",
                needs_review=False,
                fee_mode="fixed",
                fee_value=n["fee"],
            )
        _revise_resource(resource, user, updates)
    return (
        debit,
        confirmation,
        [str(confirmation.pk)] + ([str(debit.pk)] if change_debit else []),
    )


def _occupied_by_other_order(space, row, event):
    n = row.normalized
    if not n.get("external_id"):
        return False
    return (
        EvidenceLink.objects.filter(
            tenant=space,
            event=event,
            active=True,
            record__batch__parser_version=PARSER,
            record__batch__source=row.batch.source,
            record__normalized__account_id=n["account_id"],
        )
        .exclude(record__normalized__external_id=n["external_id"])
        .exclude(record__normalized__external_id__isnull=True)
        .exists()
    )


def _attach(space, user, row, debit, confirmation, introduced=()):
    fact = SourceFact.objects.filter(tenant=space, identity=row.identity).first()
    if fact and not _source_compatibility(space, row, fact):
        raise DomainError("来源身份包含冲突事实，不能覆盖", "source_revision", 409)
    events = [debit]
    if confirmation and all(row.normalized.get(k) is not None for k in CONFIRM_FIELDS):
        events.append(confirmation)
    for event in events:
        if _occupied_by_other_order(space, row, event):
            raise DomainError(
                "该事项已关联另一来源订单号，不能仅凭相同日期和金额合并",
                "source_conflict",
                409,
            )
        link, created = EvidenceLink.objects.get_or_create(
            tenant=space,
            record=row,
            event=event,
            defaults={
                "created_by": user,
                "introduced": str(event.pk) in introduced,
                "active": True,
            },
        )
        if not created and not link.active:
            link.active = True
            link.save(update_fields=["active"])
    fact = SourceFact.objects.filter(tenant=space, identity=row.identity).first()
    target = events[-1]
    if fact:
        if not _source_compatibility(space, row, fact) or not _same_business(
            space, fact.event, target
        ):
            raise DomainError("来源身份已有不同关联，不能覆盖", "source_revision", 409)
    else:
        SourceFact.objects.create(
            tenant=space,
            created_by=user,
            identity=row.identity,
            event=target,
            fingerprint=_fingerprint(row.normalized),
        )


@transaction.atomic
def apply(space, user, batch, body):
    locked = Workspace.objects.select_for_update().get(pk=space.pk)
    space.revision = locked.revision
    if batch.parser_version != PARSER or batch.status not in {
        "ready",
        "needs_review",
        "partially_committed",
        "committed",
    }:
        raise DomainError("请先预览基金确认记录")
    if (
        body.get("preview_version") != batch.version
        or body.get("ledger_revision") != batch.ledger_revision
        or body.get("ledger_revision") != space.revision
        or body.get("preview_hash") != batch.preview_hash
    ):
        raise DomainError("账簿或预览已更新，请重新预览后处理", "stale_preview", 409)
    rows = {str(row.pk): row for row in batch.rows.order_by("row_number")}
    previews = {
        p["id"]: p for p in batch_preview(space, batch, limit=len(rows))["rows"]
    }
    decisions = body.get("decisions")
    if decisions is None:
        decisions = [
            {"row_id": key, "action": "link"}
            for key, p in previews.items()
            if p["status"] in ("exact_match", "duplicate")
        ]
    if not isinstance(decisions, list):
        raise DomainError("请提供处理决定列表")
    selected = set()
    for decision in decisions:
        if (
            not isinstance(decision, dict)
            or decision.get("row_id") not in rows
            or decision.get("row_id") in selected
        ):
            raise DomainError("处理行不存在或重复")
        selected.add(decision["row_id"])
        if decision.get("action") not in ("link", "correct", "skip"):
            raise DomainError("不支持的核对操作")
    counts = {"linked": 0, "corrected": 0, "skipped": 0}
    skipped = set(batch.diagnostics.get("fund_skipped_rows", []))
    changed = False
    for decision in decisions:
        row, p = rows[decision["row_id"]], previews[decision["row_id"]]
        action = decision["action"]
        if action == "skip":
            skipped.add(str(row.pk))
            counts["skipped"] += 1
            continue
        if p["status"] == "applied":
            continue
        if row.errors or p["errors"]:
            raise DomainError(f"第 {row.row_number} 行仍需核对来源字段")
        if p["status"] == "duplicate":
            fact = SourceFact.objects.get(tenant=space, identity=row.identity)
            event = resolved_event(space, fact.event)
            debit = event.related if event.kind == "fund_confirm" else event
            cid = p["candidates"][0]["confirmation_event_id"]
            confirmation = get_obj(Event, space, cid) if cid else None
            if action != "link" or decision.get("debit_event_id") not in (
                None,
                str(debit.pk),
            ):
                raise DomainError("已导入来源只能关联原事项")
            _attach(space, user, row, debit, confirmation)
            counts["linked"] += 1
            changed = True
            continue
        candidates = p["candidates"]
        chosen = [
            c
            for c in candidates
            if c["debit_event_id"] == decision.get("debit_event_id")
        ]
        if not chosen and not decision.get("debit_event_id") and len(candidates) == 1:
            chosen = candidates
        if len(chosen) != 1:
            raise DomainError("请明确选择本条账单对应的申购；日期金额相同不能自动合并")
        candidate = chosen[0]
        debit = get_obj(Event, space, candidate["debit_event_id"])
        confirmation = (
            get_obj(Event, space, candidate["confirmation_event_id"])
            if candidate["confirmation_event_id"]
            else None
        )
        if _occupied_by_other_order(space, row, debit):
            raise DomainError(
                "该事项已有另一来源订单号，不能合并或覆盖", "source_conflict", 409
            )
        if action == "link":
            if not row.normalized.get("payment_date") and not all(
                row.normalized.get(k) is not None for k in CONFIRM_FIELDS
            ):
                raise DomainError(
                    "申请日期不能证明已经扣款；请补充实际扣款日或完整确认记录"
                )
            if candidate["differences"]:
                raise DomainError("实际字段与原记录有差异，请选择更正并填写原因")
            _attach(space, user, row, debit, confirmation)
            counts["linked"] += 1
        else:
            reason = str(decision.get("reason") or "").strip()
            if not reason:
                raise DomainError("更正需填写原因，原自动记录将保留冲正和替代链")
            if not candidate["correction_allowed"]:
                raise DomainError(candidate["blocked_reason"], "dependency", 409)
            debit, confirmation, introduced = _correct(
                space, user, row, debit, confirmation, reason
            )
            _attach(space, user, row, debit, confirmation, introduced)
            counts["corrected"] += 1
        changed = True
        skipped.discard(str(row.pk))
    if changed:
        bump(space, user)
    linked_ids = {
        str(v)
        for v in EvidenceLink.objects.filter(
            tenant=space, record__batch=batch, active=True
        ).values_list("record_id", flat=True)
    }
    batch.diagnostics = {
        **batch.diagnostics,
        "fund_skipped_rows": sorted(skipped),
        "committed_rows": len(linked_ids),
        "remaining_rows": len(set(rows) - linked_ids - skipped),
    }
    batch.status = (
        "committed"
        if not batch.diagnostics["remaining_rows"]
        else "partially_committed"
        if linked_ids
        else "needs_review"
    )
    # Remaining exception rows can be resolved against the newly produced revision.
    batch.ledger_revision = space.revision
    batch.version += 1
    batch.save()
    audit(
        space, user, "import.fund_reconciled", batch, {**counts, "decisions": decisions}
    )
    return {
        "batch_id": str(batch.pk),
        "status": batch.status,
        **counts,
        "data_revision": space.revision,
        "preview_version": batch.version,
        "ledger_revision": batch.ledger_revision,
        "preview_hash": batch.preview_hash,
    }


@transaction.atomic
def reverse(space, user, batch, reason):
    """Remove corroborating evidence without erasing a corrected financial fact."""
    if not str(reason or "").strip():
        raise DomainError("请填写撤销核对的原因")
    links = list(
        EvidenceLink.objects.filter(tenant=space, record__batch=batch, active=True)
    )
    if not links:
        raise DomainError("该批次没有可撤销的核对")
    # Corrections remain explicit actual facts; undoing the file cannot delete the
    # replacement and silently restore cash. Financial undo uses event reversals.
    if any(link.introduced for link in links):
        raise DomainError(
            "该批次已更正金融记录，请从交易记录按依赖顺序冲正；不能通过删除来源文件撤销资金事实",
            "dependency",
            409,
        )
    for link in links:
        link.active = False
        link.save(update_fields=["active"])
    batch.status = "reversed"
    batch.version += 1
    batch.save()
    bump(space, user)
    audit(
        space,
        user,
        "import.fund_verification_reversed",
        batch,
        {"reason": reason, "links": [str(l.pk) for l in links]},
    )
    return record(batch)
