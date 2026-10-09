"""Fixed-clock evidence. Findings retain their original desired-behavior assertions.

This directory is outside pytest's default testpaths; execute both selections.
No xfail, skip, weakened expectations, real accounts or live market data.
The six repaired cases are also collected by tests/test_audit_repairs_20261009.py.
"""

import csv
import io
from datetime import date, datetime, timedelta, timezone as tz
from decimal import Decimal as D
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import Client
from django.utils import timezone

from wealth.common import DomainError, tenant_context
from wealth.daily_returns import daily_return_overview
from wealth.dca_automation import run_plan
from wealth.fund_reconciliation import apply, event_evidence, preview
from wealth.imports import create_batch
from wealth.investments import profit_calendar, record_holding
from wealth.ledger import balance, position, post_event
from wealth.market_quality import updated_quarantine
from wealth.models import (
    Account,
    Event,
    Instrument,
    Membership,
    Occurrence,
    Price,
    Resource,
    Workspace,
)
from wealth.planning import save_resource
from wealth.reporting import formal_price
from wealth.tasks import scan_all

pytestmark = pytest.mark.django_db
invariant = pytest.mark.audit_invariant
finding = pytest.mark.audit_finding
D0, D1, D2, D3 = [date(2026, 9, 28) + timedelta(days=i) for i in range(4)]


@pytest.fixture
def book(monkeypatch):
    clock = {"day": D3, "now": datetime(2026, 10, 1, 4, tzinfo=tz.utc)}
    monkeypatch.setattr("wealth.planning.today", lambda space: clock["day"])
    monkeypatch.setattr("wealth.fund_reconciliation.today", lambda space: clock["day"])
    monkeypatch.setattr(timezone, "localdate", lambda *args, **kwargs: clock["day"])
    monkeypatch.setattr(timezone, "now", lambda: clock["now"])

    def calendar(value, calendar_id="CN_EXCHANGE"):
        value = date.fromisoformat(str(value))
        if value.year != 2026 or calendar_id not in {"CN_EXCHANGE", "US_EQUITIES"}:
            return None
        return value.weekday() < 5 and value not in {date(2026, 9, 25)}

    for module in ("trading_calendar", "subscription_calendar", "valuation_calendar"):
        monkeypatch.setattr(f"wealth.{module}.is_trading_day", calendar)
    user = get_user_model().objects.create_user(
        "audit-owner", password="Audit-only-2026!"
    )
    space = Workspace.objects.create(name="Synthetic audit")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        source = Account.objects.create(
            tenant=space, name="Synthetic bank", kind="bank"
        )
        holding = Account.objects.create(
            tenant=space, name="Synthetic fund account", kind="fund"
        )
        instrument = Instrument.objects.create(
            tenant=space,
            name="Synthetic NAV fund",
            code="020602",
            kind="fund",
            specification={
                "confirmation_days": 1,
                "share_precision": 2,
                "subscription_calendar": "domestic",
            },
        )
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(source.pk),
                "economic_date": "2026-09-01",
                "amount": "1000",
            },
        )
        yield SimpleNamespace(
            space=space,
            user=user,
            source=source,
            holding=holding,
            instrument=instrument,
            clock=clock,
        )


def nav(b, day, value, **extra):
    return Price.objects.create(
        tenant=b.space,
        instrument=b.instrument,
        economic_date=day,
        kind="official_nav",
        value=value,
        source="synthetic",
        **extra,
    )


def opening(b):
    return record_holding(
        b.space,
        b.user,
        {
            "account_id": str(b.holding.pk),
            "instrument_id": str(b.instrument.pk),
            "quantity": "100",
            "cost": "100",
            "as_of": str(D0),
            "purchase_date": str(D0),
        },
    )


def plan(b, **extra):
    return save_resource(
        b.space,
        b.user,
        "plans",
        {
            "name": "Synthetic DCA",
            "kind": "dca",
            "account_id": str(b.source.pk),
            "instrument_id": str(b.instrument.pk),
            "start_date": str(D1),
            "end_date": str(D1),
            "frequency": "daily",
            "amount": "102",
            "currency": "CNY",
            "status": "active",
            "automation": {
                "enabled": True,
                "start_date": str(D1),
                "holding_account_id": str(b.holding.pk),
                "fee_mode": "zero",
            },
            **extra,
        },
    )


def run(b, p):
    return run_plan(b.space, b.user, p.pk)


def daily(b, day):
    return daily_return_overview(b.space, day)[0]


def statement(
    b,
    amount="102",
    quantity="100",
    price="1.02",
    fee="0",
    confirm=str(D3),
    order="audit-order-1",
):
    fields = [
        "code",
        "payment_date",
        "confirmation_date",
        "amount",
        "quantity",
        "nav",
        "fee",
        "external_id",
        "nav_date",
    ]
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(fields)
    writer.writerow(
        [
            b.instrument.code,
            str(D1),
            confirm,
            amount,
            quantity,
            price,
            fee,
            order,
            str(D1),
        ]
    )
    batch = create_batch(
        b.space,
        b.user,
        SimpleUploadedFile("audit.csv", stream.getvalue().encode()),
        "standard_fund",
        b.holding.pk,
    )
    view = preview(b.space, b.user, batch, {"account_id": str(b.holding.pk)})
    command = {
        key: view[key] for key in ("preview_version", "ledger_revision", "preview_hash")
    }
    return batch, view, command


@invariant
def test_case_a_late_nav_belongs_to_d1_without_new_money(book):
    opening(book)
    nav(book, D0, "1.00")
    nav(book, D1, "1.01")
    before = list(Event.objects.values_list("pk", "payload"))
    assert D(daily(book, D1)["amount"]) == D("1")
    assert daily(book, D3)["amount"] is None
    assert daily(book, D3)["items"][0]["latest_formal_return"]["return_date"] == str(D1)
    assert list(Event.objects.values_list("pk", "payload")) == before


@invariant
@pytest.mark.parametrize(
    "fee,quantity,expected_d1,expected_d2",
    [("0", "100", "2", "2"), ("1.02", "99", ".98", "1.99")],
)
def test_case_b_effective_shares_and_fee_are_at_nav_date(
    book, fee, quantity, expected_d1, expected_d2
):
    opening(book)
    debit = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.source.pk),
            "holding_account_id": str(book.holding.pk),
            "instrument_id": str(book.instrument.pk),
            "economic_date": str(D1),
            "amount": "102",
        },
    )
    confirmed = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_confirm",
            "account_id": str(book.holding.pk),
            "instrument_id": str(book.instrument.pk),
            "related_event_id": str(debit.pk),
            "economic_date": str(D3),
            "amount": "102",
            "quantity": quantity,
            "price": "1.02",
            "fee": fee,
            "nav_date": str(D1),
        },
    )
    for day, value in [(D0, "1"), (D1, "1.02"), (D2, "1.03")]:
        nav(book, day, value)
    assert D(daily(book, D1)["amount"]) == D(expected_d1)
    assert D(daily(book, D2)["amount"]) == D(expected_d2)
    assert D(profit_calendar(book.space, str(D1), str(D2))["days"][0]["amount"]) == D(
        expected_d1
    )
    assert position(book.space, book.holding, book.instrument, D2)[0] == 100
    assert balance(book.space, book.source, "fund_transit", D2) == 102
    confirmed.refresh_from_db()
    assert confirmed.economic_date == D3


@invariant
def test_debit_then_exact_nav_recovers_without_page_or_duplicate(book):
    p = plan(book)
    assert run(book, p)["items"][0]["status"] == "waiting_nav"
    assert balance(book.space, book.source, "cash") == 898
    nav(book, D2, "1.03")
    assert run(book, p)["items"][0]["status"] == "waiting_nav"
    nav(book, D1, "1.02")
    scan_all()
    assert run(book, p)["items"][0]["status"] == "recorded_estimate"
    for _ in range(3):
        scan_all()
    assert Event.objects.filter(kind="fund_debit").count() == 1
    assert Event.objects.filter(kind="fund_confirm").count() == 1
    assert position(book.space, book.holding, book.instrument) == (D(100), D(102))


@invariant
def test_future_forecast_never_persists_future_dca_occurrences(book):
    p = plan(book, end_date="2026-12-31")
    from wealth.planning import forecast

    before = Event.objects.count(), Occurrence.objects.count()
    forecast(book.space, {"start": str(D3), "horizon_days": 90})
    assert not Occurrence.objects.filter(plan=p, due_date__gt=D3).exists()
    assert (Event.objects.count(), Occurrence.objects.count()) == before


@invariant
def test_disabled_and_paused_choices_stay_off_and_paid_paused_stage_continues(book):
    p = plan(book, automation={"enabled": False})
    scan_all()
    assert not Event.objects.filter(kind="fund_debit").exists()
    p = save_resource(
        book.space,
        book.user,
        "plans",
        {
            "automation": {
                "enabled": True,
                "start_date": str(D1),
                "holding_account_id": str(book.holding.pk),
                "fee_mode": "zero",
            }
        },
        p,
    )
    assert run(book, p)["items"][0]["status"] == "waiting_nav"
    save_resource(book.space, book.user, "plans", {"status": "paused"}, p)
    nav(book, D1, "1.02")
    scan_all()
    assert Event.objects.filter(kind="fund_confirm").count() == 1


@invariant
def test_runtime_role_and_cross_space_reference_are_rejected(book):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"
        )
        role, superuser, bypass = cursor.fetchone()
    assert role == "wealth_app" and not superuser and not bypass
    foreign = Workspace.objects.create(name="Separate synthetic space")
    with tenant_context(foreign.pk):
        account = Account.objects.create(
            tenant=foreign, name="Foreign bank", kind="bank"
        )
    with pytest.raises(DomainError) as caught:
        post_event(
            book.space,
            book.user,
            {
                "kind": "transfer",
                "account_id": str(book.source.pk),
                "target_account_id": str(account.pk),
                "amount": "1",
                "economic_date": str(D1),
            },
        )
    assert caught.value.code == "not_found"


@invariant
def test_ordinary_user_api_save_runs_without_an_extra_confirmation(book):
    client = Client()
    client.force_login(book.user)
    payload = {
        "name": "API once",
        "kind": "dca",
        "account_id": str(book.source.pk),
        "instrument_id": str(book.instrument.pk),
        "start_date": str(D1),
        "end_date": str(D1),
        "frequency": "daily",
        "amount": "102",
        "automation": {
            "enabled": True,
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "zero",
        },
    }
    response = client.post(
        f"/api/v1/spaces/{book.space.pk}/plans",
        payload,
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="audit-once-api",
    )
    assert response.status_code == 200, response.content
    assert Event.objects.filter(kind="fund_debit").count() == 1
    repeat = client.post(
        f"/api/v1/spaces/{book.space.pk}/plans",
        payload,
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="audit-once-api",
    )
    assert repeat.status_code == 200
    assert Event.objects.filter(kind="fund_debit").count() == 1


@invariant
def test_known_conflict_never_clears_with_one_origin(book):
    conflict = {"kind": "official_nav", "economic_date": str(D1), "status": "conflict"}
    prior = updated_quarantine({}, [conflict], str(book.clock["now"]))
    single = {
        "kind": "official_nav",
        "economic_date": str(D1),
        "data_quality": {
            "status": "consistent",
            "agreeing_providers": ["eastmoney_fund", "akshare"],
            "usable_for_accounting": True,
        },
    }
    assert str(D1) in updated_quarantine(prior, [single], str(book.clock["now"]))
    single["data_quality"]["agreeing_providers"] = ["eastmoney_fund", "efunds_official"]
    assert str(D1) not in updated_quarantine(prior, [single], str(book.clock["now"]))


@invariant
def test_missing_day_remains_missing_and_formal_replaces_same_day_estimate(book):
    opening(book)
    nav(book, D0, "1")
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date=D1,
        kind="estimate",
        value="1.05",
    )
    assert D(daily(book, D1)["amount"]) == 5
    nav(book, D1, "1.02")
    assert D(daily(book, D1)["amount"]) == 2
    assert daily(book, D2)["amount"] is None
    nav(book, D3, "1.04")
    assert daily(book, D3)["amount"] is None


@invariant
def test_redemption_fee_and_late_settlement_do_not_create_extra_return(book):
    opening(book)
    redemption = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_redeem",
            "account_id": str(book.holding.pk),
            "instrument_id": str(book.instrument.pk),
            "economic_date": str(D1),
            "quantity": "50",
            "price": "1.02",
            "fee": ".50",
        },
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "settlement",
            "account_id": str(book.holding.pk),
            "target_account_id": str(book.source.pk),
            "related_event_id": str(redemption.pk),
            "economic_date": str(D3),
            "amount": "50.50",
        },
    )
    for day, value in [(D0, "1"), (D1, "1.02"), (D2, "1.03"), (D3, "1.03")]:
        nav(book, day, value)
    assert D(daily(book, D1)["amount"]) == D("1.50")
    assert D(daily(book, D2)["amount"]) == D(".50")
    assert D(daily(book, D3)["amount"]) == D(0)
    assert balance(book.space, book.holding, "receivable", D2) == D("50.50")
    assert balance(book.space, book.holding, "receivable", D3) == 0
    assert balance(book.space, book.source, "cash", D3) == D("1050.50")


@invariant
@pytest.mark.parametrize(
    "kind,expected_d1,expected_d2", [("reinvest", "2", "1.02"), ("split", "0", "1")]
)
def test_reinvestment_and_split_preserve_income_and_capital(
    book, kind, expected_d1, expected_d2
):
    opening(book)
    event = {
        "kind": kind,
        "account_id": str(book.holding.pk),
        "instrument_id": str(book.instrument.pk),
        "economic_date": str(D1),
    }
    event.update(
        {"quantity": "2", "price": "1"} if kind == "reinvest" else {"ratio": "2"}
    )
    post_event(book.space, book.user, event)
    prices = ["1", "1", "1.01"] if kind == "reinvest" else ["1", ".5", ".505"]
    for day, value in zip((D0, D1, D2), prices, strict=True):
        nav(book, day, value)
    assert D(daily(book, D1)["amount"]) == D(expected_d1)
    assert D(daily(book, D2)["amount"]) == D(expected_d2)
    assert balance(book.space, book.source, "cash") == 1000


@invariant
def test_actual_share_difference_is_reverse_replace_without_second_payment(book):
    opening(book)
    p = plan(book)
    nav(book, D1, "1.02")
    run(book, p)
    original = Event.objects.get(kind="fund_confirm")
    original_payload = original.payload.copy()
    batch, view, command = statement(book, quantity="99", fee="1.02")
    row = view["rows"][0]
    command["decisions"] = [
        {
            "row_id": row["id"],
            "action": "correct",
            "debit_event_id": row["candidates"][0]["debit_event_id"],
            "reason": "Synthetic actual fee evidence",
        }
    ]
    apply(book.space, book.user, batch, command)
    for _ in range(2):
        scan_all()
    original.refresh_from_db()
    assert original.payload == original_payload
    assert hasattr(original, "reversal")
    assert Event.objects.filter(kind="fund_debit").count() == 1
    assert balance(book.space, book.source, "cash") == 898
    assert position(book.space, book.holding, book.instrument)[0] == 199
    nav(book, D0, "1")
    nav(book, D2, "1.03")
    assert D(daily(book, D1)["amount"]) == D(".98")
    assert D(daily(book, D2)["amount"]) == D("1.99")


@finding
def test_aud001_completed_plan_must_finish_already_paid_period(book):
    p = plan(book)
    assert run(book, p)["items"][0]["status"] == "waiting_nav"
    save_resource(book.space, book.user, "plans", {"status": "completed"}, p)
    nav(book, D1, "1.02")
    scan_all()
    assert Event.objects.filter(kind="fund_confirm").count() == 1


@finding
def test_aud002_actual_evidence_must_promote_daily_quantity_provenance(book):
    p = plan(book)
    nav(book, D1, "1.02")
    run(book, p)
    batch, view, command = statement(book, confirm=str(D2))
    assert view["rows"][0]["status"] == "exact_match"
    apply(book.space, book.user, batch, command)
    confirmed = Event.objects.get(kind="fund_confirm")
    assert event_evidence(book.space, confirmed)["basis"] == "actual"
    nav(book, D2, "1.03")
    item = daily(book, D2)["items"][0]
    assert item["quantity_source"] != "automatic_estimate"
    assert item["status"] == "confirmed"


@finding
def test_aud003_statement_nav_date_must_survive_confirmation_from_paid_record(book):
    opening(book)
    p = plan(book)
    assert run(book, p)["items"][0]["status"] == "waiting_nav"
    batch, view, command = statement(book)
    row = view["rows"][0]
    command["decisions"] = [
        {
            "row_id": row["id"],
            "action": "correct",
            "debit_event_id": row["candidates"][0]["debit_event_id"],
            "reason": "Synthetic actual contract date",
        }
    ]
    apply(book.space, book.user, batch, command)
    confirmed = Event.objects.get(kind="fund_confirm")
    for day, value in [(D0, "1"), (D1, "1.02"), (D2, "1.03")]:
        nav(book, day, value)
    observed = {
        "nav_date": confirmed.payload.get("nav_date"),
        "d1": D(daily(book, D1)["amount"]),
        "d2": D(daily(book, D2)["amount"]),
    }
    assert observed == {"nav_date": str(D1), "d1": D(2), "d2": D(2)}


@finding
def test_aud004_recent_fetch_must_not_make_hours_old_estimate_current(
    book, monkeypatch
):
    from wealth import market_data

    opening(book)
    book.clock.update(day=D1, now=datetime(2026, 9, 29, 7, tzinfo=tz.utc))
    monkeypatch.setattr(market_data, "_now", lambda: book.clock["now"])
    quote = market_data._quote(
        {
            "code": "020602",
            "name": "Synthetic fund",
            "kind": "fund",
            "market": "CN",
            "currency": "CNY",
        },
        price="1.02",
        kind="estimate",
        published_at="2026-09-29T09:00:00+08:00",
    )
    assert quote["data_state"] == "delayed" and quote["status"] == "ok"
    nav(book, D0, "1")
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date=D1,
        kind="reference",
        value="1.02",
        published_at=datetime(2026, 9, 29, 1, tzinfo=tz.utc),
    )
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.instrument.pk),
            "refresh_status": "ready",
            "fetched_at": book.clock["now"].isoformat(),
            "quote": quote,
        },
    )
    assert daily(book, D1)["amount"] is None


@finding
def test_aud005_waiting_cash_poll_must_not_change_ledger_revision(book):
    book.clock.update(day=D1, now=datetime(2026, 9, 29, 4, tzinfo=tz.utc))
    book.source.frozen = D(999)
    book.source.save()
    p = plan(book)
    assert run(book, p)["items"][0]["status"] == "waiting_cash"
    before = Workspace.objects.get(pk=book.space.pk).revision
    run(book, p)
    assert Workspace.objects.get(pk=book.space.pk).revision == before


@finding
def test_aud006_formal_reader_must_ignore_future_publication(book):
    opening(book)
    nav(book, D0, "1")
    client = Client()
    client.force_login(book.user)
    response = client.post(
        f"/api/v1/spaces/{book.space.pk}/prices",
        {
            "instrument_id": str(book.instrument.pk),
            "economic_date": str(D1),
            "kind": "official_nav",
            "value": "1.02",
            "published_at": (book.clock["now"] + timedelta(days=1)).isoformat(),
            "source": "synthetic future publication",
        },
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="audit-future-publication",
    )
    assert response.status_code == 200, response.content
    assert formal_price(book.space, book.instrument, D1).economic_date == D0
    assert daily(book, D1)["amount"] is None
