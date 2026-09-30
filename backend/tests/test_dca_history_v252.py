"""Daily fund history is a reviewable scenario, never inferred transactions."""

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from wealth.common import DomainError, tenant_context
from wealth.dca_history import (
    history_preview,
    placeholder_void_metadata,
    void_placeholder,
)
from wealth.investments import record_holding
from wealth.ledger import balance, post_event
from wealth.models import (
    Account,
    Event,
    Instrument,
    JournalLine,
    Membership,
    Occurrence,
    PositionMovement,
    Price,
    Resource,
    Workspace,
)

pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    user = get_user_model().objects.create_user("dca-history-owner")
    space = Workspace.objects.create(name="定投预览")
    Membership.objects.create(workspace=space, user=user, role="owner")
    client = Client()
    client.force_login(user)
    with tenant_context(space.pk):
        account = Account.objects.create(tenant=space, name="基金公司", kind="fund")
        instrument = Instrument.objects.create(
            tenant=space,
            name="纳指 QDII 基金",
            code="019172",
            kind="fund",
            specification={"calendar_id": "CN_EXCHANGE", "is_qdii": True},
        )
        plan = Resource.objects.create(
            tenant=space,
            kind="plans",
            data={
                "kind": "dca",
                "frequency": "daily",
                "amount": "10",
                "start_date": "2026-09-21",
                "account_id": str(account.pk),
                "instrument_id": str(instrument.pk),
                "currency": "CNY",
                "status": "active",
            },
        )
        yield SimpleNamespace(
            user=user,
            space=space,
            client=client,
            account=account,
            instrument=instrument,
            plan=plan,
        )


def quotes(book):
    for when, nav in [
        ("2026-09-21", "2"),
        ("2026-09-22", "2.5"),
        ("2026-09-23", "4"),
        ("2026-09-24", "5"),
    ]:
        Price.objects.create(
            tenant=book.space,
            instrument=book.instrument,
            economic_date=when,
            value=nav,
            kind="official_nav",
            source="test_nav",
        )


def preview(book, **extra):
    return history_preview(
        book.space,
        book.plan.pk,
        {"as_of": "2026-09-27", "end": "2026-09-27", "fee_mode": "zero", **extra},
    )


def facts(book):
    return {
        model.__name__: list(
            model.objects.filter(tenant=book.space).order_by("pk").values()
        )
        for model in [
            Account,
            Instrument,
            Event,
            JournalLine,
            PositionMovement,
            Price,
            Resource,
            Occurrence,
        ]
    }


def placeholder(book, **extra):
    return record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(book.instrument.pk),
            "as_of": "2026-09-24",
            "quantity": "0.00000001",
            "cost": "0",
            "current_value": "0",
            **extra,
        },
    )


def send(book, path, body, key=None):
    return book.client.post(
        f"/api/v1/spaces/{book.space.pk}{path}",
        data=json.dumps(body),
        content_type="application/json",
        **({"HTTP_IDEMPOTENCY_KEY": key} if key else {}),
    )


def test_four_ten_yuan_installments_use_trading_days_and_do_not_write_facts(book):
    quotes(book)
    before = facts(book)
    result = preview(book)
    assert result["is_estimate"] is True and result["creates_ledger_event"] is False
    assert len(result["items"]) == 4
    assert result["closed_dates"] == ["2026-09-25", "2026-09-26", "2026-09-27"]
    assert result["summary"]["scheduled_count"] == 4
    assert D(result["summary"]["expected_amount"]) == D("40")
    assert D(result["summary"]["selected_amount"]) == D("40")
    assert D(result["summary"]["estimated_quantity"]) == D("13.5")
    assert D(result["summary"]["estimated_value"]) == D("67.5")
    assert D(result["summary"]["estimated_profit"]) == D("27.5")
    assert [D(row["cumulative_amount"]) for row in result["items"]] == [10, 20, 30, 40]
    assert facts(book) == before


def test_qdii_last_installments_remain_theoretical_pending_units(book):
    quotes(book)
    result = preview(book)
    assert result["summary"]["estimated_pending_count"] == 2
    assert D(result["summary"]["estimated_pending_amount"]) == 20
    assert result["items"][-2]["expected_confirmation_date"] == "2026-09-28"
    assert result["items"][-1]["expected_confirmation_date"] == "2026-09-29"
    assert result["items"][-1]["pending_forecast"] is True
    assert result["includes_theoretical_unconfirmed_units"] is True
    assert any("QDII" in warning for warning in result["warnings"])
    assert not Occurrence.objects.exists()


def test_unknown_fees_still_show_distinct_before_fee_theory(book):
    quotes(book)
    result = preview(book, fee_mode="unknown")
    summary = result["summary"]
    assert summary["estimated_quantity"] is None
    assert summary["estimated_profit"] is None
    assert D(summary["theoretical_quantity"]) == D("13.5")
    assert D(summary["theoretical_value"]) == D("67.5")
    assert D(summary["theoretical_profit"]) == D("27.5")
    assert D(result["items"][-1]["cumulative_theoretical_quantity"]) == D("13.5")
    assert result["items"][-1]["cumulative_quantity"] is None
    assert result["items"][-1]["fee"] is None
    assert result["status"] == "partial"


def test_fixed_fees_are_inside_each_ten_yuan_payment(book):
    quotes(book)
    result = preview(book, fee_mode="fixed", fee_amount="1")
    assert D(result["summary"]["estimated_quantity"]) == D("12.15")
    assert D(result["summary"]["estimated_profit"]) == D("20.75")
    assert D(result["summary"]["theoretical_profit"]) == D("27.5")
    assert D(result["summary"]["selected_amount"]) == 40
    assert result["fee_policy"] == "deducted_from_each_installment_amount"


def test_failure_exclusions_and_pause_ranges_do_not_double_count(book):
    quotes(book)
    result = preview(
        book,
        excluded_dates=["2026-09-22", "2026-09-23", "2026-09-22"],
        pause_ranges=[{"start": "2026-09-23", "end": "2026-09-27"}],
    )
    assert result["summary"]["excluded_count"] == 3
    assert result["summary"]["selected_count"] == 1
    assert D(result["summary"]["expected_amount"]) == 40
    assert D(result["summary"]["selected_amount"]) == 10
    assert D(result["summary"]["estimated_quantity"]) == 5


def test_no_prior_nav_or_estimate_is_substituted_for_missing_exact_nav(book):
    quotes(book)
    Price.objects.filter(economic_date="2026-09-22").delete()
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date="2026-09-22",
        value="2.5",
        kind="estimate",
    )
    result = preview(book)
    missing = result["items"][1]
    assert missing["nav"] is None and missing["estimated_quantity"] is None
    assert missing["status"] == "missing_nav"
    assert result["summary"]["estimated_quantity"] is None
    assert D(result["summary"]["known_quantity"]) == D("9.5")
    assert D(result["summary"]["known_cost"]) == 30
    assert D(result["summary"]["known_profit"]) == D("17.5")
    assert result["items"][-1]["cumulative_quantity"] is None


def test_missing_nav_and_unknown_fees_both_remain_visible(book):
    result = preview(book, fee_mode="unknown")
    assert result["summary"]["theoretical_quantity"] is None
    assert any("费用" in gap for gap in result["gaps"])
    assert any("净值" in gap for gap in result["gaps"])


def test_uncovered_calendar_does_not_assume_weekdays_are_trading_days(book):
    result = preview(book, start="2024-09-20", end="2024-09-24", as_of="2024-09-24")
    assert len(result["items"]) == 5
    assert result["summary"]["scheduled_count"] == 0
    assert result["summary"]["unknown_calendar_count"] == 5
    assert result["summary"]["expected_amount"] is None
    assert result["summary"]["selected_amount"] is None
    assert all(row["is_scheduled"] is None for row in result["items"])


def test_published_holiday_including_makeup_workday_is_not_a_fund_order_day(book):
    result = preview(book, start="2026-02-13", end="2026-02-24", as_of="2026-02-24")
    assert [row["date"] for row in result["items"]] == ["2026-02-13", "2026-02-24"]
    assert D(result["summary"]["expected_amount"]) == 20


def test_end_nav_preserves_actual_date_and_marks_stale_without_filling_installments(
    book,
):
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date="2026-09-01",
        value="1",
        kind="official_nav",
    )
    result = preview(book)
    assert result["current_nav"]["date"] == "2026-09-01"
    assert result["current_nav"]["is_stale"] is True
    assert all(row["nav"] is None for row in result["items"])


def test_newer_reference_quote_is_not_terminal_official_nav(book):
    quotes(book)
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date="2026-09-26",
        value="99",
        kind="estimate",
    )
    result = preview(book)
    assert result["current_nav"]["date"] == "2026-09-24"
    assert D(result["current_nav"]["value"]) == 5


def test_known_corporate_action_is_not_silently_turned_into_new_units(book):
    quotes(book)
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.instrument.pk),
            "corporate_actions": [{"date": "2026-09-23", "description": "分红"}],
        },
    )
    result = preview(book)
    assert result["summary"]["estimated_quantity"] is None
    assert result["summary"]["theoretical_profit"] is None
    assert D(result["summary"]["known_quantity"]) == D("13.5")
    assert result["corporate_actions"]


def test_existing_holdings_trigger_overlap_but_do_not_get_added_to_preview(book):
    quotes(book)
    item = record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(book.instrument.pk),
            "as_of": "2026-09-24",
            "quantity": "100",
            "cost": "300",
            "current_value": "500",
        },
    )
    before = facts(book)
    result = preview(book)
    assert result["overlap"]["exists"] is True
    assert result["overlap"]["event_count"] == 1
    assert D(result["summary"]["estimated_quantity"]) == D("13.5")
    assert facts(book) == before
    assert item["event"]["id"]


@pytest.mark.parametrize(
    "change,code",
    [
        ({"frequency": "weekly"}, "dca_frequency_unsupported"),
        ({"frequency": "monthly"}, "dca_frequency_unsupported"),
        ({"interval": 2}, "dca_frequency_unsupported"),
        ({"count": 20}, "dca_count_unsupported"),
        ({"currency": "USD"}, "dca_currency"),
    ],
)
def test_unsupported_plan_semantics_are_not_silently_reinterpreted(book, change, code):
    book.plan.data.update(change)
    book.plan.save()
    with pytest.raises(DomainError) as caught:
        preview(book)
    assert caught.value.code == code


@pytest.mark.parametrize(
    "body",
    [
        {"fee_mode": "fixed", "fee_amount": "10"},
        {"fee_mode": "fixed", "fee_amount": "-1"},
        {"fee_mode": "fixed"},
        {"fee_mode": "unknown", "fee_amount": "1"},
        {"fee_mode": "zero", "fee_amount": "1"},
        {"pause_ranges": [{"start": "2026-09-24", "end": "2026-09-21"}]},
        {"excluded_dates": ["2026-09-01"]},
        {"end": "2026-09-28"},
        {"start": "2020-01-01"},
        {"amount": "100"},
        {"excluded_dates": "2026-09-21"},
    ],
)
def test_invalid_preview_inputs_reject_without_changing_plan(book, body):
    before = facts(book)
    with pytest.raises(DomainError):
        preview(book, **body)
    assert facts(book) == before


def test_preview_http_needs_no_write_idempotency_and_repeated_calls_change_nothing(
    book,
):
    quotes(book)
    before = facts(book)
    path = f"/plans/{book.plan.pk}/history-preview"
    body = {"as_of": "2026-09-27", "fee_mode": "zero"}
    first, second = send(book, path, body), send(book, path, body)
    assert first.status_code == second.status_code == 200, first.content
    assert first.json() == second.json()
    assert facts(book) == before


def test_viewer_can_preview_but_cannot_void_or_change_a_plan(book):
    item = placeholder(book)
    Membership.objects.filter(workspace=book.space, user=book.user).update(
        role="viewer"
    )
    before = facts(book)
    response = send(
        book, f"/plans/{book.plan.pk}/history-preview", {"as_of": "2026-09-27"}
    )
    assert response.status_code == 200, response.content
    response = send(
        book,
        f"/holdings/{item['event']['id']}/void-placeholder",
        {"expected_revision": book.space.revision, "reason": "无权限"},
        str(uuid.uuid4()),
    )
    assert response.status_code == 403
    assert facts(book) == before


@pytest.mark.parametrize(
    "name,spec",
    [
        ("普通名称", {"fund_type": "005"}),
        ("货币基金A", {}),
        ("现金宝", {"fund_type": "货币型"}),
        ("货币管理", {"is_money_fund": True}),
    ],
)
def test_money_market_fund_is_not_treated_as_one_yuan_unit_nav(book, name, spec):
    book.instrument.name, book.instrument.specification = name, spec
    book.instrument.save()
    with pytest.raises(DomainError) as caught:
        preview(book)
    assert caught.value.code == "unsupported_money_fund"


def test_no_priceable_installment_is_unknown_not_zero_profit(book):
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date="2026-09-01",
        value="1",
        kind="official_nav",
    )
    result = preview(book, fee_mode="unknown")
    for key in [
        "known_quantity",
        "known_value",
        "known_profit",
        "known_theoretical_quantity",
        "known_theoretical_value",
        "known_theoretical_profit",
    ]:
        assert result["summary"][key] is None
    assert result["summary"]["known_theoretical_count"] == 0


def test_all_installments_excluded_really_has_zero_scenario_investment(book):
    result = preview(
        book,
        fee_mode="unknown",
        pause_ranges=[{"start": "2026-09-21", "end": "2026-09-27"}],
    )
    assert D(result["summary"]["selected_amount"]) == 0
    assert D(result["summary"]["theoretical_quantity"]) == 0
    assert D(result["summary"]["known_profit"]) == 0


def test_decimal_tenths_and_repeating_shares_are_never_binary_float(book):
    book.plan.data["amount"] = "0.1"
    book.plan.save()
    quotes(book)
    Price.objects.update(value="0.3")
    result = preview(book)
    assert result["summary"]["selected_amount"] == "0.4"
    assert result["summary"]["estimated_quantity"] == "1.333333333333333332"
    assert D(result["summary"]["estimated_value"]) == D("0.3999999999999999996")


def test_foreign_plan_id_is_tenant_scoped(book):
    other = Workspace.objects.create(name="他人账簿")
    with tenant_context(other.pk):
        foreign = Resource.objects.create(
            tenant=other, kind="plans", data=book.plan.data
        )
    with pytest.raises(DomainError) as caught:
        history_preview(book.space, foreign.pk, {})
    assert caught.value.status == 404


def test_zero_cost_zero_value_tiny_placeholder_void_is_atomic_and_cash_neutral(book):
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(book.account.pk),
            "economic_date": "2026-09-24",
            "amount": "100",
        },
    )
    item = placeholder(book, funding_mode="allocate")
    assert item["holding"]["placeholder_void"]["eligible"] is True
    before_cash = balance(book.space, book.account, "cash")
    result = void_placeholder(
        book.space,
        book.user,
        item["event"]["id"],
        {
            "expected_revision": book.space.revision,
            "reason": "撤销为设置定投建立的占位记录",
        },
    )
    assert result["affects_cash"] is False
    assert result["event"]["kind"] == "reversal"
    assert balance(book.space, book.account, "cash") == before_cash == 100
    assert Event.objects.filter(pk=item["event"]["id"]).exists()
    assert Resource.objects.filter(pk=book.plan.pk).exists()
    assert not placeholder_void_metadata(
        book.space, Event.objects.get(pk=item["event"]["id"])
    )["eligible"]


@pytest.mark.parametrize(
    "extra", [{"quantity": "0.00000002"}, {"cost": "0.01"}, {"current_value": "0.01"}]
)
def test_real_or_nonzero_holding_cannot_be_voided_as_placeholder(book, extra):
    item = placeholder(book, **extra)
    assert item["holding"]["placeholder_void"]["eligible"] is False
    with pytest.raises(DomainError) as caught:
        void_placeholder(
            book.space,
            book.user,
            item["event"]["id"],
            {"expected_revision": book.space.revision, "reason": "不能误撤真实资产"},
        )
    assert caught.value.code == "placeholder_ineligible"


def test_later_trade_blocks_placeholder_void(book):
    item = placeholder(book)
    post_event(
        book.space,
        book.user,
        {
            "kind": "split",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.instrument.pk),
            "economic_date": "2026-09-25",
            "ratio": "2",
        },
    )
    event = Event.objects.get(pk=item["event"]["id"])
    assert placeholder_void_metadata(book.space, event)["eligible"] is False
    with pytest.raises(DomainError):
        void_placeholder(
            book.space,
            book.user,
            event.pk,
            {"expected_revision": book.space.revision, "reason": "已有后续"},
        )


def test_placeholder_void_revision_and_http_idempotency(book):
    item = placeholder(book)
    path = f"/holdings/{item['event']['id']}/void-placeholder"
    body = {"expected_revision": book.space.revision, "reason": "误设占位"}
    assert send(book, path, body).status_code == 400
    stale = send(book, path, {**body, "expected_revision": 0}, str(uuid.uuid4()))
    assert stale.status_code == 412
    key = str(uuid.uuid4())
    first = send(book, path, body, key)
    assert first.status_code == 200, first.content
    count = Event.objects.count()
    second = send(book, path, body, key)
    assert second.status_code == 200, second.content
    assert first.json() == second.json()
    assert Event.objects.count() == count
