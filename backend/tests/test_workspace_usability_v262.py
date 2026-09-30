"""Reported usability regressions, with real postings and tenant isolation."""

import json
import uuid
from datetime import date
from decimal import Decimal as D
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from wealth.common import DomainError, tenant_context
from wealth.dca_history import history_preview
from wealth.insights import save_configuration
from wealth.investment_trades import confirm_fund_trade, record_trade
from wealth.ledger import balance, event_detail, position, post_event
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
from wealth.planning import generate_schedule, save_resource
from wealth.portfolio import portfolio_analysis
from wealth.subscription_calendar import subscription_day, subscription_rule
from wealth.trading_calendar import preview_trade_dates

pytestmark = pytest.mark.django_db


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    user = get_user_model().objects.create_user("usability-owner")
    space = Workspace.objects.create(name="可用性回归")
    Membership.objects.create(workspace=space, user=user, role="owner")
    client = Client()
    client.force_login(user)
    with tenant_context(space.pk):
        account = Account.objects.create(tenant=space, kind="fund", name="基金账户")
        broker = Account.objects.create(tenant=space, kind="broker", name="证券账户")
        fund = Instrument.objects.create(
            tenant=space,
            code="017641",
            name="摩根标普500人民币A",
            kind="fund",
            market="CN",
        )
        stock = Instrument.objects.create(
            tenant=space, code="600000", name="合成股票", kind="stock", market="CN"
        )
        for a in (account, broker):
            post_event(
                space,
                user,
                {
                    "kind": "opening",
                    "account_id": str(a.pk),
                    "amount": "1000",
                    "economic_date": "2026-08-03",
                },
            )
        yield SimpleNamespace(
            user=user,
            space=space,
            client=client,
            account=account,
            broker=broker,
            fund=fund,
            stock=stock,
        )


def trade(book, **values):
    return record_trade(
        book.space,
        book.user,
        {
            "instrument_id": str(book.fund.pk),
            "account_id": str(book.account.pk),
            "side": "buy",
            "quantity": "10",
            "price": "2",
            "economic_date": "2026-09-04",
            **values,
        },
    )


def plan(book):
    return save_resource(
        book.space,
        book.user,
        "plans",
        {
            "name": "每日定投",
            "kind": "dca",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "amount": "10",
            "currency": "CNY",
            "start_date": "2026-09-04",
            "end_date": "2026-09-08",
            "frequency": "daily",
            "status": "active",
        },
    )


def test_confirmed_fund_buy_and_sell_update_cash_cost_and_units_once(book):
    trade(book)
    assert balance(book.space, book.account, "cash") == D("980")
    assert balance(book.space, book.account, "fund_transit") == 0
    assert position(book.space, book.account, book.fund) == (D("10"), D("20"))
    trade(
        book, side="sell", quantity="4", price="3", fee="1", economic_date="2026-09-08"
    )
    assert balance(book.space, book.account, "cash") == D("991")
    assert position(book.space, book.account, book.fund) == (D("6"), D("12"))
    assert balance(book.space, book.account, "receivable") == 0


def test_pending_fund_buy_remains_transit_until_actual_confirmation(book):
    record_trade(
        book.space,
        book.user,
        {
            "instrument_id": str(book.fund.pk),
            "account_id": str(book.account.pk),
            "side": "buy",
            "amount": "20",
            "pending": True,
            "economic_date": "2026-09-04",
        },
    )
    assert position(book.space, book.account, book.fund)[0] == 0
    assert balance(book.space, book.account, "fund_transit") == 20
    debit = Event.objects.get(tenant=book.space, kind="fund_debit")
    assert event_detail(debit)["next_stage"]["kind"] == "fund_confirm"
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_confirm",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "related_event_id": str(debit.pk),
            "quantity": "10",
            "price": "2",
            "economic_date": "2026-09-08",
        },
    )
    assert "next_stage" not in event_detail(debit)
    assert balance(book.space, book.account, "cash") == 980


def test_unsettled_stock_trade_does_not_invent_payment(book):
    result = trade(
        book,
        instrument_id=str(book.stock.pk),
        account_id=str(book.broker.pk),
        settled=False,
    )
    assert balance(book.space, book.broker, "cash") == 1000
    assert balance(book.space, book.broker, "payable") == -20
    assert result["items"][0]["next_stage"]["kind"] == "settlement"
    post_event(
        book.space,
        book.user,
        {
            "kind": "settlement",
            "account_id": str(book.broker.pk),
            "related_event_id": result["items"][0]["id"],
            "economic_date": "2026-09-08",
        },
    )
    assert balance(book.space, book.broker, "cash") == 980


def test_oversell_and_insufficient_cash_are_atomic(book):
    original = Event.objects.filter(tenant=book.space).count()
    for changes in [{"quantity": "1000"}, {"side": "sell"}]:
        with pytest.raises(DomainError):
            trade(book, **changes)
        assert Event.objects.filter(tenant=book.space).count() == original
        assert balance(book.space, book.account, "cash") == 1000


def test_zero_or_excess_precision_fees_and_future_trades_fail(book):
    for changes in [
        {"quantity": "0"},
        {"fee": "0.001"},
        {"price": "-1"},
        {"economic_date": "2099-01-01"},
        {"pending": "false"},
    ]:
        with pytest.raises(DomainError):
            trade(book, **changes)


def test_trade_command_replay_does_not_duplicate_and_viewer_is_denied(book):
    url = f"/api/v1/spaces/{book.space.pk}/investment-trades"
    body = {
        "instrument_id": str(book.fund.pk),
        "account_id": str(book.account.pk),
        "side": "buy",
        "quantity": "10",
        "price": "2",
        "economic_date": "2026-09-04",
    }
    key = str(uuid.uuid4())
    for _ in range(2):
        response = book.client.post(
            url,
            data=json.dumps(body),
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=key,
        )
        assert response.status_code in (200, 201), response.content
    assert position(book.space, book.account, book.fund)[0] == 10
    viewer = get_user_model().objects.create_user("usability-viewer")
    Membership.objects.create(workspace=book.space, user=viewer, role="viewer")
    book.client.force_login(viewer)
    assert (
        book.client.post(
            url,
            data=json.dumps(body),
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code
        == 403
    )


def test_foreign_tenant_product_is_rejected(book):
    other = Workspace.objects.create(name="另一个空间")
    with tenant_context(other.pk):
        product = Instrument.objects.create(
            tenant=other, name="其他产品", code="999999", kind="fund"
        )
    with pytest.raises(DomainError):
        trade(book, instrument_id=str(product.pk))


def test_late_single_tag_refreshes_existing_holdings_and_overlap_is_not_double_counted(
    book,
):
    trade(book)
    Price.objects.create(
        tenant=book.space,
        instrument=book.fund,
        value="2",
        economic_date="2026-09-04",
        kind="official_nav",
    )
    a = save_configuration(
        book.space,
        book.user,
        "investment_tags",
        {"name": "美股", "instrument_ids": [str(book.fund.pk)], "target_weight": "100"},
    )
    result = portfolio_analysis(book.space, "2026-09-04")
    assert result["holdings"][0]["primary_tag_id"] == a["id"]
    b = save_configuration(
        book.space,
        book.user,
        "investment_tags",
        {"name": "指数", "instrument_ids": [str(book.fund.pk)], "target_weight": "0"},
    )
    assert (
        portfolio_analysis(book.space, "2026-09-04")["holdings"][0]["primary_tag_id"]
        is None
    )
    book.fund.specification = {"allocation_tag_id": a["id"]}
    book.fund.save()
    result = portfolio_analysis(book.space, "2026-09-04")
    assert result["holdings"][0]["primary_tag_id"] == a["id"]
    assert sum(D(g["known_value"]) for g in result["groups"]) == D("20")
    assert b["id"] != a["id"]


def test_product_side_label_is_also_an_automatic_single_group(book):
    trade(book)
    tag = Resource.objects.create(
        tenant=book.space, kind="investment_tags", data={"name": "美股"}
    )
    book.fund.specification = {"tag_ids": [str(tag.pk)]}
    book.fund.save()
    assert portfolio_analysis(book.space, "2026-09-04")["holdings"][0][
        "primary_tag_id"
    ] == str(tag.pk)


def test_occurrences_read_with_generated_details_and_complete_in_one_entry(book):
    p = plan(book)
    response = book.client.get(f"/api/v1/spaces/{book.space.pk}/occurrences")
    assert response.status_code == 200, response.content
    rows = response.json()["items"]
    assert len(rows) == 5
    monday = next(r for r in rows if r["due_date"] == "2026-09-07")
    assert monday["status"] == "skipped" and monday["auto_skip"]
    first = p.occurrences.get(sequence=1)
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "amount": "10",
            "economic_date": "2026-09-04",
            "occurrence_id": str(first.pk),
        },
    )
    first.refresh_from_db()
    assert first.status == "confirmed"
    generate_schedule(book.space, book.user, p, "2026-09-08")
    first.refresh_from_db()
    assert first.status == "confirmed"
    assert balance(book.space, book.account, "cash") == 990


def test_historical_dca_skips_us_holiday_without_mutating_old_facts(book):
    p = plan(book)
    for when in ["2026-09-04", "2026-09-08"]:
        Price.objects.create(
            tenant=book.space,
            instrument=book.fund,
            value="2",
            economic_date=when,
            kind="official_nav",
        )
    count = Event.objects.filter(tenant=book.space).count()
    preview = history_preview(
        book.space,
        p.pk,
        {
            "start": "2026-09-04",
            "end": "2026-09-08",
            "as_of": "2026-09-08",
            "fee_mode": "zero",
        },
    )
    assert preview["summary"]["scheduled_count"] == 2
    assert "2026-09-07" in preview["closed_dates"]
    assert Event.objects.filter(tenant=book.space).count() == count


def test_us_closure_rules_do_not_close_unrelated_qdii_or_listed_etfs():
    us = {"kind": "fund", "market": "CN", "name": "摩根标普500", "code": "017641"}
    assert subscription_day("2026-09-07", us)["is_open"] is False
    assert subscription_day("2026-09-08", us)["is_open"] is True
    assert subscription_day("2026-09-25", us)["is_open"] is False
    assert subscription_day("2027-01-04", us)["is_open"] is None
    assert subscription_day("2026-11-27", us)["is_open"] is True  # US half day
    assert subscription_day("2026-09-07", {**us, "kind": "etf"})["is_open"] is True
    assert (
        subscription_day(
            "2026-09-07", {**us, "name": "日本精选QDII", "code": "007280"}
        )["is_open"]
        is True
    )
    assert (
        subscription_day(
            "2026-09-07", {**us, "specification": {"subscription_calendar": "domestic"}}
        )["is_open"]
        is True
    )


def test_fund_date_preview_uses_chinese_application_date_and_joint_open_day():
    result = preview_trade_dates(
        {
            "instrument": {
                "kind": "fund",
                "code": "019172",
                "name": "摩根纳斯达克100人民币A",
            },
            "application_at": "2026-09-07T09:00:00+08:00",
        }
    )
    assert result["trade_date"] == "2026-09-08"
    assert result["subscription_rule"]["calendar_ids"] == ["CN_EXCHANGE", "US_EQUITIES"]


def test_small_share_rounding_does_not_leave_fractional_cash_or_payables(book):
    trade(book, quantity="5.56", price="1.7987")
    assert balance(book.space, book.account, "cash") == D("990.00")
    assert balance(book.space, book.account, "fund_transit") == 0
    assert position(book.space, book.account, book.fund) == (D("5.56"), D("10"))
    trade(
        book,
        instrument_id=str(book.stock.pk),
        account_id=str(book.broker.pk),
        quantity="0.123",
        price="113.35",
    )
    assert balance(book.space, book.broker, "cash") == D("986.06")
    assert balance(book.space, book.broker, "payable") == 0
    trade(
        book,
        instrument_id=str(book.stock.pk),
        account_id=str(book.broker.pk),
        side="sell",
        quantity="0.123",
        price="113.35",
        economic_date="2026-09-08",
    )
    assert position(book.space, book.broker, book.stock) == (D("0"), D("0"))
    assert balance(book.space, book.broker, "cash") == D("1000")


def test_pending_confirmation_preserves_actual_cash_and_rejects_other_product(book):
    result = record_trade(
        book.space,
        book.user,
        {
            "instrument_id": str(book.fund.pk),
            "account_id": str(book.account.pk),
            "side": "buy",
            "pending": True,
            "amount": "10",
            "economic_date": "2026-09-04",
        },
    )
    body = {
        "kind": "fund_confirm",
        "related_event_id": result["items"][0]["id"],
        "instrument_id": str(book.stock.pk),
        "account_id": str(book.account.pk),
        "quantity": "5.56",
        "price": "1.7987",
        "amount": "10",
        "economic_date": "2026-09-08",
    }
    with pytest.raises(DomainError):
        confirm_fund_trade(book.space, book.user, body)
    confirm_fund_trade(
        book.space, book.user, {**body, "instrument_id": str(book.fund.pk)}
    )
    assert position(book.space, book.account, book.fund) == (D("5.56"), D("10"))
    assert balance(book.space, book.account, "cash") == D("990")
