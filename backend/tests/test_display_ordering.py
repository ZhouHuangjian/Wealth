"""Read-side date ordering has no effect on schedule or immutable cash facts."""

from datetime import date

import pytest
from test_api import app as shared_app
from wealth.common import tenant_context
from wealth.ledger import post_event
from wealth.models import (
    Event,
    FxRate,
    Instrument,
    Occurrence,
    Price,
    Resource,
    Snapshot,
)

pytestmark = pytest.mark.django_db
app = shared_app


@pytest.fixture
def recent_book(app, monkeypatch):
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2027, 1, 2))
    with tenant_context(app.space.pk):
        yield app


def income(book, when):
    return post_event(
        book.space,
        book.owner,
        {
            "kind": "income",
            "account_id": str(book.account.pk),
            "amount": "10",
            "currency": "CNY",
            "economic_date": when,
            "description": when,
        },
    )


def test_business_calendar_defaults_to_recent_days_and_never_creates_future_facts(
    recent_book,
):
    book = recent_book
    income(book, "2026-12-01")
    income(book, "2027-01-02")
    income(book, "2026-12-31")  # Older historical fact entered last.
    plan = Resource.objects.create(
        tenant=book.space,
        kind="plans",
        data={"name": "未来计划", "status": "active", "automation": {"enabled": False}},
    )
    future = Occurrence.objects.create(
        tenant=book.space,
        plan=plan,
        sequence=1,
        due_date="2027-01-10",
        amount="20",
        currency="CNY",
    )
    before = Event.objects.count(), Occurrence.objects.count(), book.space.revision
    response = book.client.get(book.base + "/calendar")
    assert response.status_code == 200, response.content
    data = response.json()
    assert (data["start"], data["end"]) == ("2026-12-04", "2027-01-02")
    assert [row["date"] for row in data["items"]] == ["2027-01-02", "2026-12-31"]
    upcoming = book.client.get(book.base + "/calendar", {"scope": "upcoming"}).json()
    assert (upcoming["start"], upcoming["end"]) == ("2027-01-02", "2027-02-01")
    assert upcoming["items"][0]["id"] == str(future.pk)
    assert upcoming["items"][0]["kind"] == "plan"
    assert (
        Event.objects.count(),
        Occurrence.objects.count(),
        book.space.revision,
    ) == before
    assert plan.data["automation"]["enabled"] is False


def test_calendar_custom_range_is_descending_and_rejects_reversed_range(recent_book):
    book = recent_book
    income(book, "2026-12-01")
    income(book, "2027-01-02")
    response = book.client.get(
        book.base + "/calendar", {"start": "2026-01-01", "end": "2027-12-31"}
    )
    assert [row["date"] for row in response.json()["items"]] == [
        "2027-01-02",
        "2026-12-01",
    ]
    invalid = book.client.get(
        book.base + "/calendar", {"start": "2027-01-02", "end": "2026-12-01"}
    )
    assert invalid.status_code == 422


def test_events_sort_by_business_day_before_pagination(recent_book):
    book = recent_book
    newest = income(book, "2027-01-02")
    oldest = income(book, "2026-12-01")
    middle = income(book, "2026-12-31")
    before = Event.objects.count()
    pages = [
        book.client.get(book.base + "/events", {"limit": 1, "offset": offset}).json()
        for offset in range(3)
    ]
    assert [page["items"][0]["id"] for page in pages] == [
        str(newest.pk),
        str(middle.pk),
        str(oldest.pk),
    ]
    assert len({page["items"][0]["id"] for page in pages}) == 3
    assert Event.objects.count() == before


@pytest.mark.parametrize(
    "kind,field",
    [
        ("goals", "target_date"),
        ("plans", "start_date"),
        ("loans", "first_due_date"),
        ("reconciliations", "as_of"),
    ],
)
def test_resource_dates_are_globally_sorted_and_unknowns_last(recent_book, kind, field):
    book = recent_book
    records = [
        Resource.objects.create(
            tenant=book.space, kind=kind, data={field: value, "name": value or "未知"}
        )
        for value in ("2027-01-02", "2026-12-01", "", "2026-12-31")
    ]
    pages = [
        book.client.get(book.base + "/" + kind, {"limit": 1, "offset": offset}).json()
        for offset in range(4)
    ]
    assert [page["items"][0]["id"] for page in pages] == [
        str(records[i].pk) for i in (0, 3, 1, 2)
    ]
    assert all(page["count"] == 4 for page in pages)


def test_occurrence_and_installment_display_order_retains_execution_identity(
    recent_book,
):
    book = recent_book
    plan = Resource.objects.create(
        tenant=book.space, kind="loans", data={"name": "贷款", "status": "active"}
    )
    rows = [
        Occurrence.objects.create(
            tenant=book.space,
            plan=plan,
            sequence=seq,
            due_date=when,
            amount="10",
            currency="CNY",
        )
        for seq, when in ((1, "2026-12-31"), (2, "2027-01-31"))
    ]
    before = list(Occurrence.objects.order_by("sequence").values())
    for path in ("occurrences", "installments"):
        response = book.client.get(book.base + "/" + path)
        assert [row["id"] for row in response.json()["items"]] == [
            str(rows[1].pk),
            str(rows[0].pk),
        ]
    assert list(Occurrence.objects.order_by("sequence").values()) == before


def test_budget_months_sort_across_years_and_before_slicing(recent_book):
    book = recent_book
    records = [
        Resource.objects.create(
            tenant=book.space, kind="budgets", data={"month": month}
        )
        for month in ("2027-01", "2026-11", "2026-12")
    ]
    pages = [
        book.client.get(book.base + "/budgets", {"limit": 1, "offset": offset}).json()
        for offset in range(3)
    ]
    assert [page["items"][0]["id"] for page in pages] == [
        str(records[i].pk) for i in (0, 2, 1)
    ]


def test_todo_dates_fall_back_without_promoting_unknown_dates(recent_book):
    book = recent_book
    records = [
        Resource.objects.create(tenant=book.space, kind="todos", data=data)
        for data in (
            {"due_date": "2027-01-02"},
            {"due_date": "", "economic_date": "2026-12-31"},
            {"date": "2026-12-01"},
            {"due_date": None},
        )
    ]
    pages = [
        book.client.get(book.base + "/todos", {"limit": 1, "offset": offset}).json()
        for offset in range(4)
    ]
    assert [page["items"][0]["id"] for page in pages] == [
        str(row.pk) for row in records
    ]


@pytest.mark.parametrize("kind", ["prices", "fx", "snapshots"])
def test_model_observations_order_by_business_date_before_pagination(recent_book, kind):
    book = recent_book
    instrument = Instrument.objects.create(
        tenant=book.space, code="SYNTHETIC", name="合成产品"
    )
    records = []
    for when in ("2027-01-02", "2026-12-01", "2026-12-31"):
        if kind == "prices":
            row = Price.objects.create(
                tenant=book.space,
                instrument=instrument,
                economic_date=when,
                value="1",
            )
        elif kind == "fx":
            row = FxRate.objects.create(
                tenant=book.space, base="USD", quote="CNY", economic_date=when, rate="7"
            )
        else:
            row = Snapshot.objects.create(
                tenant=book.space,
                account=book.account,
                economic_date=when,
                equity="100",
                currency="CNY",
                coverage="synthetic",
            )
        records.append(row)
    pages = [
        book.client.get(book.base + "/" + kind, {"limit": 1, "offset": offset}).json()
        for offset in range(3)
    ]
    assert [page["items"][0]["id"] for page in pages] == [
        str(records[i].pk) for i in (0, 2, 1)
    ]
