"""Selected cash top-ups are opt-in, atomic, dated, attributed and repeat-safe."""

from datetime import date
from decimal import Decimal as D

import pytest
from test_dca_automation_v264 import book as shared_book
from test_dca_automation_v264 import plan, quote, run
from wealth.common import DomainError, tenant_context
from wealth.dca_automation import occurrence_processing
from wealth.ledger import balance, position, post_event, reverse_event
from wealth.models import Account, Event, Instrument, Occurrence, Resource, Workspace
from wealth.planning import save_resource

pytestmark = pytest.mark.django_db
book = shared_book


def source(book, amount="100", *, kind="bank", when="2026-08-01"):
    account = Account.objects.create(tenant=book.space, name="指定补足账户", kind=kind)
    if amount:
        post_event(
            book.space,
            book.user,
            {
                "kind": "opening",
                "account_id": str(account.pk),
                "economic_date": when,
                "amount": amount,
            },
        )
    return account


def spend(book, account, amount, when="2026-09-22"):
    return post_event(
        book.space,
        book.user,
        {
            "kind": "expense",
            "account_id": str(account.pk),
            "economic_date": when,
            "amount": amount,
        },
    )


def automatic(book, account=None, **extra):
    return {
        "enabled": True,
        "start_date": "2026-09-23",
        "holding_account_id": str(book.holding.pk),
        "fee_mode": "zero",
        "top_up_account_id": str(account.pk) if account else None,
        "top_up_start_date": "2026-09-23" if account else None,
        **extra,
    }


def topups(book):
    return Event.objects.filter(tenant=book.space, payload__dca_top_up_transfer=True)


def test_only_shortfall_transfers_and_late_nav_reuses_funding_fact(book):
    backup = source(book)
    spend(book, book.source, "97")
    value = plan(book, automation=automatic(book, backup))
    first = run(book, value)["items"][0]
    assert first["status"] == "waiting_nav"
    transfer = topups(book).get()
    debit = Event.objects.get(tenant=book.space, kind="fund_debit")
    assert D(transfer.payload["amount"]) == D(7)
    assert transfer.payload["account_id"] == str(backup.pk)
    assert transfer.payload["target_account_id"] == str(book.source.pk)
    assert transfer.payload["automatic_estimate"] is True
    assert transfer.payload["entry_basis"] == "preview_confirmed"
    assert transfer.economic_date == date(2026, 9, 23)
    assert debit.related_id == transfer.pk
    assert debit.operation_id == transfer.operation_id
    assert first["top_up_event_id"] == str(transfer.pk)
    assert D(first["top_up_amount"]) == D(7)
    assert balance(book.space, backup, "cash") == 93
    assert balance(book.space, book.source, "cash") == 0
    assert balance(book.space, book.source, "fund_transit") == 10
    # Fresh run (including a restarted worker) has no in-memory deduplication.
    run(book, Resource.objects.get(pk=value.pk))
    quote(book)
    final = run(book, Resource.objects.get(pk=value.pk))["items"][0]
    assert final["status"] == "recorded_estimate"
    assert final["top_up_event_id"] == str(transfer.pk)
    assert topups(book).count() == 1
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 1
    assert position(book.space, book.holding, book.instrument) == (D("5.56"), D(10))
    period = Resource.objects.get(tenant=book.space, kind="dca_import_periods")
    assert period.data["top_up_event_id"] == str(transfer.pk)


@pytest.mark.parametrize("configured", [False, True])
def test_sufficient_primary_never_uses_backup(book, configured):
    backup = source(book, "0")
    value = plan(book, automation=automatic(book, backup if configured else None))
    assert run(book, value)["items"][0]["status"] == "waiting_nav"
    assert not topups(book).exists()
    assert balance(book.space, book.source, "cash") == 90


def test_no_selection_keeps_old_plan_waiting_and_exposes_specific_help(book):
    source(book)
    spend(book, book.source, "100")
    value = plan(book)
    assert value.data["automation"]["top_up_account_id"] is None
    result = run(book, value)["items"][0]
    assert result["status"] == "waiting_cash"
    assert "选择补足资金账户" in result["message"]
    assert D(result["shortfall"]) == D(10)
    occurrence = Occurrence.objects.get(plan=value)
    assert occurrence_processing(occurrence)["message"] == result["message"]
    assert not topups(book).exists()
    assert not Event.objects.filter(tenant=book.space, kind="fund_debit").exists()


def test_insufficient_backup_has_no_partial_transfer_then_recovers(book):
    backup = source(book, "6")
    spend(book, book.source, "97")
    value = plan(book, automation=automatic(book, backup))
    state = run(book, value)["items"][0]
    assert state["status"] == "waiting_cash"
    assert D(state["top_up_available"]) == D(6)
    assert not topups(book).exists()
    assert balance(book.space, book.source, "cash") == 3
    post_event(
        book.space,
        book.user,
        {
            "kind": "income",
            "account_id": str(backup.pk),
            "economic_date": "2026-09-23",
            "amount": "1",
        },
    )
    assert run(book, value)["items"][0]["status"] == "waiting_nav"
    assert balance(book.space, backup, "cash") == 0
    assert D(topups(book).get().payload["amount"]) == D(7)


@pytest.mark.parametrize("kind", ["fund", "broker", "securities", "wallet", "cash"])
def test_retained_channel_cash_is_valid(book, kind):
    backup = source(book, "10", kind=kind)
    spend(book, book.source, "100")
    value = plan(book, automation=automatic(book, backup))
    assert run(book, value)["items"][0]["status"] == "waiting_nav"
    assert balance(book.space, backup, "cash") == 0


def test_money_fund_shares_do_not_become_available_cash(book):
    backup = source(book, None, kind="fund")
    money = Instrument.objects.create(
        tenant=book.space,
        name="现金宝货币基金",
        code="MONEY",
        kind="fund",
        specification={"is_money_fund": True},
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(backup.pk),
            "instrument_id": str(money.pk),
            "economic_date": "2026-08-01",
            "quantity": "100",
            "amount": "0",
            "cost": "100",
        },
    )
    spend(book, book.source, "100")
    value = plan(book, automation=automatic(book, backup))
    assert run(book, value)["items"][0]["status"] == "waiting_cash"
    assert not topups(book).exists()
    assert position(book.space, backup, money) == (D(100), D(100))


@pytest.mark.parametrize(
    "reason",
    [
        "same",
        "currency",
        "archived",
        "snapshot",
        "liability",
        "foreign",
        "missing_date",
        "early_date",
        "untracked",
    ],
)
def test_invalid_top_up_identity_and_scope_are_rejected(book, reason):
    backup = source(book)
    config = automatic(book, backup)
    extra = {}
    if reason == "same":
        config["top_up_account_id"] = str(book.source.pk)
    elif reason in {"currency", "archived", "snapshot", "liability"}:
        field, value = {
            "currency": ("currency", "USD"),
            "archived": ("archived", True),
            "snapshot": ("valuation_mode", "snapshot"),
            "liability": ("kind", "credit_card"),
        }[reason]
        setattr(backup, field, value)
        backup.save()
    elif reason == "foreign":
        other = Workspace.objects.create(name="隔离空间")
        with tenant_context(other.pk):
            foreign = Account.objects.create(tenant=other, name="他人账户", kind="bank")
        config["top_up_account_id"] = str(foreign.pk)
    elif reason == "missing_date":
        config.pop("top_up_start_date")
    elif reason == "early_date":
        config["top_up_start_date"] = "2026-09-22"
    elif reason == "untracked":
        config["funding_source"] = "untracked"
        extra["account_id"] = str(book.holding.pk)
    with pytest.raises(DomainError):
        plan(book, automation=config, **extra)
    assert not Resource.objects.filter(tenant=book.space, kind="plans").exists()
    assert not topups(book).exists()


@pytest.mark.parametrize(
    "reason", ["frozen", "later_spending", "late_income", "late_opening"]
)
def test_backdated_top_up_preserves_frozen_and_historical_cash(book, reason):
    backup = source(
        book, "10", when="2026-09-24" if reason == "late_opening" else "2026-08-01"
    )
    spend(book, book.source, "100")
    if reason == "frozen":
        backup.frozen = D(1)
        backup.save()
    elif reason == "later_spending":
        spend(book, backup, "1", "2026-09-24")
    elif reason == "late_income":
        spend(book, backup, "1", "2026-09-22")
        post_event(
            book.space,
            book.user,
            {
                "kind": "income",
                "account_id": str(backup.pk),
                "economic_date": "2026-09-24",
                "amount": "1",
            },
        )
    value = plan(book, automation=automatic(book, backup))
    state = run(book, value)["items"][0]
    assert state["status"] == (
        "needs_review" if reason == "late_opening" else "waiting_cash"
    )
    assert not topups(book).exists()
    assert not Event.objects.filter(tenant=book.space, kind="fund_debit").exists()


def test_explicit_effective_date_controls_old_waits_and_clearing_does_not_reenable(
    book,
):
    backup = source(book)
    spend(book, book.source, "100")
    value = plan(
        book, automation=automatic(book, backup, top_up_start_date="2026-09-24")
    )
    assert run(book, value)["items"][0]["status"] == "waiting_cash"
    assert not topups(book).exists()
    value = save_resource(
        book.space,
        book.user,
        "plans",
        {
            "automation": automatic(book, backup, top_up_start_date="2026-09-23"),
        },
        value,
        run_automatic=True,
    )
    transfer = topups(book).get()
    value = save_resource(
        book.space,
        book.user,
        "plans",
        {
            "automation": automatic(book, None),
        },
        value,
        run_automatic=True,
    )
    quote(book)
    state = run(book, value)["items"][0]
    assert state["status"] == "recorded_estimate"
    assert state["top_up_event_id"] == str(transfer.pk)
    assert topups(book).count() == 1
    assert value.data["automation"]["top_up_account_id"] is None
    assert value.data["automation"]["top_up_start_date"] is None


def test_debit_failure_rolls_back_transfer_and_retries_once(book, monkeypatch):
    backup = source(book)
    spend(book, book.source, "100")
    value = plan(book, automation=automatic(book, backup))
    original = post_event

    def fail_debit(space, user, data, **kwargs):
        if data["kind"] == "fund_debit":
            raise DomainError("模拟记账失败")
        return original(space, user, data, **kwargs)

    monkeypatch.setattr("wealth.ledger.post_event", fail_debit)
    invalid = run(book, value)["items"][0]
    assert invalid["status"] == "needs_review"
    assert invalid["reason_code"] == "invalid"
    assert not topups(book).exists()
    assert balance(book.space, backup, "cash") == 100
    assert balance(book.space, book.source, "cash") == 0
    monkeypatch.setattr("wealth.ledger.post_event", original)
    assert run(book, value)["items"][0]["status"] == "waiting_nav"
    assert topups(book).count() == 1


def test_actual_amount_correction_keeps_original_top_up_and_never_repeats_it(book):
    from test_fund_reconciliation_v210 import command, statement
    from wealth.fund_reconciliation import apply

    backup = source(book)
    spend(book, book.source, "100")
    value = plan(book, automation=automatic(book, backup))
    quote(book)
    run(book, value)
    transfer = topups(book).get()
    original_payload = dict(transfer.payload)
    batch, preview = statement(
        book,
        rows=[
            [
                "020602",
                "2026-09-23",
                "2026-09-24",
                "8",
                "4",
                "2",
                "0",
                "topup-correction",
            ]
        ],
    )
    row = preview["rows"][0]
    assert row["candidates"][0]["correction_allowed"] is True
    apply(
        book.space,
        book.user,
        batch,
        command(
            preview,
            decisions=[
                {
                    "row_id": row["id"],
                    "action": "correct",
                    "reason": "以机构账单8元为准",
                }
            ],
        ),
    )
    before = Event.objects.filter(tenant=book.space).count()
    state = run(book, value)["items"][0]
    assert state["status"] == "already_recorded"
    assert Event.objects.filter(tenant=book.space).count() == before
    assert topups(book).count() == 1
    assert topups(book).get().payload == original_payload
    assert balance(book.space, backup, "cash") == 90
    assert balance(book.space, book.source, "cash") == 2
    assert position(book.space, book.holding, book.instrument) == (D(4), D(8))


def test_unlinked_existing_top_up_is_attention_instead_of_another_transfer(book):
    backup = source(book)
    spend(book, book.source, "100")
    value = plan(book, automation=automatic(book, backup))
    post_event(
        book.space,
        book.user,
        {
            "kind": "transfer",
            "account_id": str(backup.pk),
            "target_account_id": str(book.source.pk),
            "economic_date": "2026-09-23",
            "amount": "10",
            "dca_top_up_transfer": True,
        },
        stage_key=f"{book.space.pk}:dca:{value.pk}:2026-09-23:top-up",
    )
    assert run(book, value)["items"][0]["status"] == "needs_review"
    assert topups(book).count() == 1
    assert not Event.objects.filter(tenant=book.space, kind="fund_debit").exists()


def test_archived_backup_cannot_fund_but_does_not_block_already_debited_period(book):
    backup = source(book)
    spend(book, book.source, "100")
    value = plan(book, automation=automatic(book, backup))
    backup.archived = True
    backup.save()
    invalid = run(book, value)["items"][0]
    assert invalid["status"] == "needs_review"
    assert invalid["reason_code"] == "dca_top_up_account_invalid"
    occurrence = Occurrence.objects.get(plan=value)
    assert occurrence_processing(occurrence)["reason_code"] == invalid["reason_code"]
    assert not topups(book).exists()
    backup.archived = False
    backup.save()
    assert run(book, value)["items"][0]["status"] == "waiting_nav"
    backup.archived = True
    backup.save()
    quote(book)
    assert run(book, value)["items"][0]["status"] == "recorded_estimate"
    assert topups(book).count() == 1


@pytest.mark.parametrize("changed", ["currency", "foreign_reference"])
def test_runtime_rechecks_backup_currency_and_tenant_before_funding(book, changed):
    backup = source(book)
    spend(book, book.source, "100")
    value = plan(book, automation=automatic(book, backup))
    if changed == "currency":
        backup.currency = "USD"
        backup.save()
    else:
        other = Workspace.objects.create(name="另一空间")
        with tenant_context(other.pk):
            foreign = Account.objects.create(tenant=other, name="外部账户", kind="bank")
        # Simulate a stale/imported configuration; the public save command
        # already rejects this reference before any Resource write.
        value.data["automation"]["top_up_account_id"] = str(foreign.pk)
        value.save()
    invalid = run(book, value)["items"][0]
    assert invalid["status"] == "needs_review"
    assert invalid["reason_code"] == "dca_top_up_account_invalid"
    assert not topups(book).exists()
    assert not Event.objects.filter(tenant=book.space, kind="fund_debit").exists()
    assert balance(book.space, backup, "cash") == 100


def test_refund_or_reversal_never_repeats_transfer(book):
    backup = source(book)
    spend(book, book.source, "100")
    value = plan(book, automation=automatic(book, backup))
    run(book, value)
    debit = Event.objects.get(tenant=book.space, kind="fund_debit")
    transfer = topups(book).get()
    with pytest.raises(DomainError, match="后续阶段"):
        reverse_event(book.space, book.user, transfer, "不可先撤补款")
    refund = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_refund",
            "account_id": str(book.source.pk),
            "related_event_id": str(debit.pk),
            "economic_date": "2026-09-23",
            "amount": "10",
        },
    )
    quote(book)
    assert run(book, value)["items"][0]["status"] == "needs_review"
    assert topups(book).count() == 1
    reverse_event(book.space, book.user, refund, "撤销退款")
    reverse_event(book.space, book.user, Event.objects.get(pk=debit.pk), "取消本期")
    assert run(book, value)["items"][0]["status"] == "needs_review"
    assert topups(book).count() == 1
    spend(book, book.source, "1", "2026-09-24")
    with pytest.raises(DomainError, match="后续使用或冻结"):
        reverse_event(
            book.space, book.user, Event.objects.get(pk=transfer.pk), "撤销补款"
        )
