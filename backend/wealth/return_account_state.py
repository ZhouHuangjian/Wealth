"""Read-only daily assumptions for a continuously cash-only account.

An empty position list today cannot prove that today's realised P&L is zero.
This fallback therefore needs a complete, earlier formal equity observation and
no recorded exposure or unexplained equity change after that observation. It is
an estimate, never a new institution statement or a withdrawal authorisation.
"""

from datetime import timedelta
from decimal import Decimal

from .availability import (
    CASH_INSTITUTION_ACCOUNTS,
    _snapshot_positions_present,
    _zero,
    has_recorded_investments,
)

ZERO = Decimal(0)
EXTERNAL_FLOWS = {"transfer", "fx", "income", "expense", "refund"}
KNOWN_CASH_FLOWS = EXTERNAL_FLOWS | {"dividend"}


def _empty_scope(snapshot, account):
    details = snapshot.details
    return (
        snapshot.complete
        and snapshot.currency == account.currency
        and snapshot.includes_options is not None
        and (snapshot.includes_options or details.get("no_option_positions") is True)
        and not _snapshot_positions_present(details.get("positions"))
        and _zero(details.get("margin"))
    )


def cash_only_daily_return(space, account, when, *, snapshots, cash_flows):
    """Return a mergeable daily estimate, or None when it cannot be justified.

    May run before the normal current/previous statement calculation: a current
    formal statement is refused, and an intraday observation must exactly match
    the earlier equity plus known cash flows. An actual gain, loss or fee cannot
    be overwritten. This also handles an unchanged intraday observation whose
    empty interval spans several open days. Inputs are request-local,
    effective snapshots ordered by (economic_date, created_at) and cash lines
    excluding opening/reversed/reversal events. No facts are created or changed.
    Missing legacy ``positions`` remains *no recorded positions*, not verified
    institutional proof of an empty account.
    """
    if account.tenant_id != space.pk or account.kind not in CASH_INSTITUTION_ACCOUNTS:
        return None
    # Even an accidentally mixed caller batch must not lend another account's
    # statement or cash flow to this account's return.
    if any(
        row.tenant_id != space.pk or row.account_id != account.pk
        for row in (*snapshots, *cash_flows)
    ):
        return None
    rows = [row for row in snapshots if row.economic_date <= when]
    if not rows:
        return None
    formal = [
        row
        for row in rows
        if row.details.get("valuation_basis") not in {"intraday", "unknown"}
    ]
    # A first end-of-day empty statement cannot erase activity earlier that day.
    # A current formal statement also belongs to the regular P&L path.
    if not formal or formal[-1].economic_date == when:
        return None
    anchor = formal[-1]
    observations = rows[rows.index(anchor) :]
    if any(
        row.details.get("valuation_basis") == "unknown"
        or not _empty_scope(row, account)
        for row in observations
    ):
        return None
    if has_recorded_investments(
        space, account, when, anchor.details, since=anchor.economic_date
    ):
        return None
    flows = [
        line
        for line in cash_flows
        if rows[0].economic_date <= line.event.economic_date <= when
    ]
    if any(line.currency != account.currency for line in flows):
        return None
    later = [line for line in flows if line.event.economic_date > anchor.economic_date]
    if any(line.event.kind not in KNOWN_CASH_FLOWS for line in later):
        return None
    for observation in observations:
        included = set(observation.included_event_ids)
        if any(
            str(line.event_id) not in included
            for line in flows
            if line.event.economic_date <= observation.economic_date
        ):
            return None
        expected = anchor.equity + sum(
            (
                line.amount
                for line in later
                if line.event.economic_date <= observation.economic_date
            ),
            ZERO,
        )
        if observation.equity != expected:
            # Even a current empty intraday observation may include realised P&L.
            return None
    changes = [line for line in later if line.event.economic_date == when]
    capital = sum(
        (line.amount for line in changes if line.event.kind in EXTERNAL_FLOWS), ZERO
    )
    dividends = sum(
        (line.amount for line in changes if line.event.kind == "dividend"), ZERO
    )
    carried = anchor.equity + sum((line.amount for line in later), ZERO)
    opening = carried - sum((line.amount for line in changes), ZERO)
    basis = opening + sum(
        (
            max(line.amount, ZERO)
            for line in changes
            if line.event.kind in EXTERNAL_FLOWS
        ),
        ZERO,
    )
    latest = observations[-1]
    return {
        "amount": dividends,
        "basis": basis,
        "return_rate": dividends / basis if basis > ZERO else None,
        "capital_flow": capital,
        "dividends": dividends,
        "status": "estimated",
        "source": "cash_only_carry_forward",
        "price_basis": "estimate",
        "price_date": anchor.economic_date,
        "latest_observation_date": latest.economic_date,
        "observation_kind": "reference",
        "quantity_source": "no_recorded_positions",
        "cash_only_carry_forward": True,
        "settlement_pnl": ZERO,
        "published_at": None,
        "observed_at": latest.details.get("valuation_observed_at") or latest.created_at,
        "interval_start": when - timedelta(days=1),
        "message": "无已记录持仓，按资金流水延续；结算盈亏按 0 推算"
        if not dividends
        else "仅含已记录分红；无持仓期间的结算盈亏按 0 推算",
    }
