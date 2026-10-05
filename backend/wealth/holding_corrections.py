"""Correct onboarding facts without moving the institution's money again."""

from django.db import transaction

from .common import DomainError, audit, day, dec, get_obj, serial
from .models import Account, Event, Instrument, PositionMovement, Resource, Workspace


def _original(space, opening):
    from .holding_checks import holding_check_eligibility

    eligibility = holding_check_eligibility(space, opening)
    if not eligibility["eligible"]:
        raise DomainError(eligibility["reason"], "holding_correction_ineligible")
    if opening.following.filter(reversal__isnull=True, reverses__isnull=True).exists():
        raise DomainError(
            "原录入已有依赖记录，请先核对后续事项", "holding_correction_ineligible"
        )
    # Include future/backdated movements: correcting the original cost would
    # otherwise invalidate their already-posted cost basis.
    movement = PositionMovement.objects.get(tenant=space, event=opening)
    if (
        PositionMovement.objects.filter(
            tenant=space,
            account=movement.account,
            instrument=movement.instrument,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        )
        .exclude(event=opening)
        .exists()
    ):
        raise DomainError(
            "已有其他实际持仓变动，不能单独更正期初份额或成本",
            "holding_correction_ineligible",
        )
    observation = (
        Resource.objects.filter(
            tenant=space,
            kind="holding_valuations",
            data__opening_event_id=str(opening.pk),
        )
        .order_by("-created_at")
        .first()
    )
    if not observation or opening.payload.get("opening_market_value") in (None, ""):
        raise DomainError(
            "原录入没有固定市值，无法保证更正前后资金分配不变",
            "holding_correction_ineligible",
        )
    value = dec(observation.data["value"], nonnegative=True)
    if value != dec(opening.payload["opening_market_value"]):
        raise DomainError(
            "原估值与资金记录不一致，请先核对原始资料", "holding_correction_ineligible"
        )
    payload = opening.payload
    mode = payload.get("funding_mode", "external")
    if mode not in {"external", "allocate"} or (
        mode == "allocate" and dec(payload.get("funding_amount")) != value
    ):
        raise DomainError("原资金分配无法安全保留", "holding_correction_ineligible")
    parent = opening.related
    if parent and (
        mode != "allocate"
        or parent.kind != "transfer"
        or not parent.payload.get("holding_funding_transfer")
        or parent.payload.get("target_account_id") != str(movement.account_id)
        or parent.payload.get("account_id") != payload.get("funding_account_id")
        or parent.economic_date != opening.economic_date
        or parent.reverses_id
        or Event.objects.filter(tenant=space, reverses=parent).exists()
        or parent.following.filter(reversal__isnull=True, reverses__isnull=True)
        .exclude(pk=opening.pk)
        .exists()
    ):
        raise DomainError(
            "原补资存在复杂依赖，暂不能自动更正", "holding_correction_ineligible"
        )
    return movement, observation, parent


def correction_metadata(space, opening):
    result = {
        "opening_event_id": str(opening.pk) if opening else None,
        "eligible": False,
        "reason": "仅支持更正存量持仓录入",
        "data_revision": space.revision,
        "initial_values": None,
    }
    if not opening:
        return result
    try:
        movement, observation, _ = _original(space, opening)
    except DomainError as error:
        result["reason"] = error.message
        return result
    payload = opening.payload
    initial = {
        "account_id": str(movement.account_id),
        "instrument_id": str(movement.instrument_id),
        "as_of": str(opening.economic_date),
        "quantity": str(movement.quantity),
        "cost": str(movement.cost),
        "purchase_date": payload.get("purchase_date") or str(opening.economic_date),
        "history_mode": payload.get("history_mode", "snapshot_only"),
        "valuation_mode": "value",
        "current_value": observation.data["value"],
        "funding_mode": payload.get("funding_mode", "external"),
        "funding_account_id": payload.get("funding_account_id"),
    }
    for key in ("valuation_basis", "valuation_date", "valuation_observed_at"):
        if key in observation.data:
            initial[key] = observation.data[key]
    return serial({**result, "eligible": True, "reason": "", "initial_values": initial})


@transaction.atomic
def correct_holding(space, user, opening_event_id, body, *, administrative=False):
    from .investments import record_holding
    from .ledger import reverse_event

    if administrative:
        from .admin_access import require_delegation

        require_delegation(user, space)

    locked = Workspace.objects.select_for_update().get(pk=space.pk)
    expected = body.get("expected_revision")
    if isinstance(expected, bool) or str(expected) != str(locked.revision):
        raise DomainError(
            "账簿已变化或缺少版本，请刷新后再更正", "version_conflict", 412
        )
    space.revision = locked.revision
    reason = body.get("reason")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 2000:
        raise DomainError("请填写更正原因（不超过 2000 字）")
    opening = get_obj(Event, space, opening_event_id)
    _, _, parent = _original(space, opening)
    initial = correction_metadata(space, opening)["initial_values"]
    mutable = {
        "quantity",
        "cost",
        "purchase_date",
        "institution_profit",
        "reference_nav",
        "reference_date",
    }
    if administrative:
        mutable.update(initial)
    unsupported = set(body) - set(initial) - mutable - {"expected_revision", "reason"}
    if unsupported:
        raise DomainError(
            "更正仅支持原份额、成本和取得日期，不调整估值或资金",
            "holding_correction_fields",
        )
    for key, value in initial.items():
        if key in mutable or key not in body:
            continue
        provided = body[key]
        equal = (
            dec(provided) == dec(value) if key == "current_value" else provided == value
        )
        if not equal:
            raise DomainError(
                "账户、产品、核对日期、原市值和资金来源均须保持不变",
                "holding_correction_locked",
            )
    data = {**initial, **{key: body[key] for key in mutable if key in body}}
    # A previously unresolved check cannot silently disappear when its opening
    # is superseded. Recheck its supplied evidence against the corrected facts.
    from .holding_checks import read_holding_check

    account = get_obj(Account, space, initial["account_id"])
    instrument = get_obj(Instrument, space, initial["instrument_id"])
    previous_check = read_holding_check(
        space, account, instrument, dec(initial["quantity"], places=18), day(), opening
    )
    if previous_check and previous_check.get("status") == "unresolved":
        for key in ("institution_profit", "reference_nav", "reference_date"):
            if data.get(key) in (None, "") and previous_check.get(key) not in (
                None,
                "",
            ):
                data[key] = previous_check[key]
        if previous_check.get("scope_unconfirmed"):
            data["reconciliation_mode"] = "pending"
            data["confirm_unreconciled"] = True
    reversal = reverse_event(space, user, opening, reason.strip())
    if administrative and parent:
        reverse_event(space, user, parent, reason.strip())
    result = record_holding(
        space,
        user,
        data,
        _funding_context=None
        if administrative
        else {
            "parent": parent,
            "source_account_id": initial["funding_account_id"],
        },
    )
    result["correction"] = {
        "original_event_id": str(opening.pk),
        "reversal_event_id": str(reversal.pk),
    }
    audit(
        space,
        user,
        "holding.corrected",
        opening,
        {
            **result["correction"],
            "replacement_event_id": result["event"]["id"],
            "reason": reason.strip(),
        },
    )
    return result
