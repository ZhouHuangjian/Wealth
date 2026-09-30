"""Real database financial integration: V2 A1/A2 and immutable event chains.

The expectations intentionally exercise business amounts rather than duplicating
the implementation. Known defects are regression failures, not xfail exceptions.
"""

from collections import defaultdict
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model

from wealth.common import DomainError, tenant_context
from wealth.ledger import balance, position, post_event, reverse_event
from wealth.models import (
    Account,
    Event,
    Instrument,
    JournalLine,
    Membership,
    Occurrence,
    Resource,
    Workspace,
)


pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def book():
    user = get_user_model().objects.create_user(
        username="ledger-owner", password="a-long-test-password"
    )
    space = Workspace.objects.create(name="财务集成测试", base_currency="CNY")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        bank = Account.objects.create(
            tenant=space, created_by=user, name="银行", kind="bank", currency="CNY"
        )
        broker = Account.objects.create(
            tenant=space,
            created_by=user,
            name="投资账户",
            kind="securities",
            currency="CNY",
        )
        loan = Account.objects.create(
            tenant=space, created_by=user, name="贷款", kind="loan", currency="CNY"
        )
        instrument = Instrument.objects.create(
            tenant=space,
            created_by=user,
            name="合成基金",
            code="TEST-FUND",
            kind="fund",
            currency="CNY",
        )
        yield SimpleNamespace(
            user=user,
            space=space,
            bank=bank,
            broker=broker,
            loan=loan,
            instrument=instrument,
        )


def post(book, kind, account=None, **kwargs):
    payload = {
        "kind": kind,
        "account_id": str((account or book.bank).pk),
        "economic_date": "2026-01-01",
        **kwargs,
    }
    for key in (
        "target_account_id",
        "instrument_id",
        "related_event_id",
        "liability_account_id",
        "occurrence_id",
    ):
        if key in payload:
            payload[key] = str(getattr(payload[key], "pk", payload[key]))
    return post_event(book.space, book.user, payload)


def assert_balanced(event):
    totals = defaultdict(lambda: D("0"))
    for line in event.lines.all():
        totals[line.currency] += line.amount
    assert all(total == D("0") for total in totals.values()), dict(totals)


def assert_all_balanced(book):
    for event in Event.objects.filter(tenant=book.space):
        assert_balanced(event)


def test_appendix_a1_fund_lifecycle_cash_cost_and_profit(book):
    post(book, "opening", amount="10000")
    debit = post(book, "fund_debit", amount="1000", economic_date="2026-01-02")
    assert balance(book.space, book.bank, "cash") == D("9000")
    assert balance(book.space, book.bank, "fund_transit") == D("1000")
    confirmation = post(
        book,
        "fund_confirm",
        amount="1000",
        quantity="495",
        price="2.00",
        fee="10",
        instrument_id=book.instrument,
        target_account_id=book.broker,
        related_event_id=debit,
        economic_date="2026-01-04",
    )
    quantity, cost = position(book.space, book.broker, book.instrument)
    assert (quantity, cost) == (D("495"), D("1000"))
    assert balance(book.space, book.bank, "fund_transit") == D("0")
    assert balance(book.space, book.bank, "cash") + quantity * D("2.00") == D("9990")
    assert balance(book.space, book.bank, "cash") + quantity * D("2.02") == D("9999.90")
    redeem = post(
        book,
        "fund_redeem",
        book.broker,
        quantity="495",
        price="2.04",
        fee="5",
        instrument_id=book.instrument,
        related_event_id=confirmation,
        economic_date="2026-01-05",
    )
    assert position(book.space, book.broker, book.instrument) == (D("0"), D("0"))
    assert balance(book.space, book.broker, "receivable") == D("1004.80")
    assert -sum(
        (line.amount for line in redeem.lines.filter(code="realized")), D("0")
    ) == D("4.80")
    settlement = post(
        book, "settlement", related_event_id=redeem, economic_date="2026-01-08"
    )
    assert balance(book.space, book.bank, "cash") == D("10004.80")
    assert balance(book.space, book.broker, "receivable") == D("0")
    assert settlement.operation_id == debit.operation_id
    before_count = Event.objects.filter(tenant=book.space).count()
    with pytest.raises(DomainError):
        post(book, "settlement", related_event_id=redeem, economic_date="2026-01-08")
    assert Event.objects.filter(tenant=book.space).count() == before_count
    assert balance(book.space, book.bank, "cash") == D("10004.80")
    assert_all_balanced(book)


def test_partial_fund_confirmation_and_refund_only_use_remaining_transit(book):
    post(book, "opening", amount="1000")
    debit = post(book, "fund_debit", amount="1000")
    post(
        book,
        "fund_confirm",
        quantity="200",
        price="2",
        fee="5",
        instrument_id=book.instrument,
        target_account_id=book.broker,
        related_event_id=debit,
    )
    assert balance(book.space, book.bank, "fund_transit") == D("595")
    with pytest.raises(DomainError):
        post(
            book,
            "fund_confirm",
            quantity="300",
            price="2",
            instrument_id=book.instrument,
            target_account_id=book.broker,
            related_event_id=debit,
        )
    post(book, "fund_refund", amount="595", related_event_id=debit)
    assert balance(book.space, book.bank, "cash") == D("595")
    assert balance(book.space, book.bank, "fund_transit") == D("0")
    assert position(book.space, book.broker, book.instrument) == (D("200"), D("405"))
    with pytest.raises(DomainError):
        post(book, "fund_refund", amount="1", related_event_id=debit)
    assert_all_balanced(book)


def test_appendix_a2_unknown_repayment_then_allocation_never_double_debits_cash(book):
    post(book, "opening", amount="10000")
    post(book, "opening", book.loan, amount="2000")
    repayment = post(book, "repayment", amount="520", target_account_id=book.loan)
    assert balance(book.space, book.bank, "cash") == D("9480")
    assert balance(book.space, book.bank, "loan_clearing") == D("520")
    assert balance(book.space, book.loan, "liability") == D("-2000")
    post(
        book,
        "repayment_allocate",
        amount="520",
        principal="500",
        interest="20",
        target_account_id=book.loan,
        related_event_id=repayment,
    )
    assert balance(book.space, book.bank, "cash") == D("9480")
    assert balance(book.space, book.bank, "loan_clearing") == D("0")
    assert balance(book.space, book.loan, "liability") == D("-1500")
    assert balance(book.space, book.bank, "cash") + balance(
        book.space, book.loan, "liability"
    ) == D("7980")
    with pytest.raises(DomainError):
        post(
            book,
            "repayment_allocate",
            amount="520",
            principal="500",
            interest="20",
            target_account_id=book.loan,
            related_event_id=repayment,
        )
    assert balance(book.space, book.bank, "cash") == D("9480")
    assert_all_balanced(book)


def test_known_repayment_principal_is_not_expense(book):
    post(book, "opening", amount="10000")
    post(book, "opening", book.loan, amount="2000")
    repayment = post(
        book,
        "repayment",
        amount="520",
        principal="500",
        interest="20",
        target_account_id=book.loan,
    )
    assert balance(book.space, book.bank, "cash") == D("9480")
    assert balance(book.space, book.loan, "liability") == D("-1500")
    assert list(
        repayment.lines.filter(code="expense").values_list("amount", flat=True)
    ) == [D("20")]
    assert_balanced(repayment)


def test_stock_trade_cash_moves_only_at_settlement_and_cost_fees_are_not_duplicated(
    book,
):
    post(book, "opening", book.broker, amount="10000")
    buy = post(
        book,
        "buy",
        book.broker,
        quantity="10",
        price="100",
        fee="2",
        instrument_id=book.instrument,
    )
    assert balance(book.space, book.broker, "cash") == D("10000")
    assert balance(book.space, book.broker, "payable") == D("-1002")
    assert position(book.space, book.broker, book.instrument) == (D("10"), D("1002"))
    post(
        book,
        "settlement",
        book.broker,
        related_event_id=buy,
        economic_date="2026-01-02",
    )
    assert balance(book.space, book.broker, "cash") == D("8998")
    sell = post(
        book,
        "sell",
        book.broker,
        quantity="4",
        price="120",
        fee="1",
        tax="0.5",
        instrument_id=book.instrument,
        economic_date="2026-01-03",
    )
    assert position(book.space, book.broker, book.instrument) == (D("6"), D("601.2"))
    assert balance(book.space, book.broker, "cash") == D("8998")
    assert balance(book.space, book.broker, "receivable") == D("478.5")
    assert list(
        sell.lines.filter(code="realized").values_list("amount", flat=True)
    ) == [D("-77.7")]
    post(
        book,
        "settlement",
        book.broker,
        related_event_id=sell,
        economic_date="2026-01-04",
    )
    assert balance(book.space, book.broker, "cash") == D("9476.5")
    assert balance(book.space, book.broker, "receivable") == D("0")
    with pytest.raises(DomainError):
        post(book, "settlement", book.broker, related_event_id=buy)
    assert_all_balanced(book)


def test_fx_balances_each_currency_without_adding_different_units(book):
    usd = Account.objects.create(
        tenant=book.space,
        created_by=book.user,
        name="USD 银行",
        kind="bank",
        currency="USD",
    )
    post(book, "opening", amount="10000")
    event = post(
        book,
        "fx",
        amount="7000",
        fee="7",
        received_amount="1000",
        target_account_id=usd,
    )
    assert balance(book.space, book.bank, "cash") == D("2993")
    assert balance(book.space, usd, "cash") == D("1000")
    assert set(event.lines.values_list("currency", flat=True)) == {"CNY", "USD"}
    assert_balanced(event)
    with pytest.raises(DomainError):
        post(book, "transfer", amount="10", target_account_id=usd)


def test_internal_transfer_and_fee_preserve_principal(book):
    post(book, "opening", amount="1000")
    event = post(book, "transfer", amount="300", fee="2", target_account_id=book.broker)
    assert balance(book.space, book.bank, "cash") == D("700")
    assert balance(book.space, book.broker, "cash") == D("298")
    assert list(
        event.lines.filter(code="expense").values_list("amount", flat=True)
    ) == [D("2")]
    assert not event.lines.filter(code="income").exists()
    assert_balanced(event)


def test_reverse_parent_is_blocked_until_stage_dependencies_are_reversed(book):
    post(book, "opening", amount="1000")
    debit = post(book, "fund_debit", amount="1000")
    confirm = post(
        book,
        "fund_confirm",
        quantity="495",
        price="2",
        fee="10",
        instrument_id=book.instrument,
        target_account_id=book.broker,
        related_event_id=debit,
    )
    with pytest.raises(DomainError) as error:
        reverse_event(book.space, book.user, debit, "先冲正确认")
    assert error.value.code == "dependency"
    reversal = reverse_event(book.space, book.user, confirm, "错误确认")
    assert position(book.space, book.broker, book.instrument) == (D("0"), D("0"))
    reverse_event(book.space, book.user, debit, "错误扣款")
    assert balance(book.space, book.bank, "cash") == D("1000")
    assert balance(book.space, book.bank, "fund_transit") == D("0")
    assert_balanced(reversal)


def test_reverse_later_position_then_earlier_position_is_allowed(book):
    """Regression: canceled movement history must not permanently block replay."""
    buy = post(
        book,
        "buy",
        book.broker,
        quantity="10",
        price="100",
        instrument_id=book.instrument,
    )
    sell = post(
        book,
        "sell",
        book.broker,
        quantity="4",
        price="110",
        instrument_id=book.instrument,
        economic_date="2026-01-02",
    )
    with pytest.raises(DomainError):
        reverse_event(book.space, book.user, buy, "仍有卖出依赖")
    reverse_event(book.space, book.user, sell, "更正卖出")
    reverse_event(book.space, book.user, buy, "更正原始买入")
    assert position(book.space, book.broker, book.instrument) == (D("0"), D("0"))
    assert balance(book.space, book.broker, "payable") == D("0")
    assert_all_balanced(book)


def test_replay_after_reversing_future_movements_is_allowed(book):
    buy = post(
        book,
        "buy",
        book.broker,
        quantity="10",
        price="100",
        instrument_id=book.instrument,
    )
    sell = post(
        book,
        "sell",
        book.broker,
        quantity="4",
        price="110",
        instrument_id=book.instrument,
        economic_date="2026-01-03",
    )
    reverse_event(book.space, book.user, sell, "撤销未来错误记录")
    replacement = post(
        book,
        "sell",
        book.broker,
        quantity="4",
        price="105",
        instrument_id=book.instrument,
        economic_date="2026-01-02",
    )
    assert position(book.space, book.broker, book.instrument) == (D("6"), D("600"))
    assert_balanced(replacement)


def test_cross_currency_fund_stage_reference_is_rejected(book):
    """Numerically balanced CNY entries cannot consume a USD transit balance."""
    usd = Account.objects.create(
        tenant=book.space,
        created_by=book.user,
        name="美元申购",
        kind="bank",
        currency="USD",
    )
    original = post(book, "fund_debit", usd, amount="100")
    with pytest.raises(DomainError):
        post(
            book,
            "fund_confirm",
            quantity="50",
            price="2",
            instrument_id=book.instrument,
            related_event_id=original,
            target_account_id=book.broker,
        )
    assert balance(book.space, usd, "fund_transit") == D("100")
    assert position(book.space, book.broker, book.instrument) == (D("0"), D("0"))


def test_cross_currency_settlement_reference_is_rejected(book):
    usd = Account.objects.create(
        tenant=book.space,
        created_by=book.user,
        name="美元收款",
        kind="bank",
        currency="USD",
    )
    buy = post(
        book,
        "buy",
        book.broker,
        quantity="10",
        price="10",
        instrument_id=book.instrument,
    )
    with pytest.raises(DomainError):
        post(book, "settlement", usd, related_event_id=buy)
    assert balance(book.space, book.broker, "payable") == D("-100")
    assert balance(book.space, usd, "cash") == D("0")


def test_allocation_cannot_silently_pay_a_different_loan(book):
    other_loan = Account.objects.create(
        tenant=book.space,
        created_by=book.user,
        name="另一贷款",
        kind="loan",
        currency="CNY",
    )
    post(book, "opening", book.loan, amount="2000")
    post(book, "opening", other_loan, amount="2000")
    original = post(book, "repayment", amount="520", target_account_id=book.loan)
    with pytest.raises(DomainError):
        post(
            book,
            "repayment_allocate",
            amount="520",
            principal="500",
            interest="20",
            related_event_id=original,
            target_account_id=other_loan,
        )
    assert balance(book.space, other_loan, "liability") == D("-2000")
    assert balance(book.space, book.bank, "loan_clearing") == D("520")


def test_refund_cannot_restore_a_reversed_expense(book):
    expense = post(book, "expense", amount="100")
    reverse_event(book.space, book.user, expense, "原支出不存在")
    with pytest.raises(DomainError):
        post(book, "refund", amount="100", related_event_id=expense)
    assert balance(book.space, book.bank, "cash") == D("0")


def test_cross_workspace_account_reference_is_rejected(book):
    other = Workspace.objects.create(name="完全独立的家庭")
    with tenant_context(other.pk):
        foreign_account = Account.objects.create(
            tenant=other, created_by=book.user, name="其他空间银行", currency="CNY"
        )
    # Explicitly re-enter our space; nested context restoration has separate tests.
    with tenant_context(book.space.pk):
        before = JournalLine.objects.filter(tenant=book.space).count()
        with pytest.raises(DomainError) as error:
            post(book, "transfer", amount="100", target_account_id=foreign_account)
        assert error.value.code == "not_found"
        assert JournalLine.objects.filter(tenant=book.space).count() == before


def test_unconfirmed_plan_never_creates_a_cash_fact(book):
    post(book, "opening", amount="1000")
    before = JournalLine.objects.filter(tenant=book.space).count()
    plan = Resource.objects.create(
        tenant=book.space,
        created_by=book.user,
        kind="plans",
        data={"name": "每月定投", "amount": "200", "account_id": str(book.bank.pk)},
    )
    occurrence = Occurrence.objects.create(
        tenant=book.space,
        created_by=book.user,
        plan=plan,
        sequence=1,
        due_date=date(2020, 1, 1),
        amount=D("200"),
        currency="CNY",
        status="pending",
    )
    assert occurrence.event_id is None
    assert JournalLine.objects.filter(tenant=book.space).count() == before
    assert balance(book.space, book.bank, "cash") == D("1000")


def test_same_occurrence_cannot_post_two_actual_cash_events(book):
    post(book, "opening", amount="1000")
    plan = Resource.objects.create(
        tenant=book.space,
        created_by=book.user,
        kind="plans",
        data={"name": "计划", "account_id": str(book.bank.pk), "kind": "expense"},
    )
    occurrence = Occurrence.objects.create(
        tenant=book.space,
        created_by=book.user,
        plan=plan,
        sequence=1,
        due_date=date(2026, 1, 1),
        amount=D("200"),
        currency="CNY",
    )
    post(book, "expense", amount="200", occurrence_id=occurrence)
    before = Event.objects.filter(tenant=book.space).count()
    with pytest.raises(DomainError):
        post(book, "expense", amount="200", occurrence_id=occurrence)
    assert Event.objects.filter(tenant=book.space).count() == before
    assert balance(book.space, book.bank, "cash") == D("800")


# Appendix A4 is exercised with real snapshots in test_reporting.py.


def test_settlement_is_scoped_to_individual_trade_not_entire_operation(book):
    post(book, "opening", amount="1000")
    debit = post(book, "fund_debit", amount="1000")
    confirm = post(
        book,
        "fund_confirm",
        quantity="500",
        price="2",
        instrument_id=book.instrument,
        target_account_id=book.broker,
        related_event_id=debit,
    )
    first = post(
        book,
        "fund_redeem",
        book.broker,
        quantity="100",
        price="2",
        instrument_id=book.instrument,
        related_event_id=confirm,
    )
    second = post(
        book,
        "fund_redeem",
        book.broker,
        quantity="100",
        price="3",
        instrument_id=book.instrument,
        related_event_id=confirm,
    )
    post(book, "settlement", related_event_id=first)
    assert balance(book.space, book.bank, "cash") == D("200")
    assert balance(book.space, book.broker, "receivable") == D("300")
    post(book, "settlement", related_event_id=second)
    assert balance(book.space, book.bank, "cash") == D("500")


def test_unknown_acquisition_cost_still_records_actual_sale_and_cash(book):
    post(
        book,
        "opening",
        book.broker,
        amount="0",
        quantity="10",
        instrument_id=book.instrument,
    )
    sale = post(
        book,
        "sell",
        book.broker,
        quantity="4",
        price="12",
        fee="1",
        instrument_id=book.instrument,
    )
    assert sale.payload["cost_unknown"] is True
    assert position(book.space, book.broker, book.instrument) == (D("6"), None)
    assert balance(book.space, book.broker, "receivable") == D("47")
    post(book, "settlement", book.broker, related_event_id=sale)
    assert balance(book.space, book.broker, "cash") == D("47")
    assert not sale.lines.filter(code="realized").exists()
    assert_all_balanced(book)


def test_multiple_initial_holdings_without_duplicate_cash_or_product(book):
    post(book, "opening", book.broker, amount="1000")
    post(
        book,
        "opening",
        book.broker,
        amount="0",
        quantity="10",
        cost="100",
        instrument_id=book.instrument,
    )
    other = Instrument.objects.create(
        tenant=book.space, code="SECOND", name="另一基金", currency="CNY"
    )
    post(book, "opening", book.broker, amount="0", quantity="5", instrument_id=other)
    assert balance(book.space, book.broker, "cash") == D("1000")
    assert position(book.space, book.broker, book.instrument) == (D("10"), D("100"))
    assert position(book.space, book.broker, other) == (D("5"), None)
    with pytest.raises(DomainError):
        post(book, "opening", book.broker, amount="1000")
    with pytest.raises(DomainError):
        post(
            book, "opening", book.broker, amount="0", quantity="10", instrument_id=other
        )


def test_preopening_transactions_cannot_double_count_history(book):
    post(book, "opening", amount="1000", economic_date="2026-01-10")
    with pytest.raises(DomainError) as err:
        post(book, "expense", amount="100", economic_date="2026-01-09")
    assert err.value.code == "before_opening"
    assert balance(book.space, book.bank, "cash") == D("1000")


def test_user_confirmation_amount_must_match_quantity_price_and_fees(book):
    with pytest.raises(DomainError) as err:
        post(
            book,
            "buy",
            book.broker,
            amount="100",
            quantity="10",
            price="10",
            fee="2",
            instrument_id=book.instrument,
        )
    assert err.value.code == "amount_mismatch"
    assert not Event.objects.filter(tenant=book.space).exists()


def test_transfer_before_destination_opening_is_blocked(book):
    post(book, "opening", amount="1000", economic_date="2026-01-01")
    post(book, "opening", book.broker, amount="500", economic_date="2026-01-10")
    with pytest.raises(DomainError):
        post(
            book,
            "transfer",
            amount="100",
            target_account_id=book.broker,
            economic_date="2026-01-05",
        )
    assert balance(book.space, book.broker, "cash") == D("500")


def test_stage_cannot_precede_original_actual_fact(book):
    debit = post(book, "fund_debit", amount="100", economic_date="2026-01-10")
    with pytest.raises(DomainError) as err:
        post(
            book,
            "fund_confirm",
            quantity="50",
            price="2",
            instrument_id=book.instrument,
            related_event_id=debit,
            economic_date="2026-01-09",
        )
    assert err.value.code == "stage_date"
    assert balance(book.space, book.bank, "fund_transit") == D("100")


def test_derivative_notional_cannot_be_posted_as_a_stock_purchase(book):
    future = Instrument.objects.create(
        tenant=book.space,
        name="合成期货",
        code="TEST-FUT",
        kind="future",
        currency="CNY",
    )
    with pytest.raises(DomainError) as err:
        post(
            book, "buy", book.broker, instrument_id=future, quantity="1", price="10000"
        )
    assert err.value.code == "derivative_snapshot_required"
    assert not Event.objects.filter(tenant=book.space).exists()
