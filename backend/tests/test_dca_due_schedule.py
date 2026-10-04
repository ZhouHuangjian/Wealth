"""DCA persists only due executions; future rules remain read-only forecasts."""

from datetime import date
from decimal import Decimal

import pytest
from test_dca_automation_v264 import book as shared_book
from wealth.common import audit, serial
from wealth.dca_automation import run_plan
from wealth.dca_schedule import (
    future_occurrence_cleanup_preview,
    prune_future_occurrences,
)
from wealth.ledger import position
from wealth.models import Audit, Event, Occurrence, Price, Resource, Workspace
from wealth.planning import _schedule_rows, forecast, generate_schedule, save_resource
from wealth.tasks import scan_all

pytestmark = pytest.mark.django_db
book = shared_book


def make_plan(book, **extra):
    return save_resource(
        book.space,
        book.user,
        "plans",
        {
            "name": "逐日生成的定投",
            "kind": "dca",
            "account_id": str(book.source.pk),
            "instrument_id": str(book.instrument.pk),
            "start_date": "2026-09-23",
            "frequency": "daily",
            "amount": "10",
            "currency": "CNY",
            "status": "active",
            "automation": {
                "enabled": True,
                "start_date": "2026-09-23",
                "holding_account_id": str(book.holding.pk),
                "fee_mode": "zero",
            },
            **extra,
        },
    )


def old_future_rows(book, plan, through=date(2026, 10, 15), *, proof=True):
    """Replay the old generator's stored rows and its existing audit proof."""
    rows = []
    existing = set(plan.occurrences.values_list("sequence", flat=True))
    for row in _schedule_rows(book.space, plan, through):
        if row["sequence"] in existing:
            continue
        rows.append(
            Occurrence.objects.create(
                tenant=book.space,
                created_by=book.user,
                plan=plan,
                sequence=row["sequence"],
                due_date=row["due_date"],
                amount=row["amount"],
                currency=plan.data["currency"],
                status="skipped" if row.get("auto_skip") else "scheduled",
                details=serial(
                    {
                        **row,
                        "account_id": plan.data["account_id"],
                        "liability_account_id": None,
                        "instrument_id": plan.data["instrument_id"],
                        "plan_kind": "dca",
                        "plan_version": plan.version,
                    }
                ),
            )
        )
    if proof:
        audit(
            book.space,
            book.user,
            "schedule.generated",
            plan,
            {
                "horizon": str(through),
                "plan_version": plan.version,
                "changed": len(rows),
            },
        )
    return rows


def test_new_plan_and_explicit_year_horizon_persist_only_due_periods(book):
    plan = make_plan(book)
    first = list(plan.occurrences.order_by("sequence"))
    assert [str(row.due_date) for row in first] == ["2026-09-23", "2026-09-24"]
    repeated = generate_schedule(book.space, book.user, plan, "2027-09-24")
    assert [row.pk for row in repeated] == [row.pk for row in first]
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 0


def test_future_start_has_no_rows_then_worker_catches_up_without_future_debits(
    book, monkeypatch
):
    plan = make_plan(
        book,
        start_date="2026-09-28",
        automation={
            "enabled": True,
            "start_date": "2026-09-28",
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "zero",
        },
    )
    assert not plan.occurrences.exists()
    scan_all()
    assert not plan.occurrences.exists()
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 9, 29))
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        kind="official_nav",
        economic_date="2026-09-28",
        value="2",
    )
    scan_all()
    assert list(
        plan.occurrences.order_by("due_date").values_list("due_date", flat=True)
    ) == [
        date(2026, 9, 28),
        date(2026, 9, 29),
    ]
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 2
    assert position(book.space, book.holding, book.instrument)[0] == Decimal(5)
    before = Event.objects.filter(tenant=book.space).count()
    scan_all()
    assert Event.objects.filter(tenant=book.space).count() == before
    assert not plan.occurrences.filter(due_date__gt="2026-09-29").exists()
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 9, 30))
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        kind="official_nav",
        economic_date="2026-09-29",
        value="2",
    )
    scan_all()
    assert position(book.space, book.holding, book.instrument)[0] == Decimal(10)


def test_shifted_monthly_anchor_is_created_on_actual_day_even_after_plan_end(
    book, monkeypatch
):
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 8, 29))
    plan = make_plan(
        book,
        start_date="2026-08-29",
        end_date="2026-08-29",
        frequency="monthly",
        automation={
            "enabled": True,
            "start_date": "2026-08-29",
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "zero",
        },
    )
    assert not plan.occurrences.exists()
    scenario = forecast(book.space, {"days": 30})
    assert any(row["date"] == "2026-08-31" for row in scenario["items"])
    assert not plan.occurrences.exists()
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 8, 31))
    run_plan(book.space, book.user, plan.pk)
    occurrence = plan.occurrences.get()
    assert occurrence.due_date == date(2026, 8, 31)
    assert occurrence.details["scheduled_date"] == "2026-08-29"
    assert occurrence.event.stage_key.endswith(":2026-08-29:debit")
    run_plan(book.space, book.user, plan.pk)
    assert plan.occurrences.count() == 1


def test_year_forecast_remains_virtual_without_inserting_or_mutating_rows(book):
    plan = make_plan(book)
    before = list(plan.occurrences.values())
    revision = Workspace.objects.get(pk=book.space.pk).revision
    result = forecast(book.space, {"days": 365})
    assert any(row["date"] > "2026-12-01" for row in result["items"])
    assert list(plan.occurrences.values()) == before
    assert Workspace.objects.get(pk=book.space.pk).revision == revision


def test_cleanup_removes_only_proven_untouched_future_rows_and_keeps_audit(book):
    plan = make_plan(book)
    future = old_future_rows(book, plan)
    expected = {row.pk for row in future}
    assert any(
        row.status == "skipped" and row.details["auto_skip"] is True for row in future
    )
    preview = future_occurrence_cleanup_preview(book.space, plan, date(2026, 9, 24))
    assert {row.pk for row in preview["candidates"]} == expected
    assert all(Occurrence.objects.filter(pk=key).exists() for key in expected)
    results = prune_future_occurrences(book.space, book.user, plan, date(2026, 9, 24))
    assert results["removed_count"] == len(expected) > 0
    assert plan.occurrences.filter(due_date__lte="2026-09-24").count() == 2
    assert not plan.occurrences.filter(due_date__gt="2026-09-24").exists()
    log = Audit.objects.get(tenant=book.space, action="dca.future_projections_retired")
    assert {row["id"] for row in log.detail["occurrences"]} == {
        str(key) for key in expected
    }
    assert all(
        row["details"]["plan_version"] == plan.version
        for row in log.detail["occurrences"]
    )
    assert (
        prune_future_occurrences(book.space, book.user, plan, date(2026, 9, 24))[
            "removed_count"
        ]
        == 0
    )
    assert (
        Audit.objects.filter(
            tenant=book.space, action="dca.future_projections_retired"
        ).count()
        == 1
    )


def test_cleanup_preserves_manual_pending_referenced_or_changed_future_rows(book):
    plan = make_plan(book)
    original = old_future_rows(book, plan, date(2026, 11, 30))
    rows = [row for row in original if row.status == "scheduled"][:7]
    rows[0].status = "pending"
    rows[0].save()
    rows[1].status = "skipped"
    rows[1].save()
    rows[2].version = 2
    rows[2].save()
    rows[3].details["note"] = "人工说明"
    rows[3].save()
    Resource.objects.create(
        tenant=book.space, kind="notes", data={"occurrence_id": str(rows[4].pk)}
    )
    audit(book.space, book.user, "occurrence.edited", rows[5], {"reason": "人工调整"})
    rows[6].details["plan_version"] = "not-a-version"
    rows[6].save()
    preserved = {row.pk for row in rows}
    prune_future_occurrences(book.space, book.user, plan, date(2026, 9, 24))
    assert (
        set(plan.occurrences.filter(pk__in=preserved).values_list("pk", flat=True))
        == preserved
    )


def test_cleanup_preserves_explicit_exclusions_pauses_and_touched_holiday_skips(book):
    plan = make_plan(
        book,
        automation={
            "enabled": True,
            "start_date": "2026-09-23",
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "zero",
            "excluded_dates": ["2026-09-26"],
            "pause_ranges": [{"start": "2026-09-28", "end": "2026-09-29"}],
        },
    )
    original = old_future_rows(book, plan)
    by_date = {str(row.due_date): row for row in original}
    # A later exclusion applies even though this occurrence still has its old,
    # untouched generated version and original plan-version proof.
    plan.data["automation"]["excluded_dates"].append("2026-09-30")
    plan.save(update_fields=["data"])
    by_date["2026-09-27"].version = 2
    by_date["2026-09-27"].save(update_fields=["version"])
    Resource.objects.create(
        tenant=book.space,
        kind="notes",
        data={"occurrence_id": str(by_date["2026-10-01"].pk)},
    )
    preserved = {
        "2026-09-26",
        "2026-09-27",
        "2026-09-28",
        "2026-09-29",
        "2026-09-30",
        "2026-10-01",
    }
    preview = future_occurrence_cleanup_preview(book.space, plan, date(2026, 9, 24))
    candidates = {str(row.due_date) for row in preview["candidates"]}
    assert not candidates.intersection(preserved)
    assert "2026-09-25" in candidates  # Untouched public holiday skip.
    prune_future_occurrences(book.space, book.user, plan, date(2026, 9, 24))
    assert set(
        plan.occurrences.filter(due_date__gt="2026-09-24").values_list(
            "due_date", flat=True
        )
    ) == {date.fromisoformat(value) for value in preserved}


def test_cleanup_does_not_touch_ordinary_expense_plans_or_unproven_rows(book):
    ordinary = make_plan(
        book, kind="expense", automation={"enabled": False}, end_date="2026-10-15"
    )
    before = ordinary.occurrences.count()
    assert before > 2
    assert (
        prune_future_occurrences(book.space, book.user, ordinary, date(2026, 9, 24))[
            "removed_count"
        ]
        == 0
    )
    assert ordinary.occurrences.count() == before
    plan = make_plan(book)
    old_future_rows(book, plan, proof=False)
    assert (
        prune_future_occurrences(book.space, book.user, plan, date(2026, 9, 24))[
            "removed_count"
        ]
        == 0
    )


def test_paused_plan_cleanup_preserves_status_and_worker_creates_no_payments(book):
    plan = make_plan(book)
    old_future_rows(book, plan)
    plan.data["status"] = "paused"
    plan.save(update_fields=["data"])
    scan_all()
    plan.refresh_from_db()
    assert plan.data["status"] == "paused"
    assert not plan.occurrences.filter(
        status="scheduled", due_date__gt="2026-09-24"
    ).exists()
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 0
