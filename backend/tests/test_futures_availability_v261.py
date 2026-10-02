"""Cash-only futures withdrawal estimates never certify missing equity evidence."""

import uuid
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from wealth.account_opening import initialize_account
from wealth.common import tenant_context
from wealth.ledger import post_event, reverse_event
from wealth.models import (
    Account,
    Event,
    Instrument,
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
TODAY = "2026-09-24"
PRIOR = "2026-09-23"


@pytest.fixture
def book():
    user = get_user_model().objects.create_user("withdrawal-v261-owner")
    space = Workspace.objects.create(name="无持仓可提取验收")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        account = Account.objects.create(
            tenant=space, name="期货资金", kind="futures", valuation_mode="snapshot"
        )
        yield SimpleNamespace(user=user, space=space, account=account)


def snapshot(book, when=TODAY, equity="10000", **details):
    return Snapshot.objects.create(
        tenant=book.space,
        account=book.account,
        economic_date=when,
        equity=equity,
        currency="CNY",
        coverage="客户总权益，无期权持仓",
        complete=True,
        includes_options=False,
        details={"no_option_positions": True, **details},
    )


def reported(book, when=TODAY):
    result = overview(book.space, when)
    return result, next(
        row for row in result["accounts"] if row["id"] == str(book.account.pk)
    )


def movement(book, quantity, instrument=None, when=TODAY):
    instrument = instrument or Instrument.objects.create(
        tenant=book.space,
        name="豆粕期货",
        code=str(uuid.uuid4()),
        kind="future",
        market="DCE",
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
    return instrument


@pytest.mark.parametrize("kind", ["future", "futures"])
def test_cash_only_opening_defaults_to_equity_and_discloses_estimate(book, kind):
    book.account.kind = kind
    book.account.save(update_fields=["kind"])
    initialize_account(
        book.space,
        book.user,
        book.account,
        {
            "opening_balance": "10000",
            "opening_date": TODAY,
            "opening_coverage": "客户总权益",
            "opening_coverage_confirmed": True,
            "opening_option_scope": "no_options",
        },
    )
    # Product catalogue entries alone do not constitute positions.
    Instrument.objects.create(
        tenant=book.space, name="未开仓合约", code="m2701", kind="future"
    )
    report, row = reported(book)
    assert D(row["available"]) == D("10000")
    assert row["available_basis"] == "estimated_no_positions"
    assert row["available_estimated"] and row["available_eligible"]
    assert D(report["available_cash"]) == D("10000")
    assert report["completeness"] == "complete"
    comparison = net_worth_comparison(book.space, TODAY)
    detail = next(
        row
        for row in comparison["estimated"]["accounts"]
        if row["account_id"] == str(book.account.pk)
    )
    assert D(detail["available"]) == D("10000")
    assert detail["available_estimated"]


@pytest.mark.parametrize("amount", ["0", "7000"])
def test_explicit_amount_including_zero_overrides_cash_only_default(book, amount):
    snapshot(book, available=amount, margin="3000")
    report, row = reported(book)
    assert D(row["available"]) == D(amount)
    assert D(report["available_cash"]) == D(amount)
    assert row["available_basis"] == "reported"
    assert not row["available_estimated"]


def test_negative_equity_never_becomes_negative_withdrawable_cash(book):
    snapshot(book, equity="-50")
    report, row = reported(book)
    assert D(report["net_assets"]) == D("-50")
    assert D(row["available"]) == D(report["available_cash"]) == 0


@pytest.mark.parametrize(
    "details",
    [
        {"margin": "1"},
        {"margin": "unknown"},
        {"frozen": "1"},
        {"frozen_cash": "1"},
        {"positions": [{"code": "m2701", "quantity": "1"}]},
        {"positions": "存在未核实持仓"},
    ],
)
def test_margin_freeze_or_snapshot_position_evidence_prevents_estimate(book, details):
    snapshot(book, **details)
    report, row = reported(book)
    assert D(row["available"]) == D(report["available_cash"]) == 0
    assert not row["available_estimated"]
    assert row["available_basis"] == "unavailable"


def test_account_freeze_prevents_estimate(book):
    book.account.frozen = D("1")
    book.account.save(update_fields=["frozen"])
    snapshot(book)
    assert reported(book)[1]["available_basis"] == "unavailable"


def test_active_derivative_movements_block_until_fully_closed(book):
    snapshot(book)
    instrument = movement(book, "2")
    assert reported(book)[1]["available_basis"] == "unavailable"
    movement(book, "-2", instrument)
    assert D(reported(book)[1]["available"]) == D("10000")


def test_future_dated_position_does_not_block_current_cash_only_account(book):
    snapshot(book)
    movement(book, "1", when="2026-09-25")
    assert reported(book)[1]["available_estimated"]


def test_reversed_position_does_not_count_as_current_exposure(book):
    snapshot(book)
    movement(book, "1")
    event = Event.objects.get(tenant=book.space)
    reverse_event(book.space, book.user, event, "合成持仓录入撤销")
    assert reported(book)[1]["available_estimated"]


def test_option_reference_is_exposure_even_without_ledger_movements(book):
    snapshot(book)
    instrument = Instrument.objects.create(
        tenant=book.space,
        name="豆粕沽3300",
        code="m2701-P-3300",
        market="DCE",
        kind="option",
    )
    save_option_position(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(instrument.pk),
            "side": "long",
            "quantity": "1",
            "contract_multiplier": "10",
            "opening_price": "50",
            "current_value": "400",
            "purchase_date": PRIOR,
            "as_of": TODAY,
        },
    )
    assert not PositionMovement.objects.filter(tenant=book.space).exists()
    assert reported(book)[1]["available_basis"] == "unavailable"


def test_latest_zero_margin_and_zero_quantity_supersede_older_restrictions(book):
    snapshot(book, when=PRIOR, margin="500", positions=[{"quantity": "1"}])
    snapshot(book, margin="0", positions=[{"quantity": "0"}])
    assert D(reported(book)[1]["available"]) == D("10000")


def test_cash_only_roll_forward_is_available_without_invented_settlement_gap(book):
    snapshot(book, when=PRIOR)
    bank = Account.objects.create(tenant=book.space, name="入金银行", kind="bank")
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(bank.pk),
            "amount": "500",
            "economic_date": PRIOR,
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
            "economic_date": TODAY,
        },
    )
    report, row = reported(book)
    assert D(row["value"]) == D(row["available"]) == D("10500")
    assert D(row["roll_forward"]) == D("500")
    assert row["available_estimated"] and row["available_eligible"]
    assert report["completeness"] == "complete"
    assert D(report["available_cash"]) == D("10500")
    assert not any("尚缺后续" in gap for gap in report["gaps"])


def test_unverified_coverage_does_not_become_complete_or_allocatable(book):
    observation = snapshot(book)
    observation.complete = False
    observation.save(update_fields=["complete"])
    report, row = reported(book)
    assert D(row["available"]) == D("10000")
    assert row["available_estimated"] and not row["available_eligible"]
    assert report["completeness"] == "partial"
    assert D(report["available_cash"]) == 0


def test_fresh_snapshot_absorbs_transfer_without_counting_it_twice(book):
    snapshot(book, when=PRIOR)
    bank = Account.objects.create(tenant=book.space, name="入金银行", kind="bank")
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(bank.pk),
            "amount": "500",
            "economic_date": PRIOR,
        },
    )
    transfer = post_event(
        book.space,
        book.user,
        {
            "kind": "transfer",
            "account_id": str(bank.pk),
            "target_account_id": str(book.account.pk),
            "amount": "500",
            "economic_date": TODAY,
        },
    )
    current = snapshot(book, equity="10500")
    current.included_event_ids = [str(transfer.pk)]
    current.save(update_fields=["included_event_ids"])
    report, row = reported(book)
    assert D(row["available"]) == D(report["available_cash"]) == D("10500")
    assert D(row["roll_forward"]) == 0
    assert row["available_eligible"]
    assert report["completeness"] == "complete"


def test_stale_explicit_zero_is_never_replaced_by_equity_estimate(book):
    snapshot(book, when=PRIOR, available="0")
    report, row = reported(book)
    assert D(row["available"]) == 0
    assert row["available_basis"] == "reported"
    assert row["available_estimated"]
    assert row["available_eligible"]
    assert report["completeness"] == "complete"


def test_legacy_cash_only_record_without_equity_is_not_upgraded(book):
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(book.account.pk),
            "amount": "10000",
            "economic_date": TODAY,
        },
    )
    report, row = reported(book)
    assert row["value_basis"] == "recorded_cash"
    assert not row["available_estimated"]
    assert D(report["available_cash"]) == 0
    assert report["completeness"] == "partial"


def test_intraday_equity_remains_reference_only(book):
    snapshot(book, valuation_basis="intraday")
    report, row = reported(book)
    assert row["value"] is None
    assert D(report["available_cash"]) == 0
    reference = _institution_value(
        book.space, book.account, date.fromisoformat(TODAY), prefer_reference=True
    )
    assert reference["basis"] == "institution_estimate"
    assert reference["available_estimated"]
    assert reference["local_value"] == D("10000")


def test_empty_broker_snapshot_gets_same_cash_only_default_as_futures(book):
    book.account.kind = "broker"
    book.account.save(update_fields=["kind"])
    snapshot(book)
    report, row = reported(book)
    assert row["available_estimated"] and row["available_eligible"]
    assert D(row["available"]) == D(report["available_cash"]) == D("10000")
