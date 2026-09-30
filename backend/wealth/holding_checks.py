"""Versioned institution comparisons; observations never alter financial facts.

An unresolved difference suppresses profit assertions while keeping the recorded
quantity, cost, market value and funding untouched. Available units are notes,
not a substitute for confirmed units. These records never create prices or cash.
"""

from copy import deepcopy
from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .common import DomainError, audit, bump, day, dec, get_obj, serial
from .models import (
    Account,
    Event,
    Instrument,
    PositionMovement,
    Resource,
    ResourceRevision,
    Workspace,
)

KIND = "holding_checks"
TOLERANCE = Decimal("0.02")
FIELDS = {
    "version",
    "expected_revision",
    "opening_event_id",
    "account_id",
    "instrument_id",
    "as_of",
    "institution_profit",
    "reference_nav",
    "reference_date",
    "available_quantity",
    "note",
    "scope_unconfirmed",
}


def _version(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise DomainError("核对记录版本须为非负整数", "version_required", 428)
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise DomainError("核对记录版本须为非负整数", "version_required", 428) from None
    if result < 0 or str(result) != str(value):
        raise DomainError("核对记录版本须为非负整数", "version_required", 428)
    return result


def _basis(space, opening_or_id, when):
    opening = get_obj(Event, space, getattr(opening_or_id, "pk", opening_or_id))
    if (
        opening.kind != "opening"
        or opening.payload.get("opening_source") != "existing_holding"
        or opening.reverses_id
        or Event.objects.filter(tenant=space, reverses=opening).exists()
    ):
        raise DomainError(
            "只可核对尚未更正或冲正的存量持仓录入", "holding_check_ineligible"
        )
    if opening.economic_date > when:
        raise DomainError("该持仓尚未到核对日期", "holding_check_ineligible")
    movements = list(PositionMovement.objects.filter(tenant=space, event=opening))
    if len(movements) != 1 or movements[0].quantity <= 0:
        raise DomainError("原记录不是可核对的单一持仓", "holding_check_ineligible")
    movement = movements[0]
    account = get_obj(Account, space, movement.account_id)
    instrument = get_obj(Instrument, space, movement.instrument_id)
    from .investments import is_derivative_instrument

    if (
        is_derivative_instrument(instrument)
        or instrument.kind == "index"
        or account.valuation_mode == "snapshot"
    ):
        raise DomainError(
            "此类账户或产品请核对机构权益，不能使用份额持仓核对",
            "holding_check_ineligible",
        )
    if str(account.pk) != opening.payload.get("account_id") or str(
        instrument.pk
    ) != opening.payload.get("instrument_id"):
        raise DomainError(
            "原持仓关联信息不一致，请核对原始记录", "holding_check_ineligible"
        )
    later = (
        PositionMovement.objects.filter(
            tenant=space,
            account=account,
            instrument=instrument,
            event__economic_date__lte=when,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        )
        .exclude(event=opening)
        .filter(
            Q(created_at__gt=opening.created_at)
            | Q(event__economic_date__gte=opening.economic_date)
        )
    )
    if later.exists():
        raise DomainError(
            "录入后已有实际持仓变化，请先按最新记录核对", "holding_check_ineligible"
        )
    return opening, movement, account, instrument


def holding_check_eligibility(space, opening_event_id_or_event, when=None):
    """Independent from correction eligibility; legacy onboarding may be checked."""
    ident = str(
        getattr(opening_event_id_or_event, "pk", opening_event_id_or_event) or ""
    )
    try:
        opening, _, account, _ = _basis(space, ident, day(when))
        if account.archived:
            raise DomainError("账户已归档，不能新增核对记录")
    except DomainError as error:
        return {
            "eligible": False,
            "reason": error.message,
            "opening_event_id": ident or None,
        }
    return {
        "eligible": True,
        "reason": "",
        "opening_event_id": str(opening.pk),
        "as_of": str(opening.economic_date),
    }


def _original_value(space, opening, account, instrument):
    observation = (
        Resource.objects.filter(
            tenant=space,
            kind="holding_valuations",
            data__opening_event_id=str(opening.pk),
            data__account_id=str(account.pk),
            data__instrument_id=str(instrument.pk),
        )
        .order_by("-created_at")
        .first()
    )
    if observation and observation.data.get("value") not in (None, ""):
        return dec(observation.data["value"], nonnegative=True)
    value = opening.payload.get("opening_market_value")
    return dec(value, nonnegative=True) if value not in (None, "") else None


def _record(obj):
    return serial({**obj.data, "id": str(obj.pk), "version": obj.version})


@transaction.atomic
def save_holding_check(space, user, opening_event_id, body):
    """Dedicated POST service. HTTP caller must use write_command for idempotency.

    First write requires version=0; another check updates the same record using
    its returned version. A workspace lock serializes concurrent first writes.
    """
    if not isinstance(body, dict) or set(body) - FIELDS:
        raise DomainError("核对记录含有不支持的字段", "holding_check_fields")
    expected = _version(body.get("version"))
    locked = Workspace.objects.select_for_update().get(pk=space.pk)
    if locked.deleted_at:
        raise DomainError("此空间已移入回收站", "not_found", 404)
    if (
        "expected_revision" in body
        and _version(body["expected_revision"]) != locked.revision
    ):
        raise DomainError("账簿已变化，请刷新后核对", "version_conflict", 412)
    opening, movement, account, instrument = _basis(space, opening_event_id, day())
    if account.archived:
        raise DomainError("账户已归档，不能新增核对记录")
    identities = {
        "opening_event_id": opening.pk,
        "account_id": account.pk,
        "instrument_id": instrument.pk,
    }
    for key, value in identities.items():
        if key in body and str(body[key]) != str(value):
            raise DomainError("核对信息须关联原持仓记录", "holding_check_identity")
    as_of = opening.economic_date
    if "as_of" in body and (not body["as_of"] or day(body["as_of"]) != as_of):
        raise DomainError("核对日期须与原持仓录入的核对日期相同")
    reference_date = day(body.get("reference_date") or as_of)
    if reference_date > as_of or reference_date > day():
        raise DomainError("平台数据日期不能晚于原持仓核对日期或今天")
    institution_profit = dec(body.get("institution_profit"))
    nav = (
        dec(body["reference_nav"], nonnegative=True, places=18)
        if body.get("reference_nav") not in (None, "")
        else None
    )
    if nav is not None and nav <= 0:
        raise DomainError("参考净值须大于零")
    available = (
        dec(body["available_quantity"], nonnegative=True, places=18)
        if body.get("available_quantity") not in (None, "")
        else None
    )
    note = body.get("note", "")
    if not isinstance(note, str) or len(note) > 2000:
        raise DomainError("核对备注须为不超过 2000 字的文字")
    current_value = _original_value(space, opening, account, instrument)
    cost = movement.cost
    computed = (
        current_value - cost if current_value is not None and cost is not None else None
    )
    difference = computed - institution_profit if computed is not None else None
    reference_value = movement.quantity * nav if nav is not None else None
    reasons = []
    if difference is None:
        reasons.append("original_value_or_cost_unknown")
    elif abs(difference) > TOLERANCE:
        reasons.append("profit_difference")
    if (
        reference_value is not None
        and current_value is not None
        and abs(reference_value - current_value) > TOLERANCE
    ):
        reasons.append("nav_value_difference")
    obj = Resource.objects.filter(
        tenant=space, kind=KIND, data__opening_event_id=str(opening.pk)
    ).first()
    current_version = obj.version if obj else 0
    if current_version != expected:
        raise DomainError("核对记录已变化，请刷新后再提交", "version_conflict", 412)
    scope_unconfirmed = body.get(
        "scope_unconfirmed", obj.data.get("scope_unconfirmed", False) if obj else False
    )
    if not isinstance(scope_unconfirmed, bool):
        raise DomainError("金额范围是否待核对须为布尔值")
    if scope_unconfirmed:
        reasons.append("scope_unconfirmed")
    values = serial(
        {
            **{key: str(value) for key, value in identities.items()},
            "as_of": as_of,
            "institution_profit": institution_profit,
            "reference_nav": nav,
            "reference_date": reference_date,
            "available_quantity": available,
            "available_quantity_is_information_only": True,
            "quantity": movement.quantity,
            "cost": cost,
            "current_value": current_value,
            "computed_profit": computed,
            "profit_difference": difference,
            "reference_value": reference_value,
            "status": "unresolved" if reasons else "matched",
            "reasons": reasons,
            "scope_unconfirmed": scope_unconfirmed,
            "scope_message": "用户尚未核实资产、成本和收益是否属于同一金额范围"
            if scope_unconfirmed
            else None,
            "note": note.strip(),
            "checked_at": timezone.now(),
            "affects_cash_or_quantity": False,
            "is_realized_profit": False,
        }
    )
    if obj:
        ResourceRevision.objects.get_or_create(
            tenant=space,
            resource=obj,
            version=obj.version,
            defaults={"created_by": user, "data": deepcopy(obj.data)},
        )
        obj.data = values
        obj.version += 1
        obj.save(update_fields=["data", "version"])
    else:
        obj = Resource.objects.create(
            tenant=space, created_by=user, kind=KIND, data=values
        )
    ResourceRevision.objects.get_or_create(
        tenant=space,
        resource=obj,
        version=obj.version,
        defaults={"created_by": user, "data": deepcopy(values)},
    )
    audit(
        space,
        user,
        "holding.check_recorded",
        obj,
        {
            "opening_event_id": str(opening.pk),
            "status": values["status"],
            "version": obj.version,
        },
    )
    bump(space, user, invalidate_reconciliations=False)
    return _record(obj)


def read_holding_check(space, account, instrument, quantity, when, opening=None):
    """Return only the active check for an unchanged, unreversed original holding."""
    when = day(when)
    candidates = Resource.objects.filter(
        tenant=space,
        kind=KIND,
        data__account_id=str(account.pk),
        data__instrument_id=str(instrument.pk),
    ).order_by("-created_at")
    if opening is not None:
        candidates = candidates.filter(
            data__opening_event_id=str(getattr(opening, "pk", opening))
        )
    for obj in candidates:
        try:
            source, movement, found_account, found_instrument = _basis(
                space, obj.data.get("opening_event_id"), when
            )
            if (
                found_account.pk != account.pk
                or found_instrument.pk != instrument.pk
                or movement.quantity != dec(quantity, places=18)
                or day(obj.data["as_of"]) != source.economic_date
            ):
                continue
        except DomainError:
            continue
        return _record(obj)
    return None


def apply_holding_check(row, check):
    """Idempotent presentation decoration; never replace cost, quantity or value."""
    result = dict(row)
    if not check:
        return result
    result["reconciliation"] = check
    result["institution_profit"] = check.get("institution_profit")
    result["computed_profit"] = check.get("computed_profit")
    if check.get("status") != "unresolved":
        return result
    if result.get("status") != "needs_reconciliation":
        result["valuation_status"] = result.get("status")
    if result.get("estimate_profit") is not None and "estimated_profit" not in result:
        result["estimated_profit"] = result["estimate_profit"]
    result.update(
        unrealized_profit=None,
        profit=None,
        profit_rate=None,
        estimate_profit=None,
        cost_status="unreconciled",
        status="needs_reconciliation",
    )
    return result
