"""Institution totals become cash plus securities without double-counting wealth."""

import json
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from wealth.common import DomainError, tenant_context
from wealth.investments import record_holding
from wealth.ledger import balance, post_event, reverse_event
from wealth.models import Account, Event, Instrument, Membership, Price, Workspace
from wealth.reporting import overview, performance

pytestmark = pytest.mark.django_db
D = Decimal
DATE = "2026-09-20"


@pytest.fixture
def book():
    user = get_user_model().objects.create_user("funding-v25-owner")
    space = Workspace.objects.create(name="机构资金拆分")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        account = Account.objects.create(tenant=space, name="摩根直销", kind="fund")
        bank = Account.objects.create(tenant=space, name="选定银行卡", kind="bank")
        fund = Instrument.objects.create(
            tenant=space, name="纳指基金", code="019172", kind="fund"
        )
        yield SimpleNamespace(
            space=space, user=user, account=account, bank=bank, fund=fund
        )


def opening(book, account, value, when=DATE):
    return post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(account.pk),
            "amount": value,
            "economic_date": when,
        },
    )


def holding(book, **kwargs):
    return record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "as_of": DATE,
            "purchase_date": "2026-09-01",
            "quantity": "45.49",
            "cost": "80",
            "current_value": "81.82",
            "funding_mode": "allocate",
            **kwargs,
        },
    )


def test_split_current_value_preserves_total_and_real_cost_and_profit(book):
    opening(book, book.account, "101.82")
    result = holding(book)
    assert balance(book.space, book.account, "cash") == D("20")
    assert D(result["holding"]["market_value"]) == D("81.82")
    assert D(result["holding"]["cost"]) == D("80")
    assert D(result["holding"]["profit"]) == D("1.82")
    assert D(overview(book.space, DATE)["net_assets"]) == D("101.82")
    assert D(performance(book.space, DATE, DATE)["net_profit"]) == 0
    assert D(result["funding"]["required"]) == D("81.82")
    assert result["funding"]["transfer_event_id"] is None


def test_money_fund_holding_is_not_left_in_cash_and_other_fund_needs_shortfall(book):
    opening(book, book.account, "100")
    cash_fund = Instrument.objects.create(
        tenant=book.space, name="天添盈E", code="000857", kind="fund"
    )
    holding(
        book,
        instrument_id=str(cash_fund.pk),
        quantity="20",
        cost="20",
        current_value="20",
    )
    assert balance(book.space, book.account, "cash") == D("80")
    with pytest.raises(DomainError) as caught:
        holding(book)
    assert caught.value.code == "insufficient_institution_cash"
    assert D(caught.value.fields["shortfall"]) == D("1.82")
    assert D(overview(book.space, DATE)["net_assets"]) == D("100")


def test_only_explicit_source_funds_exact_shortfall_and_total_is_unchanged(book):
    opening(book, book.account, "20")
    opening(book, book.bank, "200")
    result = holding(book, funding_account_id=str(book.bank.pk))
    assert D(result["funding"]["shortfall"]) == D("61.82")
    assert balance(book.space, book.account, "cash") == 0
    assert balance(book.space, book.bank, "cash") == D("138.18")
    assert D(overview(book.space, DATE)["net_assets"]) == D("220")
    report = performance(book.space, DATE, DATE)
    assert D(report["net_profit"]) == 0
    assert D(report["external_inflows"]) == D("81.82")
    transfer = Event.objects.get(pk=result["funding"]["transfer_event_id"])
    event = Event.objects.get(pk=result["event"]["id"])
    assert event.related_id == transfer.pk
    assert event.operation_id == transfer.operation_id
    with pytest.raises(DomainError, match="后续阶段"):
        reverse_event(book.space, book.user, transfer, "撤销拆分")
    reverse_event(book.space, book.user, event, "撤销拆分")
    reverse_event(book.space, book.user, transfer, "撤销补资")
    assert balance(book.space, book.account, "cash") == D("20")
    assert balance(book.space, book.bank, "cash") == D("200")
    assert D(overview(book.space, DATE)["net_assets"]) == D("220")


def test_preselected_source_is_not_debited_when_institution_has_enough(book):
    opening(book, book.account, "100")
    opening(book, book.bank, "200")
    result = holding(book, funding_account_id=str(book.bank.pk))
    assert result["funding"]["transfer_event_id"] is None
    assert balance(book.space, book.bank, "cash") == D("200")


def test_source_insufficient_rejects_atomically_and_never_selects_other_bank(book):
    opening(book, book.account, "20")
    opening(book, book.bank, "30")
    other = Account.objects.create(tenant=book.space, name="未选的银行", kind="bank")
    opening(book, other, "10000")
    before = Event.objects.count()
    with pytest.raises(DomainError) as caught:
        holding(book, funding_account_id=str(book.bank.pk))
    assert caught.value.code == "insufficient_source_cash"
    assert Event.objects.count() == before
    assert balance(book.space, book.account, "cash") == D("20")
    assert balance(book.space, other, "cash") == D("10000")


def test_failure_after_topup_rolls_back_topup_too(book):
    opening(book, book.account, "20")
    opening(book, book.bank, "200")
    holding(book, funding_mode="external")
    before = Event.objects.count()
    with pytest.raises(DomainError, match="不能重复录期初"):
        holding(book, funding_account_id=str(book.bank.pk))
    assert Event.objects.count() == before
    assert balance(book.space, book.bank, "cash") == D("200")
    assert balance(book.space, book.account, "cash") == D("20")


def test_loss_does_not_rewrite_cost_and_complete_loss_can_allocate_zero(book):
    opening(book, book.account, "50")
    result = holding(book, current_value="0")
    assert D(result["holding"]["cost"]) == D("80")
    assert D(result["holding"]["profit"]) == D("-80")
    assert balance(book.space, book.account, "cash") == D("50")
    assert D(performance(book.space, DATE, DATE)["net_profit"]) == 0


def test_current_profit_can_supply_the_checked_allocation_value(book):
    opening(book, book.account, "100")
    result = holding(book, current_value=None, current_profit="1.82")
    assert D(result["funding"]["required"]) == D("81.82")
    assert balance(book.space, book.account, "cash") == D("18.18")


def test_external_and_legacy_requests_keep_cash_and_do_not_invent_period_profit(book):
    opening(book, book.account, "100")
    result = record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "as_of": DATE,
            "quantity": "45.49",
            "cost": "80",
            "current_value": "81.82",
        },
    )
    assert result["funding"]["mode"] == "external"
    assert balance(book.space, book.account, "cash") == D("100")
    assert D(overview(book.space, DATE)["net_assets"]) == D("181.82")
    assert D(performance(book.space, DATE, DATE)["net_profit"]) == 0


def test_allocation_does_not_use_a_different_market_price_for_boundary_flow(book):
    opening(book, book.account, "100")
    Price.objects.create(
        tenant=book.space,
        instrument=book.fund,
        value="2",
        economic_date=DATE,
        kind="official_nav",
    )
    holding(book)
    assert D(performance(book.space, DATE, DATE)["net_profit"]) == 0


def test_backdating_cannot_spend_later_incoming_money(book):
    opening(book, book.account, "0")
    opening(book, book.bank, "0")
    post_event(
        book.space,
        book.user,
        {
            "kind": "income",
            "account_id": str(book.bank.pk),
            "amount": "200",
            "economic_date": "2026-09-21",
        },
    )
    with pytest.raises(DomainError) as caught:
        holding(book, funding_account_id=str(book.bank.pk))
    assert caught.value.code == "insufficient_source_cash"
    assert balance(book.space, book.bank, "cash", as_of=DATE) == 0


def test_backdating_reserves_later_outgoings_and_frozen_cash(book):
    opening(book, book.account, "100")
    book.account.frozen = D("5")
    book.account.save(update_fields=["frozen"])
    post_event(
        book.space,
        book.user,
        {
            "kind": "expense",
            "account_id": str(book.account.pk),
            "amount": "30",
            "economic_date": "2026-09-21",
        },
    )
    with pytest.raises(DomainError) as caught:
        holding(book)
    assert D(caught.value.fields["available"]) == D("65")
    assert D(caught.value.fields["shortfall"]) == D("16.82")


@pytest.mark.parametrize(
    "source_values",
    [
        {"currency": "USD"},
        {"kind": "loan"},
        {"valuation_mode": "snapshot"},
        {"archived": True},
    ],
)
def test_source_must_be_usable_same_currency_cash(book, source_values):
    for key, value in source_values.items():
        setattr(book.bank, key, value)
    book.bank.save(update_fields=list(source_values))
    with pytest.raises(DomainError):
        holding(book, funding_account_id=str(book.bank.pk))
    assert Event.objects.count() == 0


def test_other_tenants_source_is_never_accepted(book):
    other_space = Workspace.objects.create(name="另一个家庭")
    with tenant_context(other_space.pk):
        other = Account.objects.create(
            tenant=other_space, name="他人的现金", kind="bank"
        )
    with pytest.raises(DomainError) as caught:
        holding(book, funding_account_id=str(other.pk))
    assert caught.value.code == "not_found"
    assert Event.objects.filter(tenant=book.space).count() == 0


@pytest.mark.parametrize(
    "values,code",
    [
        ({"current_value": None}, "holding_value_required"),
        ({"funding_mode": "purchase"}, "holding_funding_mode"),
        ({"funding_instrument_id": "000857"}, "funding_product_not_cash"),
    ],
)
def test_ambiguous_funding_inputs_are_rejected(book, values, code):
    with pytest.raises(DomainError) as caught:
        holding(book, **values)
    assert caught.value.code == code
    assert Event.objects.count() == 0


def test_generic_events_cannot_bypass_funding_command(book):
    with pytest.raises(DomainError) as caught:
        post_event(
            book.space,
            book.user,
            {
                "kind": "opening",
                "account_id": str(book.account.pk),
                "instrument_id": str(book.fund.pk),
                "economic_date": DATE,
                "quantity": "45.49",
                "cost": "80",
                "funding_mode": "allocate",
                "funding_amount": "81.82",
            },
        )
    assert caught.value.code == "holding_funding_command_required"
    assert Event.objects.count() == 0


def test_api_retry_returns_same_allocation_without_debiting_twice(book, settings):
    settings.WEALTH_MARKET_DATA_ENABLED = False
    opening(book, book.account, "20")
    opening(book, book.bank, "200")
    client = Client()
    client.force_login(book.user)
    body = {
        "account_id": str(book.account.pk),
        "instrument_id": str(book.fund.pk),
        "as_of": DATE,
        "quantity": "45.49",
        "cost": "80",
        "current_value": "81.82",
        "funding_mode": "allocate",
        "funding_account_id": str(book.bank.pk),
    }
    kwargs = {
        "data": json.dumps(body),
        "content_type": "application/json",
        "HTTP_IDEMPOTENCY_KEY": "institution-split-once",
    }
    url = f"/api/v1/spaces/{book.space.pk}/holdings"
    first = client.post(url, **kwargs)
    assert first.status_code == 200, first.content
    second = client.post(url, **kwargs)
    assert second.status_code == 200, second.content
    assert first.json() == second.json()
    assert balance(book.space, book.bank, "cash") == D("138.18")
    assert Event.objects.filter(tenant=book.space, kind="transfer").count() == 1


def test_second_product_uses_updated_cash_and_cannot_reuse_allocated_balance(book):
    opening(book, book.account, "100")
    holding(book)
    other = Instrument.objects.create(
        tenant=book.space, name="第二只基金", code="SECOND", kind="fund"
    )
    with pytest.raises(DomainError) as caught:
        holding(
            book,
            instrument_id=str(other.pk),
            quantity="20",
            cost="20",
            current_value="20",
        )
    assert caught.value.code == "insufficient_institution_cash"
    assert D(caught.value.fields["available"]) == D("18.18")
    assert balance(book.space, book.account, "cash") == D("18.18")


def test_corrected_allocation_can_be_entered_after_reversal(book):
    opening(book, book.account, "100")
    result = holding(book)
    event = Event.objects.get(pk=result["event"]["id"])
    reverse_event(book.space, book.user, event, "份额录入有误")
    corrected = holding(book, quantity="45.5", current_value="81.84")
    assert D(corrected["holding"]["quantity"]) == D("45.5")
    assert D(overview(book.space, DATE)["net_assets"]) == D("100")
    assert balance(book.space, book.account, "cash") == D("18.16")


def test_reversing_topup_cannot_overdraw_money_already_used_later(book):
    opening(book, book.account, "0")
    opening(book, book.bank, "200")
    result = holding(book, funding_account_id=str(book.bank.pk))
    event = Event.objects.get(pk=result["event"]["id"])
    transfer = Event.objects.get(pk=result["funding"]["transfer_event_id"])
    reverse_event(book.space, book.user, event, "撤销持仓")
    post_event(
        book.space,
        book.user,
        {
            "kind": "expense",
            "account_id": str(book.account.pk),
            "amount": "10",
            "economic_date": "2026-09-21",
        },
    )
    with pytest.raises(DomainError) as caught:
        reverse_event(book.space, book.user, transfer, "撤销补资")
    assert caught.value.code == "funding_reversal_dependency"
    assert balance(book.space, book.account, "cash") == D("71.82")
