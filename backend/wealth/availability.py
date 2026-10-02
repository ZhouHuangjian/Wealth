"""Cash-only withdrawal projections for recorded investment accounts.

This is a presentation assumption, never a cash entry or proof of account equity.
Reported withdrawal amounts take precedence, including an explicitly reported zero.
"""

from decimal import Decimal, InvalidOperation

from django.db.models import Q, Sum

from .models import JournalLine, PositionMovement, Resource

ZERO = Decimal(0)
FUTURES_ACCOUNTS = {"future", "futures"}
CASH_INSTITUTION_ACCOUNTS = FUTURES_ACCOUNTS | {
    "bank",
    "cash",
    "wallet",
    "fund",
    "broker",
    "securities",
    "option",
    "options",
}
RESTRICTED_KEYS = {"margin", "frozen", "frozen_cash", "frozen_amount", "blocked_funds"}
WITHDRAWAL_LIMIT_KEYS = {
    "withdrawal_limit",
    "withdrawable_limit",
    "withdrawal_cap",
    "available_limit",
}
NON_CASH_CODES = {
    "investment",
    "fund_transit",
    "receivable",
    "payable",
    "property",
    "margin",
    "unclassified",
    "loan_clearing",
}


def _zero(value):
    if value in (None, ""):
        return True
    if isinstance(value, bool):
        return value is False
    try:
        number = Decimal(str(value))
        return number.is_finite() and number == ZERO
    except (InvalidOperation, ValueError, TypeError):
        return False


def _snapshot_positions_present(value):
    """An unrecognised nonempty position description is evidence, not absence."""
    if value in (None, "", [], {}):
        return False
    if isinstance(value, list):
        return any(_snapshot_positions_present(row) for row in value)
    if isinstance(value, dict):
        quantities = [
            value[key]
            for key in ("quantity", "volume", "long", "short")
            if key in value
        ]
        if quantities:
            return any(not _zero(quantity) for quantity in quantities)
        return True
    return not _zero(value)


def _active_at(when):
    return Q(event__reverses__isnull=True) & (
        Q(event__reversal__isnull=True) | Q(event__reversal__economic_date__gt=when)
    )


def has_recorded_investments(space, account, when, details=None, *, since=None):
    """Absence today cannot erase positions or P&L since an older statement.

    Catalogue rows are not holdings. Inspect ledger positions of every kind,
    unsettled asset balances, and option references even if their product was
    archived. A round trip after the statement still needs its actual P&L.
    """
    from .common import day

    details = details or {}
    if _snapshot_positions_present(details.get("positions")) or not _zero(
        details.get("margin")
    ):
        return True
    for reference in Resource.objects.filter(
        tenant=space, kind="option_positions", data__account_id=str(account.pk)
    ):
        data = reference.data
        purchased = data.get("purchase_date") or data.get("as_of")
        if not purchased:
            return True
        if day(purchased) > when:
            continue
        closed = data.get("closed_date") if data.get("status") == "closed" else None
        if not closed or day(closed) > (since if since is not None else when):
            return True
    movements = PositionMovement.objects.filter(
        _active_at(when),
        tenant=space,
        account=account,
        event__economic_date__lte=when,
    )
    if (
        since is not None
        and movements.filter(event__economic_date__gt=since)
        .exclude(quantity=ZERO)
        .exists()
    ):
        return True
    quantities = (
        (
            movements.filter(event__economic_date__lte=since)
            if since is not None
            else movements
        )
        .values("instrument_id")
        .annotate(total=Sum("quantity"))
    )
    if any(row["total"] != ZERO for row in quantities):
        return True
    non_cash = JournalLine.objects.filter(
        _active_at(when),
        tenant=space,
        account=account,
        code__in=NON_CASH_CODES,
        event__economic_date__lte=when,
    )
    if (
        since is not None
        and non_cash.filter(event__economic_date__gt=since)
        .exclude(amount=ZERO)
        .exists()
    ):
        return True
    balances = (
        (
            non_cash.filter(event__economic_date__lte=since)
            if since is not None
            else non_cash
        )
        .values("code", "instrument_id")
        .annotate(total=Sum("amount"))
    )
    return any(row["total"] != ZERO for row in balances)


def cash_only_interval(space, account, when, snapshot):
    return account.kind in CASH_INSTITUTION_ACCOUNTS and not has_recorded_investments(
        space, account, when, snapshot.details, since=snapshot.economic_date
    )


def _has_recorded_exposure(space, account, when, details):
    if not _zero(account.frozen) or any(
        not _zero(details.get(key)) for key in RESTRICTED_KEYS
    ):
        return True
    if has_recorded_investments(space, account, when, details):
        return True
    restricted = (
        JournalLine.objects.filter(
            _active_at(when),
            tenant=space,
            account=account,
            code__in=RESTRICTED_KEYS,
            event__economic_date__lte=when,
        )
        .values("code")
        .annotate(total=Sum("amount"))
    )
    return any(row["total"] != ZERO for row in restricted)


def institution_availability(space, account, when, institution, details=None):
    """Describe availability without changing any valuation/completeness fields."""
    details = details or {}
    result = {
        "available": None,
        "available_basis": "unavailable",
        "available_estimated": False,
        "available_eligible": False,
        "available_as_of": institution.get("date"),
        "available_message": "缺少已核实的可提取金额",
    }
    eligible = not institution["gaps"] and (
        institution.get("date") == when
        or institution.get("cash_only_carry_forward") is True
    )
    limits = []
    for key in WITHDRAWAL_LIMIT_KEYS:
        if key not in details:
            continue
        try:
            value = Decimal(str(details[key]))
            if not value.is_finite() or value < ZERO:
                return result
            limits.append(value)
        except (InvalidOperation, TypeError, ValueError):
            return result
    reported = institution.get("reported_available")
    if reported not in (None, ""):
        # Keep an explicit withdrawal figure as a ceiling, including zero. A
        # cash-only roll-forward must not release an institution's restriction.
        result["available_basis"] = "reported"
        if eligible:
            try:
                number = Decimal(str(reported))
                if number.is_finite() and number >= ZERO:
                    ceiling = max(
                        ZERO, institution["local_value"] - max(ZERO, account.frozen)
                    )
                    result.update(
                        available=min(number, ceiling, *limits),
                        available_eligible=True,
                        available_estimated=institution.get("date") != when,
                        available_as_of=when,
                        available_message="沿用机构可提取上限，并以当前已记录权益为限"
                        if institution.get("date") != when
                        else "机构填报的可提取金额",
                    )
            except (InvalidOperation, ValueError, TypeError):
                pass
        return result
    if (
        account.kind not in CASH_INSTITUTION_ACCOUNTS
        or institution.get("local_value") is None
        or institution.get("basis") == "recorded_cash"
        or _has_recorded_exposure(space, account, when, details)
    ):
        return result
    result.update(
        available=min(max(ZERO, institution["local_value"]), *limits)
        if limits
        else max(ZERO, institution["local_value"]),
        available_basis="estimated_no_positions",
        available_estimated=True,
        available_eligible=eligible,
        available_as_of=when,
        available_message="无有效投资持仓或在途款，按已记录权益推算，并保留已知可提取上限；实际可提取额以机构为准",
    )
    return result
