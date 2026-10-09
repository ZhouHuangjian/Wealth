"""Permanent regressions for the October system audit, using fixed evidence."""

import csv
import io
from datetime import date, datetime, timedelta, timezone as tz
from decimal import Decimal

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test.utils import CaptureQueriesContext

from audit_scenarios.test_system_audit_20261009 import (
    D0,
    D1,
    D2,
    D3,
    book,  # noqa: F401 -- shared fixed clock and controlled product calendar
    daily,
    nav,
    opening,
    plan,
    run,
    statement,
    test_aud001_completed_plan_must_finish_already_paid_period,  # noqa: F401
    test_aud002_actual_evidence_must_promote_daily_quantity_provenance,  # noqa: F401
    test_aud003_statement_nav_date_must_survive_confirmation_from_paid_record,  # noqa: F401
    test_aud004_recent_fetch_must_not_make_hours_old_estimate_current,  # noqa: F401
    test_aud005_waiting_cash_poll_must_not_change_ledger_revision,  # noqa: F401
    test_aud006_formal_reader_must_ignore_future_publication,  # noqa: F401
)
from wealth.fund_reconciliation import apply, preview
from wealth.dca_automation import occurrence_processing
from wealth.imports import create_batch, reverse_batch
from wealth.investments import holdings_summary, profit_calendar
from wealth.ledger import balance, reverse_event
from wealth.models import Event, Occurrence, Price, Resource, Workspace
from wealth.planning import save_resource
from wealth.reporting import formal_price, positions
from wealth.tasks import scan_all

pytestmark = pytest.mark.django_db


def dated_statement(b, nav_date, *, confirmation_date=D3, save_mapping=False):
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(
        [
            "code",
            "payment_date",
            "confirmation_date",
            "amount",
            "quantity",
            "nav",
            "fee",
            "external_id",
            "成交净值日期",
        ]
    )
    writer.writerow(
        [
            b.instrument.code,
            D1,
            confirmation_date,
            "102",
            "100",
            "1.02",
            "0",
            "dated-order",
            nav_date,
        ]
    )
    batch = create_batch(
        b.space,
        b.user,
        SimpleUploadedFile("dated.csv", stream.getvalue().encode()),
        "standard_fund",
        b.holding.pk,
    )
    view = preview(
        b.space,
        b.user,
        batch,
        {"account_id": str(b.holding.pk), "save_mapping": save_mapping},
    )
    return batch, view


def correct(b, batch, view):
    row = view["rows"][0]
    body = {
        key: view[key] for key in ("preview_version", "ledger_revision", "preview_hash")
    }
    body["decisions"] = [
        {
            "row_id": row["id"],
            "action": "correct",
            "debit_event_id": row["candidates"][0]["debit_event_id"],
            "reason": "Actual statement NAV date",
        }
    ]
    return apply(b.space, b.user, batch, body)


def test_statement_date_difference_requires_auditable_replacement(book):
    p = plan(book)
    nav(book, D1, "1.02")
    run(book, p)
    old = Event.objects.get(kind="fund_confirm")
    original = dict(old.payload)
    batch, view = dated_statement(book, D2, confirmation_date=D2)
    row = view["rows"][0]
    assert row["status"] == "review"
    assert row["candidates"][0]["link_allowed"] is False
    assert [d["field"] for d in row["candidates"][0]["differences"]] == ["nav_date"]
    assert correct(book, batch, view)["corrected"] == 1
    old.refresh_from_db()
    assert old.payload == original and hasattr(old, "reversal")
    replacement = Event.objects.get(kind="fund_confirm", reversal__isnull=True)
    assert replacement.payload["nav_date"] == str(D2)
    assert Event.objects.filter(kind="fund_debit").count() == 1
    assert Resource.objects.filter(kind="fund_statement_corrections").count() == 1


@pytest.mark.parametrize(
    "nav_date, confirmation_date, message",
    [
        (D0, D3, "早于申请日"),
        (D3, D2, "晚于份额确认日"),
        ("2026-10-02", D3, "尚未到达"),
        ("invalid", D3, "日期"),
    ],
)
def test_invalid_statement_nav_date_does_not_write_accounting(
    book, nav_date, confirmation_date, message
):
    run(book, plan(book))
    before = Event.objects.count()
    _batch, view = dated_statement(book, nav_date, confirmation_date=confirmation_date)
    assert view["rows"][0]["status"] == "error"
    assert message in str(view["rows"][0]["errors"])
    assert Event.objects.count() == before


def test_legacy_saved_mapping_detects_new_optional_nav_date(book):
    Resource.objects.create(
        tenant=book.space,
        kind="fund_statement_mappings",
        data={
            "account_id": str(book.holding.pk),
            "source": "standard_fund",
            "mapping": {"code": "code", "payment_date": "payment_date"},
        },
    )
    _batch, view = dated_statement(book, D1)
    assert view["mapping"]["nav_date"] == "成交净值日期"
    assert view["rows"][0]["normalized"]["nav_date"] == str(D1)


def test_omitted_nav_date_is_not_inherited_from_corrected_estimate(book):
    p = plan(book)
    nav(book, D1, "1.02")
    run(book, p)
    batch, view, _ = statement(book, quantity="99", fee="1.02")
    # An explicitly unmapped column means the source did not establish a date.
    mapping = {**view["mapping"], "nav_date": ""}
    view = preview(
        book.space,
        book.user,
        batch,
        {"account_id": str(book.holding.pk), "mapping": mapping},
    )
    correct(book, batch, view)
    actual = Event.objects.get(kind="fund_confirm", reversal__isnull=True)
    assert actual.payload["nav_date"] is None


def test_completed_plan_drains_paid_period_without_generating_new_periods(book):
    p = plan(book, end_date=str(D3))
    run(book, p)
    paid = list(Occurrence.objects.order_by("due_date"))
    assert len(paid) == 3
    save_resource(book.space, book.user, "plans", {"status": "completed"}, p)
    assert occurrence_processing(paid[0])["status"] == "waiting_nav"
    for row in paid:
        nav(book, row.due_date, "1.02")
    book.clock.update(day=date(2026, 10, 2))
    scan_all()
    scan_all()
    assert Event.objects.filter(kind="fund_debit").count() == 3
    # D3's expected confirmation is D4, now reached.
    assert Event.objects.filter(kind="fund_confirm").count() == 3
    assert Occurrence.objects.count() == 3
    assert balance(book.space, book.source, "cash") == 694


def test_completed_plan_does_not_debit_unpaid_intentions(book):
    book.source.frozen = 999
    book.source.save()
    p = plan(book)
    assert run(book, p)["items"][0]["status"] == "waiting_cash"
    save_resource(book.space, book.user, "plans", {"status": "completed"}, p)
    book.source.frozen = 0
    book.source.save()
    nav(book, D1, "1.02")
    scan_all()
    assert Event.objects.filter(kind__in=["fund_debit", "fund_confirm"]).count() == 0


@pytest.mark.parametrize("block", ["disabled", "cancelled", "reversed"])
def test_completed_plan_respects_explicit_automation_and_fact_blocks(book, block):
    p = plan(book)
    run(book, p)
    save_resource(book.space, book.user, "plans", {"status": "completed"}, p)
    if block == "disabled":
        p.refresh_from_db()
        save_resource(
            book.space,
            book.user,
            "plans",
            {"automation": {**p.data["automation"], "enabled": False}},
            p,
        )
    elif block == "cancelled":
        Occurrence.objects.update(status="cancelled")
    else:
        reverse_event(
            book.space,
            book.user,
            Event.objects.get(kind="fund_debit"),
            "Cancelled payment",
        )
    nav(book, D1, "1.02")
    scan_all()
    scan_all()
    assert Event.objects.filter(kind="fund_debit").count() == 1
    assert not Event.objects.filter(kind="fund_confirm").exists()


def verified_period(b):
    nav(b, D1, "1.02")
    p = plan(b)
    run(b, p)
    event = Event.objects.get(kind="fund_confirm")
    batch, view, body = statement(b, confirm=str(D2))
    apply(b.space, b.user, batch, body)
    nav(b, D2, "1.03")
    return event, batch


def test_daily_and_calendar_share_effective_evidence_and_revocation(book):
    event, batch = verified_period(book)
    original = dict(event.payload)
    count = Event.objects.count()
    assert daily(book, D2)["items"][0]["status"] == "confirmed"
    calendar = profit_calendar(book.space, str(D2), str(D2), selected_day=str(D2))
    assert calendar["details"][0]["status"] == "confirmed"
    reverse_batch(book.space, book.user, batch, "Wrong statement evidence")
    item = daily(book, D2)["items"][0]
    assert (
        item["quantity_source"] == "automatic_estimate"
        and item["status"] == "estimated"
    )
    calendar = profit_calendar(book.space, str(D2), str(D2), selected_day=str(D2))
    assert calendar["details"][0]["status"] == "estimated"
    event.refresh_from_db()
    assert event.payload == original and Event.objects.count() == count


def test_payment_only_evidence_does_not_verify_inferred_shares(book):
    nav(book, D1, "1.02")
    run(book, plan(book))
    batch, view, body = statement(book, quantity="", confirm=str(D2))
    row = view["rows"][0]
    assert row["status"] == "review"
    body["decisions"] = [
        {
            "row_id": row["id"],
            "action": "link",
            "debit_event_id": row["candidates"][0]["debit_event_id"],
        }
    ]
    apply(book.space, book.user, batch, body)
    nav(book, D2, "1.03")
    assert daily(book, D2)["items"][0]["quantity_source"] == "automatic_estimate"


def test_share_evidence_is_loaded_in_one_query_for_many_confirmations(book):
    from wealth.fund_reconciliation import actual_confirmation_ids

    event, _ = verified_period(book)
    with CaptureQueriesContext(connection) as queries:
        actual = actual_confirmation_ids(book.space, [event.pk] * 30)
    assert actual == {str(event.pk)}
    assert len(queries) == 1


@pytest.mark.parametrize(
    "minutes_old, expected", [(5, "2"), (21, None), (None, None), (-1, None)]
)
def test_today_estimate_requires_observation_time_even_after_fresh_fetch(
    book, minutes_old, expected
):
    opening(book)
    book.clock.update(day=D1, now=datetime(2026, 9, 29, 7, tzinfo=tz.utc))
    nav(book, D0, "1")
    stamp = (
        book.clock["now"] - timedelta(minutes=minutes_old)
        if minutes_old is not None
        else None
    )
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date=D1,
        kind="reference",
        value="1.02",
        published_at=stamp,
    )
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.instrument.pk),
            "refresh_status": "ready",
            "fetched_at": book.clock["now"].isoformat(),
        },
    )
    result = daily(book, D1)
    if expected is None:
        assert result["amount"] is None and result["known_amount"] is None
    else:
        assert Decimal(result["amount"]) == Decimal(expected)
    # Actual NAV supersedes the same-date reference, regardless of its age.
    nav(book, D1, "1.01")
    assert Decimal(daily(book, D1)["amount"]) == Decimal("1")


def test_future_formal_observation_becomes_available_without_rewriting_facts(book):
    opening(book)
    nav(book, D0, "1")
    future = nav(book, D1, "1.02", published_at=book.clock["now"] + timedelta(days=1))
    assert formal_price(book.space, book.instrument, D1).economic_date == D0
    assert positions(book.space, D1)[0]["price_date"] == D0
    assert holdings_summary(book.space, D1)["items"][0]["price_date"] == str(D0)
    assert daily(book, D1)["amount"] is None
    assert profit_calendar(book.space, str(D1), str(D1))["days"][0]["amount"] is None
    original_count = Event.objects.count()
    book.clock["now"] += timedelta(days=1)
    assert formal_price(book.space, book.instrument, D1).pk == future.pk
    assert positions(book.space, D1)[0]["price_date"] == D1
    assert holdings_summary(book.space, D1)["items"][0]["price_date"] == str(D1)
    assert Decimal(daily(book, D1)["amount"]) == 2
    assert Event.objects.count() == original_count
    assert Price.objects.count() == 2


def test_future_publication_does_not_stop_debit_but_delays_share_estimation(book):
    p = plan(book)
    nav(book, D1, "1.02", published_at=book.clock["now"] + timedelta(hours=1))
    assert run(book, p)["items"][0]["status"] == "waiting_nav"
    assert Event.objects.filter(kind="fund_debit").count() == 1
    assert not Event.objects.filter(kind="fund_confirm").exists()
    book.clock["now"] += timedelta(hours=1)
    run(book, p)
    run(book, p)
    confirmed = Event.objects.get(kind="fund_confirm")
    assert confirmed.payload["nav_date"] == str(D1)
    assert balance(book.space, book.source, "cash") == 898


def test_waiting_poll_updates_check_time_without_invalidating_financial_revision(book):
    book.clock.update(day=D1, now=datetime(2026, 9, 29, 4, tzinfo=tz.utc))
    book.source.frozen = 999
    book.source.save()
    p = plan(book)
    first = run(book, p)
    row = Occurrence.objects.get(plan=p)
    before = (
        Workspace.objects.get(pk=book.space.pk).revision,
        row.version,
        row.details,
    )
    book.clock["now"] += timedelta(minutes=5)
    latest = run(book, p)
    row.refresh_from_db()
    assert (
        Workspace.objects.get(pk=book.space.pk).revision,
        row.version,
        row.details,
    ) == before
    assert latest["last_checked_at"] == book.clock["now"].isoformat()
    assert latest["last_checked_at"] != first["last_checked_at"]
    # A true balance change wakes the existing period and still debits once.
    book.source.frozen = 0
    book.source.save()
    run(book, p)
    run(book, p)
    assert Event.objects.filter(kind="fund_debit").count() == 1
    assert balance(book.space, book.source, "cash") == 898


def test_changed_unpaid_plan_invalidates_old_processing_state_and_uses_new_amount(book):
    book.clock.update(day=D1, now=datetime(2026, 9, 29, 4, tzinfo=tz.utc))
    book.source.frozen = 950
    book.source.save()
    p = plan(book)
    assert run(book, p)["items"][0]["status"] == "waiting_cash"
    p = save_resource(book.space, book.user, "plans", {"amount": "10"}, p)
    run(book, p)
    debit = Event.objects.get(kind="fund_debit")
    assert Decimal(debit.payload["amount"]) == 10
    assert Occurrence.objects.get(plan=p).details["plan_version"] == p.version
