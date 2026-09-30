"""Conservative cash-only withdrawal estimates for recorded futures accounts.

This is a presentation assumption, never a cash entry or proof of account equity.
Reported withdrawal amounts take precedence, including an explicitly reported zero.
"""

from decimal import Decimal, InvalidOperation

from django.db.models import Sum

from .models import JournalLine, PositionMovement

ZERO = Decimal(0)
FUTURES_ACCOUNTS = {"future", "futures"}
RESTRICTED_KEYS = {"margin", "frozen", "frozen_cash", "frozen_amount", "blocked_funds"}


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


def _has_recorded_exposure(space, account, when, details):
    from .investments import is_derivative_instrument
    from .models import Instrument
    from .option_positions import has_option_reference

    if not _zero(account.frozen) or any(
        not _zero(details.get(key)) for key in RESTRICTED_KEYS
    ):
        return True
    if _snapshot_positions_present(details.get("positions")):
        return True
    if has_option_reference(space, account_id=account.pk, when=when, active_only=True):
        return True
    # Inspect authoritative movements as well as reference positions. Hiding a
    # product in the catalogue cannot prove that a real contract was closed.
    quantities = dict(
        PositionMovement.objects.filter(
            tenant=space,
            account=account,
            event__economic_date__lte=when,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        )
        .values("instrument_id")
        .annotate(total=Sum("quantity"))
        .values_list("instrument_id", "total")
    )
    if any(
        quantities[instrument.pk] != ZERO and is_derivative_instrument(instrument)
        for instrument in Instrument.objects.filter(tenant=space, pk__in=quantities)
    ):
        return True
    restricted = (
        JournalLine.objects.filter(
            tenant=space,
            account=account,
            code__in=RESTRICTED_KEYS,
            event__economic_date__lte=when,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
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
    reported = institution.get("reported_available")
    if reported not in (None, ""):
        # Keep the established same-day, reconciled statement requirement. An
        # unusable explicit amount still prevents fallback to a larger estimate.
        result["available_basis"] = "reported"
        if not institution["gaps"] and institution.get("date") == when:
            try:
                number = Decimal(str(reported))
                if number.is_finite() and number >= ZERO:
                    result.update(
                        available=number,
                        available_eligible=True,
                        available_message="机构填报的可提取金额",
                    )
            except (InvalidOperation, ValueError, TypeError):
                pass
        return result
    if (
        account.kind not in FUTURES_ACCOUNTS
        or institution.get("local_value") is None
        or institution.get("basis") == "recorded_cash"
        or _has_recorded_exposure(space, account, when, details)
    ):
        return result
    result.update(
        available=max(ZERO, institution["local_value"]),
        available_basis="estimated_no_positions",
        available_estimated=True,
        available_eligible=not institution["gaps"] and institution.get("date") == when,
        available_as_of=when,
        available_message="未录入有效期货、期权持仓或保证金、冻结资金，按已记录权益推算；实际可提取额以机构为准",
    )
    return result
