"""Account amounts show recorded institution equity without inventing cash."""

from datetime import date
from decimal import Decimal as D
from types import SimpleNamespace
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from wealth.account_balances import account_balance_projection
from wealth.account_opening import initialize_account
from wealth.common import tenant_context
from wealth.ledger import balance, post_event, reverse_event
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

pytestmark = pytest.mark.django_db
OPENING = "2026-09-28"
TODAY = date(2026, 10, 4)


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("django.utils.timezone.localdate", lambda: TODAY)
    user = get_user_model().objects.create_user("account-balance-owner")
    space = Workspace.objects.create(name="账户金额回归")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        yield SimpleNamespace(space=space, user=user)


def account(book, kind="futures", **kwargs):
    return Account.objects.create(
        tenant=book.space, name="账户金额验收", kind=kind, **kwargs
    )


def opening(book, row, amount="10000", basis="settlement"):
    initialize_account(
        book.space,
        book.user,
        row,
        {
            "opening_balance": amount,
            "opening_date": OPENING,
            "opening_valuation_basis": basis,
            "opening_coverage": "全部客户权益，包含全部期权价值",
            "opening_coverage_confirmed": True,
            "opening_option_scope": "includes_options",
        },
    )


def facts():
    return tuple(
        model.objects.count()
        for model in (Event, JournalLine, PositionMovement, Snapshot)
    )


@pytest.mark.parametrize("kind", ["futures", "future", "options", "option", "broker"])
@pytest.mark.parametrize("amount", ["12345.67", "0"])
def test_equity_opening_is_visible_without_cash_journal(book, kind, amount):
    row = account(book, kind, valuation_mode="snapshot")
    opening(book, row, amount)
    before = facts()
    result = account_balance_projection(book.space, row)
    assert D(result["balance"]) == D(amount)
    assert result["balance_basis"] == "institution_settlement"
    assert result["balance_label"] == "机构总权益"
    assert result["balance_as_of"] == OPENING
    assert result["balance_status"] == "complete"
    assert D(result["cash_balance"]) == 0
    assert balance(book.space, row) == 0
    assert facts() == before


@pytest.mark.parametrize("kind", ["futures", "options"])
def test_legacy_derivative_kind_uses_equity_even_with_detailed_mode(book, kind):
    row = account(book, kind, valuation_mode="detailed")
    opening(book, row)
    assert D(account_balance_projection(book.space, row)["balance"]) == 10000


def test_intraday_opening_is_visible_and_keeps_its_basis(book):
    row = account(book)
    opening(book, row, "4500", basis="intraday")
    result = account_balance_projection(book.space, row)
    assert D(result["balance"]) == 4500
    assert result["balance_basis"] == "institution_estimate"
    assert result["balance_label"] == "盘中权益"
    assert D(result["cash_balance"]) == 0


def transfer(book, source, target, amount, when):
    return post_event(
        book.space,
        book.user,
        {
            "kind": "transfer",
            "account_id": str(source.pk),
            "target_account_id": str(target.pk),
            "amount": str(amount),
            "economic_date": when,
        },
    )


def test_equity_rolls_forward_transfers_once_and_new_snapshot_covers_them(book):
    row = account(book)
    opening(book, row)
    bank = account(book, "bank")
    opening(book, bank, "5000")
    inflow = transfer(book, bank, row, "800", "2026-09-29")
    outflow = transfer(book, row, bank, "300", "2026-09-30")
    result = account_balance_projection(book.space, row)
    assert D(result["balance"]) == 10500
    assert D(result["cash_balance"]) == 500
    Snapshot.objects.create(
        tenant=book.space,
        account=row,
        economic_date="2026-09-30",
        currency="CNY",
        equity="10400",
        complete=True,
        includes_options=True,
        coverage="机构重新确认全部权益",
        included_event_ids=[str(inflow.pk), str(outflow.pk)],
        details={"valuation_basis": "settlement"},
    )
    result = account_balance_projection(book.space, row)
    assert D(result["balance"]) == 10400
    assert D(result["cash_balance"]) == 500
    assert result["balance_as_of"] == "2026-09-30"


def test_reversed_transfer_does_not_change_equity(book):
    row = account(book)
    opening(book, row)
    bank = account(book, "bank")
    opening(book, bank, "1000")
    flow = transfer(book, bank, row, "200", "2026-09-29")
    reverse_event(book.space, book.user, flow, "撤销重复转账")
    result = account_balance_projection(book.space, row)
    assert D(result["balance"]) == 10000
    assert D(result["cash_balance"]) == 0


def test_incomplete_scope_preserves_known_equity_with_warning(book):
    row = account(book)
    initialize_account(
        book.space,
        book.user,
        row,
        {
            "opening_balance": "1200",
            "opening_date": OPENING,
            "opening_coverage": "机构金额范围尚未核对",
        },
    )
    result = account_balance_projection(book.space, row)
    assert D(result["balance"]) == 1200
    assert result["balance_status"] == "partial"
    assert "未核实" in result["balance_message"]


def test_absent_equity_is_unknown_and_legacy_cash_is_only_known_part(book):
    row = account(book)
    result = account_balance_projection(book.space, row)
    assert result["balance"] is None
    assert result["balance_status"] == "missing"
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(row.pk),
            "amount": "3000",
            "economic_date": OPENING,
        },
    )
    result = account_balance_projection(book.space, row)
    assert D(result["balance"]) == 3000
    assert D(result["cash_balance"]) == 3000
    assert result["balance_basis"] == "recorded_cash"
    assert result["balance_label"] == "已记录资金"
    assert result["balance_status"] == "partial"


def test_positions_already_covered_by_equity_are_not_added_again(book):
    row = account(book)
    opening(book, row)
    inst = Instrument.objects.create(
        tenant=book.space, name="期权参考", code="m2701-P-3300", kind="option"
    )
    event = Event.objects.create(
        tenant=book.space,
        kind="opening",
        economic_date=OPENING,
        stage_key=str(uuid.uuid4()),
        revision=book.space.revision,
    )
    PositionMovement.objects.create(
        tenant=book.space,
        account=row,
        instrument=inst,
        event=event,
        quantity="2",
        cost="600",
    )
    result = account_balance_projection(book.space, row)
    assert D(result["balance"]) == 10000
    assert result["balance_status"] == "partial"
    assert "结算盈亏" in result["balance_message"]


def test_regular_book_amount_still_includes_in_transit_but_cash_stays_separate(book):
    row = account(book, "bank")
    opening(book, row, "1000")
    inst = Instrument.objects.create(
        tenant=book.space, name="申购在途", code="AB031", kind="fund"
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(row.pk),
            "instrument_id": str(inst.pk),
            "amount": "200",
            "economic_date": "2026-09-29",
        },
    )
    result = account_balance_projection(book.space, row)
    assert D(result["balance"]) == 1000
    assert D(result["cash_balance"]) == 800
    assert result["balance_basis"] == "ledger"
    assert result["balance_label"] == "账面金额"


def test_accounts_list_and_detail_expose_same_equity_projection(book):
    row = account(book)
    opening(book, row, "4321.09", basis="intraday")
    client = Client()
    client.force_login(book.user)
    base = f"/api/v1/spaces/{book.space.pk}/accounts"
    before = facts()
    items = client.get(base).json()["items"]
    listed = next(item for item in items if item["id"] == str(row.pk))
    detailed = client.get(f"{base}/{row.pk}").json()
    for response in (listed, detailed):
        assert D(response["balance"]) == D("4321.09")
        assert D(response["cash_balance"]) == 0
        assert response["balance_basis"] == "institution_estimate"
        assert response["balance_as_of"] == OPENING
    assert facts() == before
