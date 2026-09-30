"""Real historical DCA facts require evidence, funding, and durable identities."""

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from wealth.common import DomainError, tenant_context
from wealth.dca_import import KIND, commit_import, import_status, validate_import
from wealth.investments import record_holding
from wealth.ledger import balance, position, post_event, reverse_event
from wealth.models import (
    Account,
    Audit,
    Event,
    Idempotency,
    Instrument,
    JournalLine,
    Membership,
    Occurrence,
    PositionMovement,
    Price,
    Resource,
    ResourceRevision,
    Workspace,
)
from wealth.planning import generate_schedule, save_resource
from wealth.reporting import overview

pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    user = get_user_model().objects.create_user("dca-import-owner")
    space = Workspace.objects.create(name="实际定投补录")
    Membership.objects.create(workspace=space, user=user, role="owner")
    client = Client()
    client.force_login(user)
    with tenant_context(space.pk):
        bank = Account.objects.create(tenant=space, kind="bank", name="实际扣款银行")
        fund = Account.objects.create(tenant=space, kind="fund", name="产品持仓机构")
        instrument = Instrument.objects.create(
            tenant=space, kind="fund", name="QDII实际确认", code="019173"
        )
        plan = Resource.objects.create(
            tenant=space,
            kind="plans",
            data={
                "kind": "dca",
                "frequency": "daily",
                "amount": "10",
                "start_date": "2026-09-21",
                "currency": "CNY",
                "account_id": str(fund.pk),
                "instrument_id": str(instrument.pk),
                "status": "active",
            },
        )
        for account, amount in [(bank, "1000"), (fund, "0")]:
            post_event(
                space,
                user,
                {
                    "kind": "opening",
                    "account_id": str(account.pk),
                    "amount": amount,
                    "economic_date": "2026-08-01",
                },
            )
        for when, nav in [
            ("2026-09-21", "2"),
            ("2026-09-22", "2.5"),
            ("2026-09-23", "4"),
            ("2026-09-24", "5"),
        ]:
            Price.objects.create(
                tenant=space,
                instrument=instrument,
                economic_date=when,
                kind="official_nav",
                value=nav,
            )
        yield SimpleNamespace(
            space=space,
            user=user,
            client=client,
            bank=bank,
            fund=fund,
            instrument=instrument,
            plan=plan,
        )


def period(book, date="2026-09-21", **extra):
    return {
        "scheduled_date": date,
        "debit_date": date,
        "amount": "10",
        "funding_account_id": str(book.bank.pk),
        "status": "debited",
        **extra,
    }


def confirmed(book, date="2026-09-21", **extra):
    return period(
        book,
        date,
        **{
            "status": "confirmed",
            "confirmation_date": "2026-09-23",
            "quantity": "5",
            "nav": "2",
            "fee": "0",
            **extra,
        },
    )


def body(book, rows):
    return {"holding_account_id": str(book.fund.pk), "rows": rows}


def submit(book, rows):
    data = body(book, rows)
    checked = validate_import(book.space, book.plan.pk, data)
    assert checked["ready"], checked
    return commit_import(
        book.space,
        book.user,
        book.plan.pk,
        {
            **data,
            "expected_revision": checked["data_revision"],
            "expected_plan_version": checked["plan_version"],
            "validation_digest": checked["validation_digest"],
            "confirm_actual_records": True,
        },
    )


def facts(book):
    return {
        model.__name__: list(
            model.objects.filter(tenant=book.space).order_by("pk").values()
        )
        for model in [
            Account,
            Event,
            JournalLine,
            PositionMovement,
            Resource,
            ResourceRevision,
            Occurrence,
            Audit,
            Idempotency,
            Price,
        ]
    }


def send(book, suffix, data, key=None):
    return book.client.post(
        f"/api/v1/spaces/{book.space.pk}/plans/{book.plan.pk}/history-import/{suffix}",
        data=json.dumps(data),
        content_type="application/json",
        **({"HTTP_IDEMPOTENCY_KEY": key} if key else {}),
    )


def test_pending_then_later_confirmation_in_original_date_is_additive_and_cash_neutral(
    book,
):
    rows = [
        period(book),
        confirmed(
            book, "2026-09-22", confirmation_date="2026-09-24", quantity="4", nav="2.5"
        ),
    ]
    before = facts(book)
    validation = validate_import(book.space, book.plan.pk, body(book, rows))
    assert validation["ready"] and facts(book) == before
    first = submit(book, rows)
    assert first["summary"]["new_debits"] == 2
    assert balance(book.space, book.bank, "cash") == 980
    assert balance(book.space, book.bank, "fund_transit") == 10
    assert position(book.space, book.fund, book.instrument) == (D(4), D(10))
    assert D(overview(book.space, "2026-09-24")["net_assets"]) == 1010
    # Earlier actual confirmation resumes the first period, never re-debits.
    second = submit(book, [confirmed(book)])
    assert second["summary"]["new_debits"] == 0
    assert second["summary"]["new_confirmations"] == 1
    assert Event.objects.filter(kind="fund_debit").count() == 2
    assert balance(book.space, book.bank, "cash") == 980
    assert balance(book.space, book.bank, "fund_transit") == 0
    assert position(book.space, book.fund, book.instrument) == (D(9), D(20))
    assert D(overview(book.space, "2026-09-24")["net_assets"]) == 1025
    again = submit(book, [confirmed(book)])
    assert again["summary"]["skipped"] == 1
    assert again["creates_ledger_event"] is False


def test_existing_pending_can_be_loaded_and_confirmed_without_retyping_cash(book):
    submit(book, [period(book)])
    status = import_status(book.space, book.plan.pk)
    original = status["items"][0]
    result = submit(
        book,
        [
            {
                "scheduled_date": "2026-09-21",
                "status": "confirmed",
                "confirmation_date": "2026-09-23",
                "quantity": "5",
                "nav": "2",
                "fee": "0",
            }
        ],
    )
    assert result["items"][0]["period"]["debit_event_id"] == original["debit_event_id"]
    assert result["items"][0]["period"]["version"] == 2
    assert Event.objects.filter(kind="fund_debit").count() == 1


def test_actual_payer_and_amount_are_per_occurrence_without_rewriting_plan(book):
    generate_schedule(book.space, book.user, book.plan, "2026-09-22")
    original = dict(book.plan.data)
    submit(book, [period(book, "2026-09-22", amount="9")])
    occurrence = Occurrence.objects.get(plan=book.plan, due_date="2026-09-22")
    assert occurrence.sequence == 2
    assert occurrence.amount == 9
    assert occurrence.details["account_id"] == str(book.bank.pk)
    assert occurrence.details["original_plan_account_id"] == str(book.fund.pk)
    assert D(occurrence.details["original_plan_amount"]) == 10
    assert occurrence.event.kind == "fund_debit"
    assert occurrence.status == "confirmed"
    generate_schedule(book.space, book.user, book.plan, "2026-09-24")
    occurrence.refresh_from_db()
    book.plan.refresh_from_db()
    assert occurrence.status == "confirmed" and occurrence.amount == 9
    assert book.plan.data == original


def test_daily_natural_calendar_sequence_is_not_preview_sequence(book):
    book.plan.data["start_date"] = "2026-09-18"
    book.plan.save()
    submit(book, [period(book, "2026-09-21")])
    assert Occurrence.objects.get(plan=book.plan, due_date="2026-09-21").sequence == 4


@pytest.mark.parametrize(
    "change",
    [{"debit_date": "2026-09-22"}, {"amount": "11"}, {"funding_account_id": "holding"}],
)
def test_existing_debit_facts_are_immutable(book, change):
    submit(book, [period(book)])
    if change.get("funding_account_id") == "holding":
        change["funding_account_id"] = str(book.fund.pk)
    checked = validate_import(
        book.space, book.plan.pk, body(book, [{**confirmed(book), **change}])
    )
    assert not checked["ready"]
    assert checked["rows"][0]["errors"][0]["code"] == "dca_debit_conflict"
    assert balance(book.space, book.bank, "cash") == 990


def test_two_digit_actual_units_need_explicit_small_rounding_acknowledgement(book):
    row = confirmed(book, quantity="4.07", nav="2.4567")
    checked = validate_import(book.space, book.plan.pk, body(book, [row]))
    assert not checked["ready"]
    adjustment = checked["rows"][0]["suggested_rounding_adjustment"]
    assert D(adjustment) == D("0.001231")
    result = submit(
        book, [{**row, "rounding_adjustment": adjustment, "rounding_confirmed": True}]
    )
    saved = result["items"][0]["period"]
    assert saved["rounding_confirmed"] is True
    event = Event.objects.get(pk=saved["confirmation_event_id"])
    assert D(event.payload["fee"]) == 0
    assert D(event.payload["rounding_adjustment"]) == D("0.001231")
    assert position(book.space, book.fund, book.instrument) == (D("4.07"), D("10"))
    assert balance(book.space, book.bank, "fund_transit") == 0
    assert not event.lines.filter(code__in=["income", "expense"]).exists()


def test_negative_tail_is_supported_only_when_explicit_and_bounded(book):
    submit(
        book,
        [
            confirmed(
                book,
                quantity="5.001",
                rounding_adjustment="-0.002",
                rounding_confirmed=True,
            )
        ],
    )
    assert position(book.space, book.fund, book.instrument) == (D("5.001"), D(10))


@pytest.mark.parametrize(
    "extra",
    [
        {"quantity": "4", "rounding_adjustment": "2", "rounding_confirmed": True},
        {
            "quantity": "4.999",
            "rounding_adjustment": "0.002",
            "rounding_confirmed": False,
        },
        {
            "quantity": "4.999",
            "rounding_adjustment": "0.002",
            "rounding_confirmed": "true",
        },
        {
            "quantity": "4.999",
            "rounding_adjustment": "0.001",
            "rounding_confirmed": True,
        },
    ],
)
def test_tail_never_hides_an_unacknowledged_or_large_discrepancy(book, extra):
    checked = validate_import(
        book.space, book.plan.pk, body(book, [{**confirmed(book), **extra}])
    )
    assert not checked["ready"]
    assert checked["rows"][0]["errors"][0]["code"] == "dca_rounding_unconfirmed"


def test_generic_event_payload_cannot_activate_private_rounding_context(book):
    debit = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.bank.pk),
            "amount": "10",
            "economic_date": "2026-09-21",
        },
    )
    with pytest.raises(DomainError) as caught:
        post_event(
            book.space,
            book.user,
            {
                "kind": "fund_confirm",
                "account_id": str(book.fund.pk),
                "related_event_id": str(debit.pk),
                "instrument_id": str(book.instrument.pk),
                "quantity": "4.999",
                "price": "2",
                "fee": "0",
                "rounding_adjustment": "0.002",
                "rounding_confirmed": True,
                "economic_date": "2026-09-23",
                "_fund_confirmation": {"confirmed_amount": "10"},
            },
        )
    assert caught.value.code == "fund_rounding_command_required"
    assert not PositionMovement.objects.exists()


def test_cash_check_includes_later_existing_expenses_and_combined_batch_debits(book):
    post_event(
        book.space,
        book.user,
        {
            "kind": "expense",
            "account_id": str(book.bank.pk),
            "amount": "985",
            "economic_date": "2026-09-26",
        },
    )
    rows = [period(book), period(book, "2026-09-22")]
    checked = validate_import(book.space, book.plan.pk, body(book, rows))
    assert not checked["ready"]
    assert not checked["rows"][0]["errors"]
    assert checked["rows"][1]["errors"][0]["code"] == "insufficient_source_cash"
    assert balance(book.space, book.bank, "cash") == 15


def test_cannot_use_future_deposit_to_pay_an_earlier_installment(book):
    post_event(
        book.space,
        book.user,
        {
            "kind": "expense",
            "account_id": str(book.bank.pk),
            "amount": "1000",
            "economic_date": "2026-09-20",
        },
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "income",
            "account_id": str(book.bank.pk),
            "amount": "1000",
            "economic_date": "2026-09-22",
        },
    )
    checked = validate_import(book.space, book.plan.pk, body(book, [period(book)]))
    assert not checked["ready"]
    assert checked["rows"][0]["errors"][0]["code"] == "insufficient_source_cash"


def test_before_opening_is_blocked_without_changing_today_balance(book):
    late = Account.objects.create(tenant=book.space, kind="bank", name="今日期初")
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(late.pk),
            "amount": "1000",
            "economic_date": "2026-09-27",
        },
    )
    checked = validate_import(
        book.space,
        book.plan.pk,
        body(book, [period(book, funding_account_id=str(late.pk))]),
    )
    assert not checked["ready"]
    assert checked["rows"][0]["errors"][0]["code"] == "before_opening"


def test_existing_same_account_holdings_or_manual_orders_block_double_count(book):
    record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.fund.pk),
            "instrument_id": str(book.instrument.pk),
            "quantity": "5",
            "cost": "10",
            "current_value": "25",
            "as_of": "2026-09-24",
        },
    )
    checked = validate_import(book.space, book.plan.pk, body(book, [confirmed(book)]))
    assert not checked["ready"]
    assert checked["blockers"][0]["code"] == "dca_existing_history"


def test_distinct_institution_holding_in_same_fund_is_not_a_duplicate(book):
    other = Account.objects.create(tenant=book.space, kind="fund", name="另一家机构")
    record_holding(
        book.space,
        book.user,
        {
            "account_id": str(other.pk),
            "instrument_id": str(book.instrument.pk),
            "quantity": "5",
            "cost": "10",
            "current_value": "25",
            "as_of": "2026-09-24",
        },
    )
    assert validate_import(book.space, book.plan.pk, body(book, [confirmed(book)]))[
        "ready"
    ]


def test_manual_pending_order_from_same_bank_is_ambiguous_and_blocked(book):
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.bank.pk),
            "instrument_id": str(book.instrument.pk),
            "amount": "10",
            "economic_date": "2026-09-20",
        },
    )
    assert not validate_import(book.space, book.plan.pk, body(book, [confirmed(book)]))[
        "ready"
    ]


def test_actual_confirmed_chain_to_other_institution_is_allowed(book):
    other = Account.objects.create(tenant=book.space, kind="fund", name="另一持仓机构")
    debit = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.bank.pk),
            "instrument_id": str(book.instrument.pk),
            "amount": "10",
            "economic_date": "2026-09-20",
        },
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_confirm",
            "account_id": str(other.pk),
            "instrument_id": str(book.instrument.pk),
            "related_event_id": str(debit.pk),
            "quantity": "5",
            "price": "2",
            "amount": "10",
            "economic_date": "2026-09-23",
        },
    )
    assert validate_import(book.space, book.plan.pk, body(book, [confirmed(book)]))[
        "ready"
    ]


def test_forged_payload_tag_without_registry_and_stage_key_is_not_trusted(book):
    event = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.bank.pk),
            "instrument_id": str(book.instrument.pk),
            "amount": "10",
            "economic_date": "2026-09-21",
            "dca_import_plan_id": str(book.plan.pk),
            "dca_import_date": "2026-09-21",
        },
    )
    Resource.objects.create(
        tenant=book.space,
        kind=KIND,
        data={
            **period(book),
            "plan_id": str(book.plan.pk),
            "holding_account_id": str(book.fund.pk),
            "instrument_id": str(book.instrument.pk),
            "debit_event_id": str(event.pk),
            "confirmation_event_id": None,
        },
    )
    checked = validate_import(book.space, book.plan.pk, body(book, [confirmed(book)]))
    assert not checked["ready"]
    assert any(item["code"] == "dca_registry_conflict" for item in checked["blockers"])


def test_reversed_original_period_does_not_get_silently_debited_again(book):
    original = submit(book, [period(book)])["items"][0]["period"]
    reverse_event(
        book.space,
        book.user,
        Event.objects.get(pk=original["debit_event_id"]),
        "撤销实际扣款",
    )
    assert not validate_import(book.space, book.plan.pk, body(book, [period(book)]))[
        "ready"
    ]
    assert Event.objects.filter(kind="fund_debit").count() == 1


def test_manual_later_split_disables_private_additive_confirmation_exception(book):
    submit(
        book,
        [
            period(book),
            confirmed(
                book,
                "2026-09-22",
                quantity="4",
                nav="2.5",
                confirmation_date="2026-09-24",
            ),
        ],
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "split",
            "account_id": str(book.fund.pk),
            "instrument_id": str(book.instrument.pk),
            "ratio": "2",
            "economic_date": "2026-09-25",
        },
    )
    checked = validate_import(book.space, book.plan.pk, body(book, [confirmed(book)]))
    assert not checked["ready"]
    assert any(row["code"] == "dca_existing_history" for row in checked["blockers"])


@pytest.mark.parametrize(
    "extra",
    [
        {"quantity": None},
        {"nav": None},
        {"fee": None},
        {"confirmation_date": None},
        {"confirmation_date": "2099-01-01"},
        {"debit_date": "2099-01-01"},
        {"confirmation_date": "2026-09-20"},
    ],
)
def test_actual_confirmation_fields_are_never_inferred(book, extra):
    checked = validate_import(
        book.space, book.plan.pk, body(book, [{**confirmed(book), **extra}])
    )
    assert not checked["ready"]
    assert not Event.objects.filter(kind__in=["fund_debit", "fund_confirm"]).exists()


def test_batch_failure_during_confirmation_rolls_back_debits_occurrences_registry(
    book, monkeypatch
):
    import wealth.dca_import as module

    data = body(book, [confirmed(book)])
    checked = validate_import(book.space, book.plan.pk, data)
    before = facts(book)
    original_post = module.post_event

    def fail_confirm(*args, **kwargs):
        if args[2]["kind"] == "fund_confirm":
            raise DomainError("模拟确认失败")
        return original_post(*args, **kwargs)

    monkeypatch.setattr(module, "post_event", fail_confirm)
    with pytest.raises(DomainError):
        commit_import(
            book.space,
            book.user,
            book.plan.pk,
            {
                **data,
                "expected_revision": checked["data_revision"],
                "expected_plan_version": checked["plan_version"],
                "validation_digest": checked["validation_digest"],
                "confirm_actual_records": True,
            },
        )
    assert facts(book) == before


def test_validate_viewer_is_pure_read_but_commit_requires_write_permission(book):
    Membership.objects.filter(workspace=book.space, user=book.user).update(
        role="viewer"
    )
    before = facts(book)
    response = send(book, "validate", body(book, [confirmed(book)]))
    assert response.status_code == 200 and response.json()["ready"], response.content
    assert facts(book) == before
    assert send(book, "commit", {}, str(uuid.uuid4())).status_code == 403
    assert send(book, "unknown", {}).status_code == 403


def test_idempotent_commit_retries_work_after_revision_changes(book):
    data = body(book, [confirmed(book)])
    validation = send(book, "validate", data).json()
    request = {
        **data,
        "expected_revision": validation["data_revision"],
        "expected_plan_version": validation["plan_version"],
        "validation_digest": validation["validation_digest"],
        "confirm_actual_records": True,
    }
    key = str(uuid.uuid4())
    first = send(book, "commit", request, key)
    assert first.status_code == 200, first.content
    before = facts(book)
    second = send(book, "commit", request, key)
    assert second.status_code == 200 and first.json() == second.json()
    assert facts(book) == before
    assert send(book, "commit", request, str(uuid.uuid4())).status_code == 412


def test_changing_form_after_validation_requires_revalidation(book):
    data = body(book, [period(book)])
    validation = validate_import(book.space, book.plan.pk, data)
    data["rows"][0]["amount"] = "11"
    with pytest.raises(DomainError) as caught:
        commit_import(
            book.space,
            book.user,
            book.plan.pk,
            {
                **data,
                "expected_revision": validation["data_revision"],
                "expected_plan_version": validation["plan_version"],
                "validation_digest": validation["validation_digest"],
                "confirm_actual_records": True,
            },
        )
    assert caught.value.code == "version_conflict"


def test_protected_registry_cannot_be_written_through_generic_resource_service(book):
    with pytest.raises(DomainError):
        save_resource(book.space, book.user, KIND, {"plan_id": str(book.plan.pk)})


def test_tenant_account_and_product_scope_never_leak_into_batch(book):
    other = Workspace.objects.create(name="其他空间")
    with tenant_context(other.pk):
        foreign = Account.objects.create(tenant=other, kind="bank", name="他人资金")
    checked = validate_import(
        book.space,
        book.plan.pk,
        body(book, [period(book, funding_account_id=str(foreign.pk))]),
    )
    assert not checked["ready"]
    assert checked["rows"][0]["errors"][0]["code"] == "not_found"


def test_duplicate_dates_in_one_batch_are_not_double_debited(book):
    checked = validate_import(
        book.space, book.plan.pk, body(book, [period(book), period(book)])
    )
    assert not checked["ready"]
    assert checked["rows"][1]["errors"][0]["code"] == "dca_duplicate_period"
