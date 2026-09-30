"""Planning integration: intentions cannot become cash facts without evidence."""

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model

from wealth.common import DomainError, tenant_context
from wealth.ledger import balance, post_event
from wealth.models import (
    Account,
    Event,
    FxRate,
    Instrument,
    JournalLine,
    Membership,
    Occurrence,
    Resource,
    ResourceRevision,
    Workspace,
)
from wealth.planning import (
    confirm_occurrence,
    forecast,
    generate_schedule,
    save_resource,
)

pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 1, 1))
    user = get_user_model().objects.create_user(
        username="planning-owner", password="planning-long-password"
    )
    space = Workspace.objects.create(name="规划测试空间", base_currency="CNY")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        bank = Account.objects.create(
            tenant=space,
            created_by=user,
            name="人民币银行",
            currency="CNY",
            frozen="3000",
        )
        loan = Account.objects.create(
            tenant=space, created_by=user, name="房贷", kind="loan", currency="CNY"
        )
        instrument = Instrument.objects.create(
            tenant=space,
            created_by=user,
            name="合成基金",
            code="TEST",
            kind="fund",
            currency="CNY",
        )
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(bank.pk),
                "amount": "10000",
                "economic_date": "2026-01-01",
            },
        )
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(loan.pk),
                "amount": "1200",
                "economic_date": "2026-01-01",
            },
        )
        yield SimpleNamespace(
            user=user, space=space, bank=bank, loan=loan, instrument=instrument
        )


def save(book, kind, data, obj=None):
    return save_resource(book.space, book.user, kind, data, obj)


def plan(book, **kwargs):
    return save(
        book,
        "plans",
        {
            "name": "月度计划",
            "kind": "expense",
            "status": "active",
            "account_id": str(book.bank.pk),
            "amount": "100",
            "currency": "CNY",
            "start_date": "2026-01-31",
            "frequency": "monthly",
            "count": 3,
            **kwargs,
        },
    )


def payment(book, amount="100", account=None, **extra):
    return post_event(
        book.space,
        book.user,
        {
            "kind": "expense",
            "account_id": str((account or book.bank).pk),
            "amount": amount,
            "economic_date": "2026-01-31",
            **extra,
        },
    )


def test_month_end_schedule_is_stable_and_never_posts_cash(book):
    count = JournalLine.objects.count()
    item = plan(book)
    first = generate_schedule(book.space, book.user, item)
    assert [row.due_date for row in first] == [
        date(2026, 1, 31),
        date(2026, 2, 28),
        date(2026, 3, 31),
    ]
    again = generate_schedule(book.space, book.user, item)
    assert [row.pk for row in first] == [row.pk for row in again]
    assert Occurrence.objects.filter(plan=item).count() == 3
    assert JournalLine.objects.count() == count
    assert balance(book.space, book.bank, "cash") == D("10000")


def test_paid_occurrence_keeps_identity_and_amount_after_future_plan_edit(book):
    item = plan(book)
    first = item.occurrences.get(sequence=1)
    actual = payment(book)
    confirm_occurrence(book.space, book.user, first, actual.pk)
    item = save(book, "plans", {"amount": "200"}, item)
    first.refresh_from_db()
    assert first.amount == D("100") and first.event_id == actual.pk
    assert item.occurrences.get(sequence=2).amount == D("200")
    assert ResourceRevision.objects.filter(resource=item).count() == 2
    assert (
        ResourceRevision.objects.get(resource=item, version=1).data["amount"] == "100"
    )


def test_occurrence_confirmation_reuses_event_does_not_post_or_accept_wrong_account(
    book,
):
    item = plan(book)
    first = item.occurrences.get(sequence=1)
    other = Account.objects.create(
        tenant=book.space, created_by=book.user, name="其他银行", currency="CNY"
    )
    wrong = payment(book, account=other)
    with pytest.raises(DomainError):
        confirm_occurrence(book.space, book.user, first, wrong.pk)
    actual = payment(book)
    count = JournalLine.objects.count()
    confirm_occurrence(book.space, book.user, first, actual.pk)
    confirm_occurrence(book.space, book.user, first, actual.pk)
    assert JournalLine.objects.count() == count
    with pytest.raises(DomainError):
        confirm_occurrence(
            book.space, book.user, item.occurrences.get(sequence=2), actual.pk
        )


def test_zero_rate_loan_future_replacement_preserves_actual_period(book):
    item = save(
        book,
        "loans",
        {
            "name": "零息贷款",
            "account_id": str(book.bank.pk),
            "liability_account_id": str(book.loan.pk),
            "principal": "1200",
            "annual_rate": "0",
            "term_months": 3,
            "currency": "CNY",
            "first_due_date": "2026-01-31",
            "method": "annuity",
        },
    )
    rows = generate_schedule(book.space, book.user, item)
    assert [row.amount for row in rows] == [D("400")] * 3
    actual = post_event(
        book.space,
        book.user,
        {
            "kind": "repayment",
            "account_id": str(book.bank.pk),
            "target_account_id": str(book.loan.pk),
            "amount": "400",
            "principal": "400",
            "interest": "0",
            "economic_date": "2026-01-31",
        },
    )
    confirm_occurrence(book.space, book.user, rows[0], actual.pk)
    with pytest.raises(DomainError):
        save(book, "loans", {"principal": "800", "term_months": 2}, item)
    item = save(
        book,
        "loans",
        {"principal": "800", "term_months": 2, "first_due_date": "2026-02-28"},
        item,
    )
    updated = generate_schedule(book.space, book.user, item)
    assert updated[0].pk == rows[0].pk and updated[0].event_id == actual.pk
    assert [row.sequence for row in updated] == [1, 2, 3]
    assert sum((row.amount for row in updated if not row.event_id), D("0")) == D("800")
    assert balance(book.space, book.bank, "cash") == D("9600")


def test_reserved_and_frozen_cash_overlap_is_counted_once_and_overallocation_rejected(
    book,
):
    reservation = save(
        book,
        "reservations",
        {
            "account_id": str(book.bank.pk),
            "amount": "4000",
            "currency": "CNY",
            "linked_freeze_amount": "2000",
        },
    )
    result = forecast(book.space, {"days": 30})
    assert D(result["opening_available"]) == D("5000")
    assert balance(book.space, book.bank, "cash") == D("10000")
    with pytest.raises(DomainError):
        save(
            book,
            "reservations",
            {"account_id": str(book.bank.pk), "amount": "6000", "currency": "CNY"},
        )
    with pytest.raises(DomainError):
        save(
            book,
            "reservations",
            {
                "account_id": str(book.bank.pk),
                "amount": "2000",
                "linked_freeze_amount": "2000",
                "currency": "CNY",
            },
        )
    reservation.refresh_from_db()
    assert reservation.data["amount"] == "4000"


def test_alternative_scenarios_do_not_accumulate_reservations(book):
    goal = save(
        book,
        "goals",
        {
            "name": "购房",
            "amount": "6000",
            "currency": "CNY",
            "target_date": "2026-01-20",
            "status": "active",
        },
    )
    one = save(
        book,
        "scenarios",
        {
            "goal_id": str(goal.pk),
            "name": "方案一",
            "amount": "6000",
            "currency": "CNY",
            "target_date": "2026-01-20",
            "status": "active",
        },
    )
    two = save(
        book,
        "scenarios",
        {
            "goal_id": str(goal.pk),
            "name": "方案二",
            "amount": "5000",
            "currency": "CNY",
            "target_date": "2026-01-20",
            "status": "draft",
        },
    )
    for scenario in (one, two):
        save(
            book,
            "reservations",
            {
                "account_id": str(book.bank.pk),
                "scenario_id": str(scenario.pk),
                "amount": "6000",
                "currency": "CNY",
            },
        )
    assert D(forecast(book.space, {"days": 30})["opening_available"]) == D("1000")
    two = save(book, "scenarios", {"status": "active"}, two)
    one.refresh_from_db()
    assert one.data["status"] == "draft"
    assert D(forecast(book.space, {"days": 30})["opening_available"]) == D("1000")
    assert D(
        forecast(book.space, {"days": 30, "scenario_id": str(one.pk)})[
            "opening_available"
        ]
    ) == D("1000")


def test_notes_preserve_published_original_and_reject_nested_foreign_links(book):
    note = save(
        book,
        "notes",
        {
            "title": "原始判断",
            "body": "当时依据",
            "status": "published",
            "tags": "红利,长期,红利",
        },
    )
    published_at = note.data["published_at"]
    note = save(book, "notes", {"body": "后来发现的反例"}, note)
    assert note.data["published_at"] == published_at
    assert (
        ResourceRevision.objects.get(resource=note, version=1).data["body"]
        == "当时依据"
    )
    assert note.data["tags"] == ["红利", "长期"]
    other = Workspace.objects.create(name="另一私人空间")
    with tenant_context(other.pk):
        account = Account.objects.create(
            tenant=other, created_by=book.user, name="私人账户", currency="CNY"
        )
    with pytest.raises(DomainError):
        save(
            book,
            "notes",
            {
                "title": "非法引用",
                "body": "正文",
                "links": [{"account_id": str(account.pk)}],
            },
        )


def test_reconciliation_uses_facts_and_cannot_claim_a_nonzero_difference_is_matched(
    book,
):
    count = JournalLine.objects.count()
    rec = save(
        book,
        "reconciliations",
        {
            "account_id": str(book.bank.pk),
            "kind": "balance",
            "as_of": "2026-01-01",
            "institution_value": "9999",
            "status": "matched",
        },
    )
    assert rec.data["status"] == "in_progress"
    assert D(rec.data["difference"]) == D("-1")
    debt = save(
        book,
        "reconciliations",
        {
            "account_id": str(book.loan.pk),
            "kind": "liability",
            "as_of": "2026-01-01",
            "institution_value": "1200",
        },
    )
    assert debt.data["status"] == "matched"
    assert D(debt.data["system_value"]) == D("1200")
    assert JournalLine.objects.count() == count


def test_forecast_is_read_only_excludes_confirmed_occurrences_and_marks_missing_fx(
    book,
):
    item = plan(book, start_date="2026-01-10", count=1)
    actual = payment(book, economic_date="2026-01-01")
    confirm_occurrence(
        book.space, book.user, item.occurrences.get(sequence=1), actual.pk
    )
    usd = Account.objects.create(
        tenant=book.space, created_by=book.user, name="美元现金", currency="USD"
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(usd.pk),
            "amount": "100",
            "economic_date": "2026-01-01",
        },
    )
    counts = (
        Event.objects.count(),
        JournalLine.objects.count(),
        Occurrence.objects.count(),
    )
    partial = forecast(book.space, {"days": 30})
    assert partial["is_forecast"] and partial["completeness"] == "partial"
    assert any("USD/CNY" in gap for gap in partial["gaps"])
    assert all(D(row["outflow"]) == D("0") for row in partial["items"])
    FxRate.objects.create(
        tenant=book.space,
        created_by=book.user,
        base="USD",
        quote="CNY",
        rate="7",
        economic_date="2026-01-01",
    )
    complete = forecast(book.space, {"days": 30})
    assert complete["completeness"] == "complete"
    assert D(complete["opening_cash"]) == D("10600")
    assert counts == (
        Event.objects.count(),
        JournalLine.objects.count(),
        Occurrence.objects.count(),
    )


def test_goal_payment_releases_the_same_reservation_in_forecast_without_double_deduction(
    book,
):
    goal = save(book, "goals", {"name": "装修", "status": "active", "currency": "CNY"})
    reservation = save(
        book,
        "reservations",
        {
            "account_id": str(book.bank.pk),
            "goal_id": str(goal.pk),
            "amount": "4000",
            "linked_freeze_amount": "2000",
            "currency": "CNY",
        },
    )
    save(
        book,
        "goals",
        {
            "payment_nodes": [
                {
                    "id": "deposit",
                    "date": "2026-01-10",
                    "amount": "4000",
                    "reservation_id": str(reservation.pk),
                }
            ]
        },
        goal,
    )
    result = forecast(book.space, {"days": 30})
    assert D(result["opening_available"]) == D("5000")
    assert D(result["closing_balance"]) == D("5000")
    assert balance(book.space, book.bank, "cash") == D("10000")


def test_goal_paid_node_cannot_use_income_or_allocate_more_than_actual_cash(book):
    income = post_event(
        book.space,
        book.user,
        {
            "kind": "income",
            "account_id": str(book.bank.pk),
            "amount": "100",
            "economic_date": "2026-01-01",
        },
    )
    with pytest.raises(DomainError):
        save(
            book,
            "goals",
            {
                "name": "错误付款",
                "currency": "CNY",
                "payment_nodes": [
                    {"date": "2026-01-01", "amount": "100", "event_id": str(income.pk)}
                ],
            },
        )
    actual = payment(book, amount="100", economic_date="2026-01-01")
    with pytest.raises(DomainError):
        save(
            book,
            "goals",
            {
                "name": "重复分配",
                "currency": "CNY",
                "payment_nodes": [
                    {
                        "id": "a",
                        "date": "2026-01-01",
                        "amount": "60",
                        "event_id": str(actual.pk),
                    },
                    {
                        "id": "b",
                        "date": "2026-01-01",
                        "amount": "60",
                        "event_id": str(actual.pk),
                    },
                ],
            },
        )
    assert Resource.objects.filter(kind="goals").count() == 0


def test_explicitly_skipped_plan_period_survives_rescanning_and_is_not_forecast(book):
    item = plan(book, start_date="2026-01-10", count=1)
    occurrence = item.occurrences.get(sequence=1)
    occurrence.status = "skipped"
    occurrence.save(update_fields=["status"])
    generate_schedule(book.space, book.user, item)
    occurrence.refresh_from_db()
    assert occurrence.status == "skipped"
    assert all(
        D(row["outflow"]) == D("0")
        for row in forecast(book.space, {"days": 30})["items"]
    )
