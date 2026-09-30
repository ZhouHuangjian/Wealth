"""Executable V2 gold standards on the isolated, RLS-enabled PostgreSQL ledger.

AT-19 uses the specified 1,000 / 600 / 400 amounts. AT-24 tests the whole
portfolio boundary, and AT-37 executes the two competing house plans through
the actual 380,000 net-asset result. No production or demonstration data is used.
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
    Audit,
    Event,
    Instrument,
    JournalLine,
    Membership,
    Price,
    Workspace,
)
from wealth.planning import forecast, save_resource
from wealth.reporting import overview, performance


pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 1, 1))
    user = get_user_model().objects.create_user(
        username="final-gold-owner", password="isolated-acceptance-password"
    )
    space = Workspace.objects.create(name="V2 金标准独立验收", base_currency="CNY")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        accounts = {
            key: Account.objects.create(
                tenant=space, created_by=user, name=name, kind=kind, currency="CNY"
            )
            for key, name, kind in (
                ("bank", "合成银行", "bank"),
                ("fund", "合成基金账户甲", "fund"),
                ("other_fund", "合成基金账户乙", "fund"),
                ("house", "合成自住房", "property"),
                ("loan", "合成房贷", "loan"),
            )
        }
        instrument = Instrument.objects.create(
            tenant=space,
            created_by=user,
            name="金标准合成基金",
            code="ACCEPTANCE-FUND",
            kind="fund",
            currency="CNY",
        )
        yield SimpleNamespace(user=user, space=space, instrument=instrument, **accounts)


def post(book, kind, account=None, **values):
    payload = {
        "kind": kind,
        "account_id": str((account or book.bank).pk),
        "economic_date": "2026-01-01",
        **values,
    }
    for key in (
        "target_account_id",
        "instrument_id",
        "related_event_id",
        "liability_account_id",
        "reservation_id",
    ):
        if key in payload:
            payload[key] = str(getattr(payload[key], "pk", payload[key]))
    return post_event(book.space, book.user, payload)


def quote(book, value, when):
    return Price.objects.create(
        tenant=book.space,
        created_by=book.user,
        instrument=book.instrument,
        value=D(value),
        economic_date=when,
        kind="official_nav",
        source="isolated-gold-standard",
    )


def save(book, kind, values, obj=None):
    return save_resource(book.space, book.user, kind, values, obj)


def assert_facts_are_balanced_and_audited(book):
    for event in Event.objects.filter(tenant=book.space):
        totals = defaultdict(lambda: D("0"))
        for line in event.lines.all():
            totals[line.currency] += line.amount
        assert all(amount == 0 for amount in totals.values()), dict(totals)
        assert Audit.objects.filter(
            tenant=book.space, action="event.posted", object_id=str(event.pk)
        ).exists()


def test_at19_partial_confirmation_keeps_400_in_transit_until_actual_refund(book):
    post(book, "opening", amount="1000")
    debit = post(book, "fund_debit", amount="1000", economic_date="2026-01-02")
    confirmation = post(
        book,
        "fund_confirm",
        amount="600",
        quantity="300",
        price="2",
        instrument_id=book.instrument,
        target_account_id=book.fund,
        related_event_id=debit,
        economic_date="2026-01-03",
    )
    quote(book, "2", "2026-01-03")

    assert position(book.space, book.fund, book.instrument) == (D("300"), D("600"))
    assert balance(book.space, book.bank, "cash") == 0
    assert balance(book.space, book.bank, "fund_transit") == D("400")
    pending = overview(book.space, "2026-01-04")
    assert D(pending["net_assets"]) == D("1000")
    assert pending["completeness"] == "complete"
    assert D(pending["available_cash"]) == 0
    assert not Event.objects.filter(tenant=book.space, kind="fund_refund").exists()

    refund = post(
        book,
        "fund_refund",
        amount="400",
        related_event_id=debit,
        economic_date="2026-01-05",
    )
    assert balance(book.space, book.bank, "cash") == D("400")
    assert balance(book.space, book.bank, "fund_transit") == 0
    assert refund.operation_id == confirmation.operation_id == debit.operation_id
    assert D(overview(book.space, "2026-01-05")["net_assets"]) == D("1000")
    with pytest.raises(DomainError):
        post(
            book,
            "fund_refund",
            amount="400",
            related_event_id=debit,
            economic_date="2026-01-05",
        )
    assert balance(book.space, book.bank, "cash") == D("400")
    assert_facts_are_balanced_and_audited(book)


def test_at24_reinvest_split_and_internal_transfer_preserve_portfolio_boundary(book):
    post(
        book,
        "opening",
        book.fund,
        quantity="100",
        cost="1000",
        instrument_id=book.instrument,
    )
    quote(book, "10", "2026-01-01")
    post(
        book,
        "reinvest",
        book.fund,
        quantity="10",
        price="10",
        instrument_id=book.instrument,
        economic_date="2026-01-02",
    )
    assert position(book.space, book.fund, book.instrument) == (D("110"), D("1100"))
    assert balance(book.space, book.fund, "cash") == 0

    post(
        book,
        "split",
        book.fund,
        ratio="2",
        instrument_id=book.instrument,
        economic_date="2026-01-03",
    )
    quote(book, "5", "2026-01-03")
    assert position(book.space, book.fund, book.instrument) == (D("220"), D("1100"))
    post(
        book,
        "position_transfer",
        book.fund,
        quantity="80",
        instrument_id=book.instrument,
        target_account_id=book.other_fund,
        economic_date="2026-01-04",
    )
    assert position(book.space, book.fund, book.instrument) == (D("140"), D("700"))
    assert position(book.space, book.other_fund, book.instrument) == (D("80"), D("400"))
    result = performance(book.space, "2026-01-02", "2026-01-04")
    assert result["completeness"] == "complete"
    assert D(result["opening_value"]) == D("1000")
    assert D(result["closing_value"]) == D("1100")
    assert D(result["dividends"]) == D("100")
    assert D(result["external_inflows"]) == D(result["external_outflows"]) == 0
    assert D(result["net_profit"]) == D("100")
    assert [D(row["amount"]) for row in result["xirr_cashflows"]] == [
        D("-1000"),
        D("1100"),
    ]
    assert_facts_are_balanced_and_audited(book)


def house_plans(book):
    post(book, "opening", amount="400000")
    goal = save(
        book,
        "goals",
        {"name": "购房", "currency": "CNY", "status": "active"},
    )
    scenarios, reserves = [], []
    for name, amount, status in (
        ("首付30万加税费2万", "320000", "active"),
        ("较高首付备选", "350000", "draft"),
    ):
        scenario = save(
            book,
            "scenarios",
            {
                "goal_id": str(goal.pk),
                "name": name,
                "amount": amount,
                "currency": "CNY",
                "target_date": "2026-01-10",
                "status": status,
            },
        )
        reserve = save(
            book,
            "reservations",
            {
                "account_id": str(book.bank.pk),
                "scenario_id": str(scenario.pk),
                "amount": amount,
                "currency": "CNY",
            },
        )
        scenario = save(
            book,
            "scenarios",
            {
                "payment_nodes": [
                    {
                        "id": "purchase-cash",
                        "date": "2026-01-10",
                        "amount": amount,
                        "reservation_id": str(reserve.pk),
                    }
                ]
            },
            scenario,
        )
        scenarios.append(scenario)
        reserves.append(reserve)
    return goal, scenarios, reserves


def purchase_house(book, **extra):
    return post(
        book,
        "property_purchase",
        amount="1000000",
        loan_amount="700000",
        fee="20000",
        target_account_id=book.house,
        liability_account_id=book.loan,
        economic_date="2026-01-10",
        **extra,
    )


def assert_house_gold_standard(book):
    assert balance(book.space, book.bank, "cash") == D("80000")
    assert balance(book.space, book.house, "property") == D("1000000")
    assert balance(book.space, book.loan, "liability") == D("-700000")
    result = overview(book.space, "2026-01-10")
    assert result["completeness"] == "complete"
    assert D(result["total_assets"]) == D("1080000")
    assert D(result["total_liabilities"]) == D("700000")
    assert D(result["net_assets"]) == D("380000")
    # The mortgage was paid directly to the seller, never into the bank account.
    assert not JournalLine.objects.filter(
        tenant=book.space, account=book.bank, code="cash", amount=D("700000")
    ).exists()
    assert_facts_are_balanced_and_audited(book)


def test_at37_alternative_plans_and_actual_house_purchase_have_net_assets_380000(
    book, monkeypatch
):
    _, scenarios, reserves = house_plans(book)
    before = Event.objects.filter(tenant=book.space).count()
    selected = forecast(book.space, {"days": 30})
    alternative = forecast(
        book.space, {"days": 30, "scenario_id": str(scenarios[1].pk)}
    )
    assert D(selected["opening_available"]) == D("80000")
    assert D(selected["closing_balance"]) == D("80000")
    assert D(alternative["opening_available"]) == D("50000")
    assert D(alternative["closing_balance"]) == D("50000")
    assert D(overview(book.space, "2026-01-01")["net_assets"]) == D("400000")
    assert Event.objects.filter(tenant=book.space).count() == before

    scenarios[1] = save(book, "scenarios", {"status": "active"}, scenarios[1])
    scenarios[0].refresh_from_db()
    assert scenarios[0].data["status"] == "draft"
    assert D(forecast(book.space, {"days": 30})["opening_available"]) == D("50000")
    save(book, "scenarios", {"status": "active"}, scenarios[0])
    assert D(forecast(book.space, {"days": 30})["opening_available"]) == D("80000")

    payment = purchase_house(book, reservation_id=reserves[0])
    match_house_payment(book, scenarios[0], reserves[0], payment)
    assert_house_gold_standard(book)
    assert D(overview(book.space, "2026-01-10")["allocatable"]) == D("80000")
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 1, 10))
    assert D(forecast(book.space, {"days": 30})["closing_balance"]) == D("80000")


def match_house_payment(book, scenario, reserve, payment):
    paid_nodes = {
        "payment_nodes": [
            {
                "id": "purchase-cash",
                "date": "2026-01-10",
                "amount": "320000",
                "status": "paid",
                "event_id": str(payment.pk),
                "reservation_id": str(reserve.pk),
            }
        ]
    }
    scenario = save(book, "scenarios", paid_nodes, scenario)
    scenario = save(book, "scenarios", paid_nodes, scenario)
    reserve.refresh_from_db()
    assert reserve.data["status"] == "consumed"
    assert D(reserve.data["amount"]) == 0
    return scenario


def test_goal06_late_actual_payment_match_releases_reserved_cash_once(
    book, monkeypatch
):
    _, scenarios, reserves = house_plans(book)
    payment = purchase_house(book)
    assert_house_gold_standard(book)
    match_house_payment(book, scenarios[0], reserves[0], payment)
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 1, 10))
    assert balance(book.space, book.bank, "cash") == D("80000")
    assert D(overview(book.space, "2026-01-10")["allocatable"]) == D("80000")
    projection = forecast(book.space, {"days": 30})
    assert D(projection["opening_available"]) == D("80000")
    assert D(projection["closing_balance"]) == D("80000")
    assert_house_gold_standard(book)


@pytest.mark.parametrize("reserve_at_payment", [True, False])
def test_goal06_reversal_restores_consumed_reservation_and_pending_payment(
    book, monkeypatch, reserve_at_payment
):
    _, scenarios, reserves = house_plans(book)
    payment = purchase_house(
        book, **({"reservation_id": reserves[0]} if reserve_at_payment else {})
    )
    match_house_payment(book, scenarios[0], reserves[0], payment)
    assert D(overview(book.space, "2026-01-10")["allocatable"]) == D("80000")
    reverse_event(book.space, book.user, payment, "合成验收：撤销购房并恢复计划")
    assert balance(book.space, book.bank, "cash") == D("400000")
    assert balance(book.space, book.house, "property") == 0
    assert balance(book.space, book.loan, "liability") == 0
    report = overview(book.space, "2026-01-10")
    assert D(report["net_assets"]) == D("400000")
    assert D(report["reserved"]) == D("320000")
    assert D(report["allocatable"]) == D("80000")
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 1, 10))
    projection = forecast(book.space, {"days": 30})
    assert D(projection["opening_available"]) == D("80000")
    assert D(projection["closing_balance"]) == D("80000")
    assert D(projection["items"][-1]["settled_cash"]) == D("80000")
    with pytest.raises(DomainError):
        reverse_event(book.space, book.user, payment, "重复撤销不应重复恢复预留")
    assert D(overview(book.space, "2026-01-10")["reserved"]) == D("320000")


def test_goal06_same_actual_payment_cannot_consume_two_full_reservations(book):
    post(book, "opening", amount="10000")
    goals, reserves = [], []
    for name in ("装修预留", "购车预留"):
        goal = save(
            book, "goals", {"name": name, "status": "active", "currency": "CNY"}
        )
        reserve = save(
            book,
            "reservations",
            {
                "account_id": str(book.bank.pk),
                "goal_id": str(goal.pk),
                "amount": "600",
                "currency": "CNY",
            },
        )
        goals.append(goal)
        reserves.append(reserve)
    payment = post(book, "expense", amount="600", economic_date="2026-01-10")

    def link(index):
        return save(
            book,
            "goals",
            {
                "payment_nodes": [
                    {
                        "id": "paid-cash",
                        "date": "2026-01-10",
                        "amount": "600",
                        "event_id": str(payment.pk),
                        "reservation_id": str(reserves[index].pk),
                    }
                ]
            },
            goals[index],
        )

    link(0)
    with pytest.raises(DomainError):
        link(1)
    reserves[0].refresh_from_db()
    reserves[1].refresh_from_db()
    goals[1].refresh_from_db()
    assert reserves[0].data["status"] == "consumed"
    assert D(reserves[0].data["amount"]) == 0
    assert reserves[1].data["status"] == "active"
    assert D(reserves[1].data["amount"]) == D("600")
    assert not goals[1].data.get("payment_nodes")
    assert balance(book.space, book.bank, "cash") == D("9400")
    assert D(overview(book.space, "2026-01-10")["reserved"]) == D("600")


def test_goal06_payment_from_another_account_cannot_release_this_reservation(book):
    other_bank = Account.objects.create(
        tenant=book.space,
        created_by=book.user,
        name="另一个实际付款银行",
        kind="bank",
        currency="CNY",
    )
    post(book, "opening", amount="1000")
    post(book, "opening", other_bank, amount="1000")
    goal = save(
        book, "goals", {"name": "预留指定来源", "status": "active", "currency": "CNY"}
    )
    reserve = save(
        book,
        "reservations",
        {
            "account_id": str(book.bank.pk),
            "goal_id": str(goal.pk),
            "amount": "200",
            "currency": "CNY",
        },
    )
    payment = post(
        book, "expense", other_bank, amount="200", economic_date="2026-01-10"
    )
    with pytest.raises(DomainError):
        save(
            book,
            "goals",
            {
                "payment_nodes": [
                    {
                        "id": "wrong-source",
                        "date": "2026-01-10",
                        "amount": "200",
                        "status": "paid",
                        "event_id": str(payment.pk),
                        "reservation_id": str(reserve.pk),
                    }
                ]
            },
            goal,
        )
    reserve.refresh_from_db()
    goal.refresh_from_db()
    assert reserve.data["status"] == "active"
    assert D(reserve.data["amount"]) == D("200")
    assert not goal.data.get("payment_nodes")
    assert balance(book.space, book.bank, "cash") == D("1000")
    assert balance(book.space, other_bank, "cash") == D("800")
