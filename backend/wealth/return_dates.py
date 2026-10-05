"""Read-only attribution of known fund shares; never move accounting events."""

from .common import DomainError, day


def analytical_movement(row, instrument, *, known_on):
    event = row.event
    reconstructed = (
        event.kind == "opening"
        and event.payload.get("history_mode") == "unchanged_holding"
    )
    effective = (
        day(event.payload["purchase_date"]) if reconstructed else event.economic_date
    )
    basis, error = "purchase_date" if reconstructed else "event_date", None
    if (
        event.kind == "fund_confirm"
        and instrument.kind == "fund"
        and (instrument.specification or {}).get("trading_channel") != "exchange"
        and event.payload.get("nav_date")
    ):
        try:
            nav_date = day(event.payload["nav_date"])
        except (DomainError, TypeError):
            error = "份额确认记录的成交净值日期无效，请核对交易记录"
        else:
            # A free-form NAV date is not proof of an earlier application.
            # Both readers preload this relation so daily histories do not
            # introduce one query per confirmation. A verified earlier
            # application can be supported later as its own explicit fact.
            debit = event.related
            if (
                not debit
                or debit.kind != "fund_debit"
                or debit.tenant_id != event.tenant_id
                or debit.payload.get("instrument_id") not in (None, str(instrument.pk))
            ):
                error = "成交净值日期缺少匹配的原申购扣款记录，请核对交易记录"
            elif nav_date < debit.economic_date:
                error = "成交净值日期早于原申购扣款日期，尚无可核实的更早申请记录"
            elif nav_date > event.economic_date:
                error = "成交净值日期晚于份额确认日期，请核对交易记录"
            elif event.economic_date <= known_on:
                effective, basis = nav_date, "nav_date"
    return {
        "date": effective,
        "date_basis": basis,
        "date_error": error,
        "quantity": row.quantity,
        "cost": row.cost,
        "event": event,
        "reconstructed": reconstructed,
        "created_at": row.created_at,
    }


def has_automatic_shares(space, movements, when):
    """Only engine-issued estimates carry the computed-share provenance."""
    for row in movements:
        event = row["event"]
        if (
            row["date"] <= when
            and event.kind == "fund_confirm"
            and event.payload.get("automatic_estimate") is True
            and (
                event.stage_key
                == f"{space.pk}:dca:{event.payload.get('dca_import_plan_id')}:{event.payload.get('dca_import_date')}:confirm"
                or event.stage_key.startswith(
                    f"{space.pk}:fund-order:{event.payload.get('fund_order_id')}:confirm:"
                )
            )
        ):
            return True
    return False
