"""Account onboarding and dashboard amounts use the same recorded valuation basis."""

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from wealth.account_opening import initialize_account
from wealth.common import DomainError, tenant_context
from wealth.ledger import post_event
from wealth.models import Account, Event, FxRate, Membership, Snapshot, Workspace
from wealth.portfolio import net_worth_comparison
from wealth.reporting import overview

pytestmark = pytest.mark.django_db
TODAY = "2026-09-20"
YESTERDAY = "2026-09-19"
D = Decimal


@pytest.fixture
def book():
    user = get_user_model().objects.create_user("opening-v24-owner")
    space = Workspace.objects.create(name="账户资产回归", base_currency="CNY")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        yield SimpleNamespace(space=space, user=user)


def make_account(book, kind="bank", **kwargs):
    return Account.objects.create(
        tenant=book.space, name="期初验收", kind=kind, **kwargs
    )


def open_account(book, account, amount, **kwargs):
    return initialize_account(
        book.space,
        book.user,
        account,
        {"opening_balance": amount, "opening_date": TODAY, **kwargs},
    )


@pytest.mark.parametrize("amount", ["12000.35", "0"])
def test_same_day_bank_opening_is_displayed_without_inventing_yesterday(book, amount):
    account = make_account(book)
    assert open_account(book, account, amount) is True
    result = overview(book.space, TODAY)
    assert D(result["net_assets"]) == D(amount)
    assert D(result["accounts"][0]["value"]) == D(amount)
    comparison = net_worth_comparison(book.space, TODAY)
    assert D(comparison["estimated"]["net_assets"]) == D(amount)
    assert comparison["estimated"]["known_account_count"] == 1
    assert comparison["previous"]["net_assets"] is None
    assert comparison["previous"]["known_account_count"] == 0
    assert comparison["change"]["amount"] is None


@pytest.mark.parametrize("kind", ["futures", "future", "option", "options", "broker"])
def test_institution_opening_records_total_equity_once(book, kind):
    account = make_account(book, kind, valuation_mode="snapshot")
    assert (
        open_account(
            book,
            account,
            "12345.67",
            opening_coverage="机构客户总权益，含所有期权价值和持仓盈亏",
            opening_coverage_confirmed=True,
            opening_option_scope="includes_options",
            opening_available="4000",
        )
        is True
    )
    assert Snapshot.objects.filter(tenant=book.space, account=account).count() == 1
    assert Event.objects.filter(tenant=book.space).count() == 0
    result = overview(book.space, TODAY)
    assert D(result["net_assets"]) == D("12345.67")
    assert D(result["available_cash"]) == D("4000")
    assert result["accounts"][0]["value_basis"] == "institution"
    comparison = net_worth_comparison(book.space, TODAY)
    assert D(comparison["estimated"]["net_assets"]) == D("12345.67")
    assert comparison["previous"]["known_account_count"] == 0


def test_unconfirmed_equity_is_visible_as_known_part_without_invented_coverage(book):
    account = make_account(book, "futures")
    open_account(book, account, "5000", opening_coverage="终端显示权益，包含范围待核对")
    comparison = net_worth_comparison(book.space, TODAY)
    assert comparison["estimated"]["net_assets"] is None
    assert D(comparison["estimated"]["known_net_assets"]) == D("5000")
    assert comparison["estimated"]["known_account_count"] == 1
    row = Snapshot.objects.get(tenant=book.space)
    assert row.complete is False and row.includes_options is None


def test_snapshot_opening_requires_explicit_equity_scope(book):
    account = make_account(book, "futures")
    with pytest.raises(DomainError, match="包含范围"):
        open_account(book, account, "5000")
    assert Snapshot.objects.filter(tenant=book.space).count() == 0
    assert Event.objects.filter(tenant=book.space).count() == 0


@pytest.mark.parametrize("scope", [[], {}, "invalid"])
def test_invalid_opening_option_scope_is_validation_error(book, scope):
    account = make_account(book, "futures")
    with pytest.raises(DomainError, match="期初期权"):
        open_account(
            book,
            account,
            "5000",
            opening_coverage="客户权益",
            opening_option_scope=scope,
        )


def test_legacy_cash_opening_is_visible_but_not_mislabelled_total_equity(book):
    account = make_account(book, "futures")
    opening = post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(account.pk),
            "amount": "10000",
            "economic_date": TODAY,
        },
    )
    result = overview(book.space, TODAY)
    assert D(result["net_assets"]) == D("10000")
    assert result["completeness"] == "partial"
    assert result["accounts"][0]["value_basis"] == "recorded_cash"
    assert D(result["available_cash"]) == 0
    assert any("未包含" in gap for gap in result["gaps"])
    comparison = net_worth_comparison(book.space, TODAY)
    assert comparison["estimated"]["net_assets"] is None
    assert D(comparison["estimated"]["known_net_assets"]) == D("10000")
    Snapshot.objects.create(
        tenant=book.space,
        account=account,
        economic_date=TODAY,
        currency="CNY",
        equity="9800",
        coverage="全部客户权益",
        complete=True,
        includes_options=True,
        details={"available": "3800"},
    )
    final = overview(book.space, TODAY)
    assert D(final["net_assets"]) == D("9800")
    assert final["accounts"][0]["value_basis"] == "institution"
    opening.refresh_from_db()
    assert opening.payload["amount"] == "10000"


def test_no_snapshot_and_no_recorded_cash_stays_unknown(book):
    make_account(book, "futures")
    result = overview(book.space, TODAY)
    assert result["accounts"][0]["value"] is None
    assert result["accounts"][0]["base_value"] is None
    assert result["accounts"][0]["status"] == "unknown"
    comparison = net_worth_comparison(book.space, TODAY)
    assert comparison["estimated"]["known_account_count"] == 0


def test_foreign_amount_is_visible_locally_but_not_guessed_without_fx(book):
    account = make_account(book, currency="USD")
    open_account(book, account, "2000")
    result = overview(book.space, TODAY)
    assert D(result["accounts"][0]["value"]) == D("2000")
    assert result["accounts"][0]["base_value"] is None
    assert result["completeness"] == "partial"
    comparison = net_worth_comparison(book.space, TODAY)
    assert comparison["estimated"]["known_account_count"] == 0
    FxRate.objects.create(
        tenant=book.space, base="USD", quote="CNY", rate="7.1", economic_date=TODAY
    )
    assert D(net_worth_comparison(book.space, TODAY)["estimated"]["net_assets"]) == D(
        "14200"
    )


def test_archived_account_does_not_remove_its_historical_amount(book):
    account = make_account(book)
    open_account(book, account, "888")
    account.archived = True  # Historical imports can contain an archived account.
    account.save(update_fields=["archived"])
    assert D(overview(book.space, TODAY)["net_assets"]) == D("888")
    assert D(net_worth_comparison(book.space, TODAY)["estimated"]["net_assets"]) == D(
        "888"
    )


@pytest.mark.parametrize("kind", ["bank", "futures"])
def test_account_create_api_immediately_updates_both_home_endpoints(book, kind):
    client = Client()
    client.force_login(book.user)
    base = f"/api/v1/spaces/{book.space.pk}"
    body = {
        "name": "开户首页验收",
        "kind": kind,
        "currency": "CNY",
        "opening_balance": "3210.12",
        "opening_date": TODAY,
        **(
            {
                "opening_coverage": "客户全部权益，无期权持仓",
                "opening_coverage_confirmed": True,
                "opening_option_scope": "no_options",
                "opening_available": "3210.12",
            }
            if kind == "futures"
            else {}
        ),
    }
    key = str(uuid.uuid4())

    def create():
        return client.post(
            base + "/accounts",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=key,
        )

    response = create()
    assert response.status_code == 200, response.content
    assert create().json()["id"] == response.json()["id"]
    result = client.get(base + "/overview", {"as_of": TODAY}).json()
    assert D(result["net_assets"]) == D("3210.12")
    comparison = client.get(base + "/net-worth-comparison", {"as_of": TODAY}).json()
    assert D(comparison["estimated"]["net_assets"]) == D("3210.12")
    assert comparison["previous"]["known_account_count"] == 0


@pytest.mark.parametrize(
    "change", [{"currency": "USD"}, {"valuation_mode": "detailed"}, {"kind": "bank"}]
)
def test_snapshot_only_account_identity_cannot_remove_or_relabel_equity(book, change):
    account = make_account(book, "futures", valuation_mode="snapshot")
    open_account(
        book,
        account,
        "5000",
        opening_coverage="全部客户权益，无期权持仓",
        opening_coverage_confirmed=True,
        opening_option_scope="no_options",
    )
    client = Client()
    client.force_login(book.user)
    response = client.patch(
        f"/api/v1/spaces/{book.space.pk}/accounts/{account.pk}",
        data=json.dumps({"version": account.version, **change}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 422, response.content
    account.refresh_from_db()
    assert (account.kind, account.currency, account.valuation_mode) == (
        "futures",
        "CNY",
        "snapshot",
    )
    assert D(overview(book.space, TODAY)["net_assets"]) == D("5000")
