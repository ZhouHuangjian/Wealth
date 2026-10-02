"""An empty investment account needs no invented settlement or withdrawal entry."""

import uuid
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from wealth.common import tenant_context
from wealth.ledger import post_event, reverse_event
from wealth.models import (
    Account,
    Event,
    Instrument,
    JournalLine,
    Membership,
    PositionMovement,
    Snapshot,
    Workspace,
)
from wealth.option_positions import save_option_position
from wealth.portfolio import _institution_value, net_worth_comparison
from wealth.reporting import overview

pytestmark = pytest.mark.django_db
D = Decimal
ANCHOR = "2026-09-28"
TODAY = "2026-10-02"


@pytest.fixture
def book():
    user = get_user_model().objects.create_user("empty-account-owner")
    space = Workspace.objects.create(name="空仓账户投影验收")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        account = Account.objects.create(
            tenant=space, name="空仓资金账户", kind="futures", valuation_mode="snapshot"
        )
        yield SimpleNamespace(space=space, user=user, account=account)


def snapshot(book, when=ANCHOR, **details):
    return Snapshot.objects.create(
        tenant=book.space,
        account=book.account,
        economic_date=when,
        equity="10000",
        currency="CNY",
        complete=True,
        includes_options=False,
        coverage="客户总权益，无期权持仓",
        details={"no_option_positions": True, **details},
    )


def report(book):
    result = overview(book.space, TODAY)
    return result, next(
        item for item in result["accounts"] if item["id"] == str(book.account.pk)
    )


def movement(book, quantity, when, instrument=None, kind="future"):
    instrument = instrument or Instrument.objects.create(
        tenant=book.space, name="持仓产品", code=str(uuid.uuid4()), kind=kind
    )
    event = Event.objects.create(
        tenant=book.space,
        kind="opening",
        economic_date=when,
        stage_key=str(uuid.uuid4()),
        revision=book.space.revision,
    )
    PositionMovement.objects.create(
        tenant=book.space,
        account=book.account,
        instrument=instrument,
        event=event,
        quantity=quantity,
        cost="0",
    )
    return instrument, event


@pytest.mark.parametrize(
    "kind", ["future", "futures", "fund", "broker", "securities", "bank", "wallet"]
)
def test_empty_snapshot_remains_available_without_later_settlements(book, kind):
    book.account.kind = kind
    book.account.save(update_fields=["kind"])
    statement = snapshot(book)
    Instrument.objects.create(
        tenant=book.space, name="只添加未买入的产品", code="watch-only", kind="fund"
    )
    before = (
        Event.objects.count(),
        JournalLine.objects.count(),
        Snapshot.objects.count(),
    )
    result, account = report(book)
    chosen = _institution_value(book.space, book.account, date.fromisoformat(TODAY))
    assert result["completeness"] == "complete"
    assert D(result["net_assets"]) == D(result["available_cash"]) == D("10000")
    assert D(account["available"]) == D(account["value"]) == D("10000")
    assert account["available_estimated"] and account["available_eligible"]
    assert chosen["cash_only_carry_forward"] is True
    assert chosen["settlement_pnl"] == 0
    assert chosen["settlement_pnl_basis"] == "no_recorded_positions"
    assert chosen["date"] == date.fromisoformat(ANCHOR)
    assert not result["gaps"]
    assert before == (
        Event.objects.count(),
        JournalLine.objects.count(),
        Snapshot.objects.count(),
    )
    statement.refresh_from_db()
    assert statement.economic_date == date.fromisoformat(ANCHOR)


def test_cash_transfers_roll_equity_once_and_leave_zero_projected_settlement(book):
    snapshot(book)
    bank = Account.objects.create(tenant=book.space, name="往来银行", kind="bank")
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(bank.pk),
            "amount": "2000",
            "economic_date": ANCHOR,
        },
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "transfer",
            "account_id": str(bank.pk),
            "target_account_id": str(book.account.pk),
            "amount": "500",
            "economic_date": "2026-09-29",
        },
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "transfer",
            "account_id": str(book.account.pk),
            "target_account_id": str(bank.pk),
            "amount": "200",
            "economic_date": "2026-09-30",
        },
    )
    result, account = report(book)
    assert D(account["value"]) == D(account["available"]) == D("10300")
    assert D(account["roll_forward"]) == D("300")
    assert D(result["net_assets"]) == D(result["available_cash"]) == D("12000")
    comparison = net_worth_comparison(book.space, TODAY)
    assert D(comparison["estimated"]["net_assets"]) == D("12000")
    source = next(
        row
        for row in comparison["estimated"]["source_dates"]
        if row["account_id"] == str(book.account.pk)
    )
    assert source["cash_only_carry_forward"] and D(source["settlement_pnl"]) == 0


@pytest.mark.parametrize("kind", ["future", "option", "fund", "stock", "gold"])
def test_any_active_investment_blocks_full_withdrawal_not_just_derivatives(book, kind):
    snapshot(book)
    movement(book, "1", ANCHOR, kind=kind)
    result, account = report(book)
    assert not account["available_eligible"]
    assert D(result["available_cash"]) == 0
    assert any("尚缺后续结算盈亏" in gap for gap in result["gaps"])
    assert (
        _institution_value(book.space, book.account, date.fromisoformat(TODAY))[
            "settlement_pnl"
        ]
        is None
    )


def test_round_trip_since_equity_snapshot_cannot_disappear_as_zero_pnl(book):
    snapshot(book)
    instrument, _ = movement(book, "1", "2026-09-29")
    movement(book, "-1", "2026-09-30", instrument)
    result, account = report(book)
    assert result["completeness"] == "partial"
    assert any("尚缺后续结算盈亏" in gap for gap in result["gaps"])
    assert not account["available_eligible"]
    # A new complete statement after the close can establish the empty baseline.
    snapshot(book, "2026-09-30")
    result, account = report(book)
    assert result["completeness"] == "complete"
    assert D(account["available"]) == D("10000")


def test_position_closed_before_statement_does_not_create_perpetual_stale_warning(book):
    instrument, _ = movement(book, "2", "2026-09-25")
    movement(book, "-2", "2026-09-27", instrument)
    snapshot(book)
    assert report(book)[0]["completeness"] == "complete"
    assert report(book)[1]["available_eligible"]


def test_reversed_and_future_positions_are_not_current_investment_exposure(book):
    snapshot(book)
    _, event = movement(book, "1", "2026-09-29")
    reverse_event(book.space, book.user, event, "误录，撤销")
    movement(book, "1", "2026-10-03")
    assert report(book)[1]["available_eligible"]


def option_reference(book):
    instrument = Instrument.objects.create(
        tenant=book.space,
        name="豆粕看跌期权",
        code="m2701-P-3300",
        kind="option",
        market="DCE",
    )
    return save_option_position(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(instrument.pk),
            "side": "long",
            "quantity": "1",
            "contract_multiplier": "10",
            "opening_price": "50",
            "current_value": "500",
            "purchase_date": "2026-09-25",
            "as_of": "2026-09-25",
        },
    )


@pytest.mark.parametrize("closed", [None, "2026-09-30", "2026-09-27"])
def test_reference_options_keep_interval_exposure_until_a_postclose_baseline(
    book, closed
):
    reference = option_reference(book)
    if closed:
        save_option_position(
            book.space,
            book.user,
            {
                "version": reference["version"],
                "status": "closed",
                "closed_date": closed,
            },
            ident=reference["id"],
        )
    snapshot(book)
    result, account = report(book)
    if closed == "2026-09-27":
        assert account["available_eligible"] and result["completeness"] == "complete"
    else:
        assert not account["available_eligible"]
        assert any("尚缺后续结算盈亏" in gap for gap in result["gaps"])


@pytest.mark.parametrize("amount", ["0", "3500"])
def test_explicit_withdrawal_amount_is_not_overwritten_by_empty_equity(book, amount):
    snapshot(book, available=amount)
    result, account = report(book)
    assert D(account["available"]) == D(result["available_cash"]) == D(amount)
    assert account["available_basis"] == "reported" and account["available_eligible"]
    assert result["completeness"] == "complete"


@pytest.mark.parametrize(
    "key",
    ["withdrawal_limit", "withdrawable_limit", "withdrawal_cap", "available_limit"],
)
@pytest.mark.parametrize("amount", ["0", "3500"])
def test_explicit_caps_including_zero_limit_empty_account_default(book, key, amount):
    snapshot(book, **{key: amount})
    result, account = report(book)
    assert D(account["available"]) == D(result["available_cash"]) == D(amount)
    assert account["available_eligible"]


@pytest.mark.parametrize(
    "details",
    [{"frozen_cash": "100"}, {"margin": "100"}, {"withdrawal_limit": "unknown"}],
)
def test_restriction_or_unknown_limit_never_becomes_entire_equity(book, details):
    snapshot(book, **details)
    result, account = report(book)
    assert D(account["available"]) == D(result["available_cash"]) == 0
    assert not account["available_eligible"]


def test_unconfirmed_purchase_without_shares_is_not_an_empty_cash_account(book):
    snapshot(book)
    product = Instrument.objects.create(
        tenant=book.space, name="待确认基金", code="pending", kind="fund"
    )
    event = Event.objects.create(
        tenant=book.space,
        kind="fund_debit",
        economic_date="2026-09-29",
        stage_key=str(uuid.uuid4()),
        revision=book.space.revision,
        payload={
            "account_id": str(book.account.pk),
            "instrument_id": str(product.pk),
            "currency": "CNY",
            "amount": "100",
        },
    )
    JournalLine.objects.create(
        tenant=book.space,
        account=book.account,
        event=event,
        instrument=product,
        code="cash",
        currency="CNY",
        amount="-100",
    )
    JournalLine.objects.create(
        tenant=book.space,
        account=book.account,
        event=event,
        instrument=product,
        code="fund_transit",
        currency="CNY",
        amount="100",
    )
    result, account = report(book)
    assert not account["available_eligible"]
    assert D(result["available_cash"]) == 0
    assert D(account["value"]) == D("10000")
    assert (
        _institution_value(book.space, book.account, date.fromisoformat(TODAY))[
            "settlement_pnl"
        ]
        is None
    )


def test_incomplete_scope_remains_incomplete_even_when_recorded_positions_are_empty(
    book,
):
    observation = snapshot(book)
    observation.complete = False
    observation.save(update_fields=["complete"])
    result, account = report(book)
    assert result["completeness"] == "partial"
    assert not account["available_eligible"]
    assert any("包含范围未核实" in gap for gap in result["gaps"])
    assert not any("尚缺后续结算盈亏" in gap for gap in result["gaps"])


def test_frozen_cash_never_becomes_free_but_does_not_invent_market_pnl(book):
    snapshot(book)
    book.account.frozen = D("800")
    book.account.save(update_fields=["frozen"])
    result, account = report(book)
    assert D(account["available"]) == D(result["available_cash"]) == 0
    assert not account["available_eligible"]
    assert not any("尚缺后续结算盈亏" in gap for gap in result["gaps"])


def test_reported_available_cannot_exceed_equity_after_actual_cash_withdrawal(book):
    snapshot(book, available="9000")
    bank = Account.objects.create(tenant=book.space, name="收款银行", kind="bank")
    post_event(
        book.space,
        book.user,
        {
            "kind": "transfer",
            "account_id": str(book.account.pk),
            "target_account_id": str(bank.pk),
            "amount": "9500",
            "economic_date": "2026-09-29",
        },
    )
    result, account = report(book)
    assert D(account["available"]) == D(account["value"]) == D("500")
    assert D(result["net_assets"]) == D(result["available_cash"]) == D("10000")
