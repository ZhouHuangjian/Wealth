"""Holding dates, NAV dates and intraday institution equity stay distinguishable."""

import json
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from wealth.account_opening import initialize_account
from wealth.common import DomainError, tenant_context
from wealth.investments import holdings_summary, profit_calendar, record_holding
from wealth.models import (
    Account,
    Instrument,
    Membership,
    Price,
    Resource,
    Snapshot,
    Workspace,
)
from wealth.portfolio import net_worth_comparison
from wealth.valuation_basis import validate_snapshot_basis

pytestmark = pytest.mark.django_db
D = Decimal
TODAY = "2026-09-24"
PRIOR = "2026-09-23"


@pytest.fixture
def book():
    user = get_user_model().objects.create_user("valuation-v25-owner")
    space = Workspace.objects.create(name="计值日期核对")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        fund_account = Account.objects.create(
            tenant=space, name="摩根基金", kind="fund"
        )
        fund = Instrument.objects.create(
            tenant=space, name="摩根纳指", code="019172", kind="fund"
        )
        yield SimpleNamespace(
            space=space, user=user, account=fund_account, futures=None, fund=fund
        )


def holding(book, **extra):
    return record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "as_of": TODAY,
            "purchase_date": "2026-09-01",
            "quantity": "10",
            "cost": "80",
            "current_value": "100",
            "valuation_basis": "formal",
            "valuation_date": PRIOR,
            **extra,
        },
    )


def quote(book, when=TODAY, value="11", kind="official_nav"):
    return Price.objects.create(
        tenant=book.space,
        instrument=book.fund,
        economic_date=when,
        value=value,
        kind=kind,
        source="confirmed-fixture",
    )


def equity(book, when=TODAY, amount="100", basis="intraday", **details):
    future_account(book)
    return Snapshot.objects.create(
        tenant=book.space,
        account=book.futures,
        economic_date=when,
        currency="CNY",
        equity=amount,
        coverage="客户总权益，无期权持仓",
        complete=True,
        includes_options=False,
        details={"no_option_positions": True, "valuation_basis": basis, **details},
    )


def future_account(book):
    if book.futures is None:
        book.futures = Account.objects.create(
            tenant=book.space,
            name="广发期货",
            kind="futures",
            valuation_mode="snapshot",
        )
    return book.futures


def test_manual_nav_uses_real_price_date_without_backdating_the_holding(book):
    result = holding(book, valuation_observed_at="2026-09-24T12:00:00+08:00")
    row = result["holding"]
    assert row["price_date"] == PRIOR
    assert row["valuation_recorded_as_of"] == TODAY
    assert row["valuation_basis"] == "formal"
    assert holdings_summary(book.space, PRIOR)["items"] == []
    comparison = net_worth_comparison(book.space, TODAY)
    assert comparison["previous"]["net_assets"] is None
    assert D(comparison["estimated"]["net_assets"]) == D("100")
    source = next(
        x for x in comparison["estimated"]["source_dates"] if x["instrument_id"]
    )
    assert source["date"] == PRIOR
    assert source["recorded_as_of"] == TODAY
    assert source["basis"] == "manual_formal"
    assert source["name"] == source["instrument_name"] == "摩根纳指"
    assert source["observed_at"] == "2026-09-24T12:00:00+08:00"


def test_today_entry_of_old_nav_does_not_mask_a_newer_nav(book):
    holding(book)
    quote(book)
    row = holdings_summary(book.space, TODAY)["items"][0]
    assert D(row["market_value"]) == D("110")
    assert row["price_date"] == TODAY
    assert row["price_kind"] == "official_nav"


def test_evening_same_day_official_nav_is_valid_without_assuming_t_minus_one(book):
    row = holding(
        book, valuation_date=TODAY, valuation_observed_at="2026-09-24T22:30:00+08:00"
    )["holding"]
    assert row["price_date"] == TODAY
    assert D(row["market_value"]) == D("100")


@pytest.mark.parametrize("basis,value_date", [("estimate", TODAY), ("unknown", None)])
def test_reference_manual_total_never_becomes_formal_or_yesterdays_wealth(
    book, basis, value_date
):
    row = holding(book, valuation_basis=basis, valuation_date=value_date)["holding"]
    assert row["market_value"] is None
    assert D(row["estimate_value"]) == D("100")
    assert row["estimate_basis"] == basis
    assert row["estimate_date"] == value_date
    comparison = net_worth_comparison(book.space, TODAY)
    assert comparison["previous"]["net_assets"] is None
    assert comparison["estimated"]["formal_net_assets"] is None
    assert D(comparison["estimated"]["net_assets"]) == D("100")
    assert comparison["estimated"]["reference_delta"] is None
    source = next(
        x for x in comparison["estimated"]["source_dates"] if x["instrument_id"]
    )
    assert source["basis"] == f"manual_{basis}"


def test_formal_same_date_replaces_a_manual_estimate(book):
    holding(book, valuation_basis="estimate", valuation_date=TODAY)
    quote(book)
    row = holdings_summary(book.space, TODAY)["items"][0]
    assert D(row["market_value"]) == D("110")
    assert row["estimate_value"] is None


def test_manual_nav_never_creates_a_shared_price_or_fabricates_daily_profit(book):
    holding(book)
    assert Price.objects.count() == 0
    stored = Resource.objects.get(kind="holding_valuations")
    assert stored.data["economic_date"] == TODAY
    assert stored.data["valuation_date"] == PRIOR
    report = profit_calendar(book.space, TODAY, TODAY)
    assert report["summary"]["amount"] is None


@pytest.mark.parametrize(
    "extra",
    [
        {"valuation_date": None},
        {"valuation_date": "2026-09-25"},
        {"valuation_basis": "settlement"},
        {"valuation_basis": []},
        {"valuation_observed_at": "2026-09-24T12:00:00"},
        {"valuation_observed_at": "2099-09-24T12:00:00+08:00"},
    ],
)
def test_bad_manual_basis_or_dates_are_rejected_before_writing(book, extra):
    with pytest.raises(DomainError):
        holding(book, **extra)
    assert Resource.objects.filter(kind="holding_valuations").count() == 0


def test_intraday_equity_is_available_only_in_today_reference(book):
    equity(book, valuation_observed_at="2026-09-24T14:00:00+08:00")
    report = net_worth_comparison(book.space, TODAY)
    assert report["previous"]["net_assets"] is None
    assert report["estimated"]["formal_net_assets"] is None
    assert D(report["estimated"]["net_assets"]) == D("100")
    source = next(
        x
        for x in report["estimated"]["source_dates"]
        if x["account_id"] == str(book.futures.pk)
    )
    assert source["basis"] == "institution_estimate"
    assert source["observed_at"] == "2026-09-24T14:00:00+08:00"
    daily = profit_calendar(book.space, TODAY, TODAY)
    assert daily["summary"]["amount"] is None
    assert daily["summary"]["status"] == "unavailable"


def test_prior_intraday_equity_is_not_a_settled_yesterday_value(book):
    equity(book, when=PRIOR)
    report = net_worth_comparison(book.space, TODAY)
    assert report["previous"]["net_assets"] is None
    assert report["estimated"]["formal_net_assets"] is None


def test_settlement_and_intraday_observations_for_same_day_stay_separate(book):
    equity(book, amount="90", basis="settlement")
    equity(book, amount="100", basis="intraday")
    report = net_worth_comparison(book.space, TODAY)
    assert D(report["estimated"]["formal_net_assets"]) == D("90")
    assert D(report["estimated"]["net_assets"]) == D("100")
    assert D(report["estimated"]["reference_delta"]) == D("10")


def test_equity_opening_retains_user_selected_basis_and_calendar(book):
    future_account(book)
    initialize_account(
        book.space,
        book.user,
        book.futures,
        {
            "opening_balance": "100",
            "opening_date": TODAY,
            "opening_coverage": "客户总权益，无期权持仓",
            "opening_coverage_confirmed": True,
            "opening_option_scope": "no_options",
            "opening_valuation_basis": "intraday",
            "opening_valuation_observed_at": "2026-09-24T14:00:00+08:00",
            "opening_calendar_id": "CN_FUTURES",
        },
    )
    snapshot = Snapshot.objects.get(account=book.futures)
    assert snapshot.details["valuation_basis"] == "intraday"
    assert snapshot.details["calendar_id"] == "CN_FUTURES"
    assert (
        net_worth_comparison(book.space, TODAY)["estimated"]["formal_net_assets"]
        is None
    )


def test_verified_holiday_carries_settlement_without_inventing_a_new_date(book):
    equity(book, basis="settlement", calendar_id="CN_FUTURES")
    report = net_worth_comparison(book.space, "2026-09-27")
    assert D(report["previous"]["net_assets"]) == D("100")
    assert D(report["estimated"]["formal_net_assets"]) == D("100")
    source = next(
        x
        for x in report["estimated"]["source_dates"]
        if x["account_id"] == str(book.futures.pk)
    )
    assert source["date"] == TODAY
    assert source["holiday_carry_forward"] is True


def test_holiday_never_promotes_intraday_or_unknown_equity_to_settlement(book):
    equity(book, basis="intraday", calendar_id="CN_FUTURES")
    report = net_worth_comparison(book.space, "2026-09-27")
    assert report["estimated"]["formal_net_assets"] is None
    assert report["previous"]["net_assets"] is None


def test_unknown_calendar_does_not_assume_weekends_are_verified_closed(book):
    equity(book, basis="settlement", positions=[{"quantity": "1"}])
    report = net_worth_comparison(book.space, "2026-09-27")
    assert report["estimated"]["formal_net_assets"] is None
    assert report["previous"]["net_assets"] is None


def test_public_snapshot_basis_helper_validates_nested_and_top_level_fields():
    values = validate_snapshot_basis(
        {
            "details": {
                "valuation_basis": "settlement",
                "calendar_id": "CN_FUTURES",
                "valuation_observed_at": "2026-09-24T16:00:00+08:00",
            }
        }
    )
    assert values["valuation_basis"] == "settlement"
    assert values["calendar_id"] == "CN_FUTURES"
    with pytest.raises(DomainError):
        validate_snapshot_basis(
            {"valuation_basis": "intraday", "calendar_id": "invented"}
        )
    assert validate_snapshot_basis({}) == {}


def test_institution_allocation_with_unknown_value_keeps_total_only_in_estimate(book):
    initialize_account(
        book.space,
        book.user,
        book.account,
        {"opening_balance": "120", "opening_date": TODAY},
    )
    holding(
        book, funding_mode="allocate", valuation_basis="unknown", valuation_date=None
    )
    report = net_worth_comparison(book.space, TODAY)
    assert D(report["estimated"]["net_assets"]) == D("120")
    assert report["estimated"]["formal_net_assets"] is None
    assert D(report["estimated"]["known_net_assets"]) == D("120")


@pytest.mark.parametrize("basis,status", [("intraday", 200), ("official_nav", 422)])
def test_snapshot_api_applies_valuation_metadata_validation(book, basis, status):
    account = future_account(book)
    client = Client()
    client.force_login(book.user)
    result = client.post(
        f"/api/v1/spaces/{book.space.pk}/snapshots",
        data=json.dumps(
            {
                "account_id": str(account.pk),
                "economic_date": TODAY,
                "currency": "CNY",
                "equity": "100",
                "coverage": "客户总权益",
                "coverage_confirmed": True,
                "includes_options": False,
                "no_option_positions": True,
                "valuation_basis": basis,
                "calendar_id": "CN_FUTURES",
                "valuation_observed_at": "2026-09-24T14:00:00+08:00",
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="equity-basis-once",
    )
    assert result.status_code == status, result.content
    if status == 200:
        assert result.json()["details"]["valuation_basis"] == "intraday"
        assert result.json()["details"]["calendar_id"] == "CN_FUTURES"
    else:
        assert Snapshot.objects.filter(account=account).count() == 0
