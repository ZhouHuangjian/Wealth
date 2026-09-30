"""Option observations stay private, versioned, and outside institution totals."""

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from wealth.common import DomainError, tenant_context
from wealth.investments import holdings_summary, profit_calendar, record_holding
from wealth.ledger import post_event
from wealth.models import (
    Account,
    Audit,
    Instrument,
    JournalLine,
    Membership,
    PositionMovement,
    Price,
    Resource,
    ResourceRevision,
    Snapshot,
    Workspace,
)
from wealth.option_positions import (
    has_option_reference,
    option_items,
    save_option_position,
)
from wealth.planning import save_resource
from wealth.portfolio import net_worth_comparison, portfolio_analysis
from wealth.reporting import overview

pytestmark = pytest.mark.django_db
D = Decimal
DATE = "2026-09-24"


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    user = get_user_model().objects.create_user("option-v251-owner")
    space = Workspace.objects.create(name="期权参考验收")
    Membership.objects.create(workspace=space, user=user, role="owner")
    client = Client()
    client.force_login(user)
    with tenant_context(space.pk):
        account = Account.objects.create(
            tenant=space, name="广发期货", kind="futures", valuation_mode="snapshot"
        )
        instrument = Instrument.objects.create(
            tenant=space,
            name="豆粕沽3300",
            code="m2701-P-3300",
            kind="option",
            market="DCE",
        )
        yield SimpleNamespace(
            user=user,
            space=space,
            account=account,
            instrument=instrument,
            client=client,
        )


def payload(book, **extra):
    return {
        "account_id": str(book.account.pk),
        "instrument_id": str(book.instrument.pk),
        "side": "long",
        "quantity": "2",
        "contract_multiplier": "10",
        "opening_price": "80",
        "current_value": "2000",
        "purchase_date": "2026-09-01",
        "as_of": DATE,
        **extra,
    }


def save(book, **extra):
    return save_option_position(book.space, book.user, payload(book, **extra))


def send(book, path, body, method="post", key=None):
    return getattr(book.client, method)(
        f"/api/v1/spaces/{book.space.pk}{path}",
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
    )


def snapshot(book, includes=True):
    return Snapshot.objects.create(
        tenant=book.space,
        account=book.account,
        economic_date=DATE,
        currency="CNY",
        equity="10000",
        coverage="客户总权益",
        complete=True,
        includes_options=includes,
        details={
            "valuation_basis": "settlement",
            "available": "5000",
            "no_option_positions": not includes,
        },
    )


@pytest.mark.parametrize(
    "side,profit,signed", [("long", "400", "2000"), ("short", "-400", "-2000")]
)
def test_long_and_short_reference_math_never_writes_journal_or_shared_price(
    book, side, profit, signed
):
    row = save(book, side=side)
    assert D(row["opening_premium"]) == D("1600")
    assert D(row["reference_profit"]) == D(profit)
    assert D(row["signed_market_value"]) == D(signed)
    assert row["profit_rate"] is None
    assert row["contributes"] is False and row["is_reference_position"] is True
    assert (
        JournalLine.objects.count()
        == PositionMovement.objects.count()
        == Price.objects.count()
        == 0
    )
    assert ResourceRevision.objects.count() == 1
    assert Audit.objects.filter(action="option_position.saved").count() == 1


def test_equity_containing_options_is_never_increased_by_reference_values(book):
    snapshot(book)
    before = overview(book.space, DATE)
    calendar_before = profit_calendar(book.space, DATE, DATE)["summary"]
    allocation_before = portfolio_analysis(book.space, DATE)
    save(book)
    after = overview(book.space, DATE)
    assert D(after["net_assets"]) == D(before["net_assets"]) == D("10000")
    assert after["available_cash"] == before["available_cash"]
    assert profit_calendar(book.space, DATE, DATE)["summary"] == calendar_before
    assert (
        portfolio_analysis(book.space, DATE)["total_value"]
        == allocation_before["total_value"]
    )
    report = holdings_summary(book.space, DATE)
    assert report["items"] == [] and len(report["reference_items"]) == 1
    assert holdings_summary(book.space, DATE, kind="fund")["reference_items"] == []


def test_detailed_account_with_option_reference_has_an_explicit_coverage_gap(book):
    book.account.kind, book.account.valuation_mode = "broker", "detailed"
    book.account.save()
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(book.account.pk),
            "amount": "10000",
            "economic_date": DATE,
        },
    )
    save(book)
    result = net_worth_comparison(book.space, DATE)
    assert result["estimated"]["net_assets"] is None
    assert D(result["estimated"]["known_net_assets"]) == D("10000")
    assert any("期权" in gap for gap in result["estimated"]["gaps"])
    assert overview(book.space, DATE)["completeness"] == "partial"


def test_snapshot_claiming_no_options_conflicts_with_recorded_reference(book):
    snapshot(book, includes=False)
    save(book)
    report = net_worth_comparison(book.space, DATE)
    assert report["estimated"]["net_assets"] is None
    assert any("已记录期权持仓" in gap for gap in report["estimated"]["gaps"])
    Snapshot.objects.create(
        tenant=book.space,
        account=book.account,
        economic_date="2026-09-23",
        currency="CNY",
        equity="9900",
        coverage="客户权益",
        complete=True,
        includes_options=False,
        details={"no_option_positions": True, "valuation_basis": "settlement"},
    )
    calendar = profit_calendar(book.space, DATE, DATE)
    assert calendar["summary"]["amount"] is None
    assert calendar["summary"]["status"] == "unavailable"


def test_zero_market_and_settlement_values_and_explicit_clear_are_valid(book):
    row = save(book, current_value="0", settlement_price="0", settlement_date=DATE)
    assert row["settlement_price"] == "0"
    changed = save_option_position(
        book.space,
        book.user,
        {"version": row["version"], "settlement_price": None, "settlement_date": None},
        ident=row["id"],
    )
    assert changed["settlement_price"] is None
    assert changed["settlement_date"] is None


@pytest.mark.parametrize(
    "extra",
    [
        {"quantity": "0"},
        {"quantity": "1.5"},
        {"contract_multiplier": "0"},
        {"contract_multiplier": None},
        {"opening_price": "-1"},
        {"current_value": "-1"},
        {"side": "put"},
        {"settlement_price": "1"},
        {"settlement_date": DATE},
        {"settlement_price": "0", "settlement_date": "2026-09-25"},
        {"purchase_date": "2026-09-25"},
        {"as_of": "2099-01-01"},
    ],
)
def test_invalid_inputs_fail_atomically(book, extra):
    with pytest.raises(DomainError):
        save(book, **extra)
    assert Resource.objects.filter(kind="option_positions").count() == 0


def test_duplicate_side_is_rejected_but_long_short_are_independent(book):
    save(book)
    with pytest.raises(DomainError) as caught:
        save(book)
    assert caught.value.code == "option_position_exists"
    save(book, side="short")
    assert len(option_items(book.space, DATE)) == 2


def test_version_conflicts_and_historical_reference_are_preserved(book):
    row = save(book)
    changed = save_option_position(
        book.space,
        book.user,
        {"version": 1, "as_of": "2026-09-25", "current_value": "2200"},
        ident=row["id"],
    )
    assert changed["version"] == 2
    with pytest.raises(DomainError):
        save_option_position(
            book.space,
            book.user,
            {"version": 1, "current_value": "3000"},
            ident=row["id"],
        )
    assert D(option_items(book.space, DATE)[0]["current_value"]) == D("2000")
    save_option_position(
        book.space,
        book.user,
        {
            "version": 2,
            "status": "closed",
            "as_of": "2026-09-26",
            "closed_date": "2026-09-26",
        },
        ident=row["id"],
    )
    assert option_items(book.space, "2026-09-26") == []
    assert has_option_reference(
        book.space, account_id=book.account.pk, when=DATE, active_only=True
    )
    assert not has_option_reference(
        book.space, account_id=book.account.pk, when="2026-09-26", active_only=True
    )
    assert ResourceRevision.objects.count() == 3


def test_generic_json_resource_and_full_cost_ledger_paths_remain_forbidden(book):
    with pytest.raises(DomainError):
        save_resource(book.space, book.user, "option_positions", payload(book))
    with pytest.raises(DomainError, match="期货、期权"):
        record_holding(book.space, book.user, {**payload(book), "cost": "1600"})


def test_cross_tenant_and_currency_sources_are_rejected(book):
    other_space = Workspace.objects.create(name="他人空间")
    with tenant_context(other_space.pk):
        other = Account.objects.create(
            tenant=other_space,
            name="其他期货",
            kind="futures",
            valuation_mode="snapshot",
        )
    with pytest.raises(DomainError):
        save(book, account_id=str(other.pk))
    book.account.currency = "USD"
    book.account.save()
    with pytest.raises(DomainError, match="币种"):
        save(book)


def test_api_retries_and_viewer_permissions(book):
    first = send(book, "/option-holdings", payload(book), key="same-create")
    again = send(book, "/option-holdings", payload(book), key="same-create")
    assert first.status_code == again.status_code == 200, first.content
    assert first.json() == again.json()
    row = first.json()
    edit = {"version": 1, "current_value": "2100"}
    assert (
        send(
            book, f"/option-holdings/{row['id']}", edit, "patch", "same-edit"
        ).status_code
        == 200
    )
    assert (
        send(
            book, f"/option-holdings/{row['id']}", edit, "patch", "same-edit"
        ).status_code
        == 200
    )
    Membership.objects.filter(workspace=book.space, user=book.user).update(
        role="viewer"
    )
    assert (
        send(book, "/option-holdings", payload(book, side="short")).status_code == 403
    )


def test_product_and_reference_creation_are_atomic(book):
    body = {
        "name": "豆粕沽3400",
        "code": "m2701-P-3400",
        "market": "DCE",
        "kind": "option",
        "currency": "CNY",
        "account_ids": [str(book.account.pk)],
        "option_position": {
            k: v for k, v in payload(book, quantity="0").items() if k != "instrument_id"
        },
    }
    response = send(book, "/instruments", body)
    assert response.status_code == 422, response.content
    assert not Instrument.objects.filter(code__icontains="3400").exists()
    body["option_position"]["quantity"] = "2"
    response = send(book, "/instruments", body, key="product-create-once")
    assert response.status_code == 200, response.content
    assert response.json()["option_position"]["instrument_id"] == response.json()["id"]
    assert (
        send(book, "/instruments", body, key="product-create-once").json()
        == response.json()
    )


def test_reference_prevents_identity_changes_and_account_archiving(book):
    row = save(book)
    assert (
        send(
            book,
            f"/accounts/{book.account.pk}",
            {"version": 1, "currency": "USD"},
            "patch",
        ).status_code
        == 422
    )

    assert (
        send(
            book,
            f"/accounts/{book.account.pk}",
            {"version": 1, "archived": True},
            "patch",
        ).status_code
        == 422
    )
    assert (
        send(
            book,
            f"/instruments/{book.instrument.pk}",
            {"version": 1, "currency": "USD"},
            "patch",
        ).status_code
        == 422
    )
    linked = book.client.get(
        f"/api/v1/spaces/{book.space.pk}/instruments/{book.instrument.pk}"
    ).json()
    assert str(book.account.pk) in linked["account_ids"]
    assert (
        send(
            book,
            f"/option-holdings/{row['id']}",
            {"version": 1, "side": "short"},
            "patch",
        ).status_code
        == 422
    )


def test_nested_product_patch_rolls_back_on_reference_version_conflict(book):
    row = save(book)
    result = send(
        book,
        f"/instruments/{book.instrument.pk}",
        {
            "version": 1,
            "name": "不应留下的产品名称",
            "option_position": {
                "id": row["id"],
                "version": 99,
                "current_value": "2100",
            },
        },
        "patch",
    )
    assert result.status_code == 409, result.content
    book.instrument.refresh_from_db()
    assert book.instrument.name == "豆粕沽3300"
    assert book.instrument.version == 1
    assert Resource.objects.get(pk=row["id"]).version == 1


def test_nested_product_patch_replay_is_idempotent(book):
    row = save(book)
    body = {
        "version": 1,
        "option_position": {
            "id": row["id"],
            "version": 1,
            "current_value": "2100",
        },
    }
    first = send(
        book, f"/instruments/{book.instrument.pk}", body, "patch", "nested-update-once"
    )
    again = send(
        book, f"/instruments/{book.instrument.pk}", body, "patch", "nested-update-once"
    )
    assert first.status_code == again.status_code == 200, first.content
    assert first.json() == again.json()
    assert first.json()["option_position"]["version"] == 2
    assert ResourceRevision.objects.filter(resource_id=row["id"]).count() == 2


def test_closing_keeps_market_value_date_and_past_coverage(book):
    row = save(book)
    closed = save_option_position(
        book.space,
        book.user,
        {"version": 1, "status": "closed", "as_of": DATE},
        ident=row["id"],
    )
    assert closed["as_of"] == DATE
    assert closed["closed_date"] > DATE
    assert D(option_items(book.space, DATE)[0]["current_value"]) == D("2000")
    assert option_items(book.space) == []
