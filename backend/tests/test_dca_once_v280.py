"""One-time DCA setup, automatic waiting, and stable holiday-shift identities."""

from datetime import date
from decimal import Decimal

import pytest
from test_dca_automation_v264 import book as shared_book
from test_dca_automation_v264 import quote
from wealth.dca_automation import (
    automation_status,
    occurrence_processing,
    run_plan,
)
from wealth.ledger import balance, position
from wealth.models import Event, Occurrence, Price, Resource
from wealth.planning import save_resource

pytestmark = pytest.mark.django_db
book = shared_book


def data(book, **extra):
    return {
        "name": "一次设置的基金定投",
        "kind": "dca",
        "account_id": str(book.holding.pk),
        "instrument_id": str(book.instrument.pk),
        "start_date": "2026-09-23",
        "end_date": "2026-09-23",
        "frequency": "daily",
        "amount": "10",
        "currency": "CNY",
        "status": "active",
        **extra,
    }


def automatic(book, **extra):
    return {
        "enabled": True,
        "start_date": "2026-09-23",
        "holding_account_id": str(book.holding.pk),
        "funding_source": "untracked",
        "fee_mode": "zero",
        **extra,
    }


def save(book, values, obj=None, *, run=True):
    return save_resource(
        book.space,
        book.user,
        "plans",
        values,
        obj,
        run_automatic=run,
    )


def test_new_plan_inherits_fund_defaults_and_finishes_without_period_confirmation(book):
    Resource.objects.create(
        tenant=book.space,
        kind="fund_trade_defaults",
        data={
            "instrument_id": str(book.instrument.pk),
            "account_id": str(book.holding.pk),
            "funding_source": "untracked",
            "fee_mode": "zero",
            "fee_value": "0",
        },
    )
    quote(book)
    plan = save(book, data(book))
    assert plan.data["automation"]["enabled"] is True
    assert plan.data["automation"]["start_date"] == "2026-09-23"
    assert position(book.space, book.holding, book.instrument) == (
        Decimal("5.56"),
        Decimal(10),
    )
    summary = automation_status(book.space, plan.pk)
    assert summary["completed_count"] == 1
    assert summary["needs_attention_count"] == 0
    assert summary["requires_confirmation"] is False
    assert summary["items"][0]["processing_state"] == "complete"
    assert summary["items"][0]["requires_action"] is False
    occurrence = Occurrence.objects.get(tenant=book.space, plan=plan)
    assert occurrence_processing(occurrence)["processing_state"] == "complete"
    before = Event.objects.filter(tenant=book.space).count()
    run_plan(book.space, book.user, plan.pk)
    assert Event.objects.filter(tenant=book.space).count() == before


def test_new_plan_does_not_require_a_second_start_date(book):
    config = automatic(book)
    del config["start_date"]
    plan = save(book, data(book, automation=config))
    assert plan.data["automation"]["start_date"] == plan.data["start_date"]
    status = automation_status(book.space, plan.pk)
    assert status["items"][0]["status"] == "waiting_nav"
    assert status["automatically_waiting_count"] == 1
    assert status["needs_attention_count"] == 0
    assert position(book.space, book.holding, book.instrument)[0] == 0
    quote(book)
    result = run_plan(book.space, book.user, plan.pk)
    assert result["items"][0]["processing_state"] == "complete"


def test_existing_disabled_or_missing_configuration_is_not_silently_enabled(book):
    disabled = save(book, data(book, automation={"enabled": False}))
    save(book, {"name": "仍保持关闭"}, disabled)
    disabled.refresh_from_db()
    assert disabled.data["automation"]["enabled"] is False
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 0
    old = Resource.objects.create(tenant=book.space, kind="plans", data=data(book))
    save(book, {"name": "只改旧计划名称"}, old)
    old.refresh_from_db()
    assert "automation" not in old.data
    pending = Occurrence.objects.get(tenant=book.space, plan=old)
    assert occurrence_processing(pending)["action_scope"] == "plan"
    assert occurrence_processing(pending)["requires_confirmation"] is False


def test_unknown_fee_requires_one_plan_setting_then_all_periods_finish(book):
    quote(book)
    plan = save(book, data(book, automation=automatic(book, fee_mode="unknown")))
    first = automation_status(book.space, plan.pk)["items"][0]
    assert first["status"] == "waiting_fee"
    assert first["action_scope"] == "plan"
    assert position(book.space, book.holding, book.instrument)[0] == 0
    save(
        book,
        {"automation": {**plan.data["automation"], "fee_mode": "zero"}},
        plan,
    )
    result = automation_status(book.space, plan.pk)
    assert result["needs_attention_count"] == 0
    assert result["completed_count"] == 1
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 1


def test_monthly_closed_date_rolls_forward_without_drifting_next_anchor(book):
    plan = save(
        book,
        data(
            book,
            start_date="2026-08-29",
            end_date="2026-09-29",
            frequency="monthly",
            automation=automatic(book, start_date="2026-08-29"),
        ),
        run=False,
    )
    rows = list(
        Occurrence.objects.filter(tenant=book.space, plan=plan).order_by("sequence")
    )
    assert plan.data["holiday_policy"] == "next_open"
    assert [row.details["scheduled_date"] for row in rows] == [
        "2026-08-29",
        "2026-09-29",
    ]
    assert [str(row.due_date) for row in rows] == ["2026-08-31", "2026-09-29"]
    run_plan(book.space, book.user, plan.pk)
    debit = Event.objects.get(tenant=book.space, kind="fund_debit")
    assert debit.economic_date == date(2026, 8, 31)
    assert debit.payload["dca_import_date"] == "2026-08-29"
    assert debit.stage_key.endswith(":2026-08-29:debit")


@pytest.mark.parametrize("frequency", ["daily", "weekly"])
def test_daily_and_weekly_closed_dates_are_skipped_by_default(book, frequency):
    plan = save(
        book,
        data(
            book,
            start_date="2026-08-29",
            end_date="2026-08-29",
            frequency=frequency,
            automation=automatic(book, start_date="2026-08-29"),
        ),
    )
    assert plan.data["holiday_policy"] == "skip"
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 0
    assert automation_status(book.space, plan.pk)["items"][0]["status"] == "excluded"


def test_two_shifted_periods_on_same_day_remain_distinct_and_idempotent(book):
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date="2026-08-31",
        kind="official_nav",
        value="2",
    )
    plan = save(
        book,
        data(
            book,
            start_date="2026-08-29",
            end_date="2026-08-30",
            frequency="daily",
            holiday_policy="next_open",
            automation=automatic(book, start_date="2026-08-29"),
        ),
    )
    debits = Event.objects.filter(tenant=book.space, kind="fund_debit")
    assert debits.count() == 2
    assert set(debits.values_list("economic_date", flat=True)) == {date(2026, 8, 31)}
    assert {row.payload["dca_import_date"] for row in debits} == {
        "2026-08-29",
        "2026-08-30",
    }
    assert position(book.space, book.holding, book.instrument) == (
        Decimal(10),
        Decimal(20),
    )
    run_plan(book.space, book.user, plan.pk)
    assert debits.count() == 2
    assert automation_status(book.space, plan.pk)["completed_count"] == 2


def test_excluded_monthly_anchor_is_not_shifted_or_recreated(book):
    plan = save(
        book,
        data(
            book,
            start_date="2026-08-29",
            end_date="2026-08-29",
            frequency="monthly",
            automation=automatic(
                book, start_date="2026-08-29", excluded_dates=["2026-08-29"]
            ),
        ),
    )
    occurrence = Occurrence.objects.get(tenant=book.space, plan=plan)
    assert occurrence.due_date == date(2026, 8, 29)
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 0


def test_unknown_calendar_waits_without_fabricated_payment_or_confirmation(
    book, monkeypatch
):
    monkeypatch.setattr(
        "wealth.subscription_calendar.subscription_day",
        lambda *args, **kwargs: {
            "is_open": None,
            "status": "unknown",
            "reason": "待更新",
        },
    )
    plan = save(book, data(book, automation=automatic(book)))
    status = automation_status(book.space, plan.pk)["items"][0]
    assert status["status"] == "waiting_calendar"
    assert status["requires_action"] is False
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 0
    assert balance(book.space, book.holding, "fund_transit") == 0


def test_pausing_plan_keeps_pending_paid_periods_automatically_completing(book):
    plan = save(book, data(book, automation=automatic(book)))
    save(book, {"status": "paused"}, plan)
    quote(book)
    result = run_plan(book.space, book.user, plan.pk)
    assert result["items"][0]["status"] == "recorded_estimate"
    assert result["items"][0]["requires_action"] is False
