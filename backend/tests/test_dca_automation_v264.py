"""Automatic DCA remains opt-in, attributed, staged, solvent and idempotent."""

from datetime import date, timedelta
from decimal import Decimal as D
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from wealth.common import DomainError, tenant_context
from wealth.dca_automation import automation_status, run_plan
from wealth.ledger import balance, position, post_event, reverse_event
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
from wealth.planning import confirm_occurrence, save_resource
from wealth.reporting import positions

pytestmark = pytest.mark.django_db


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 9, 24))
    user = get_user_model().objects.create_user("automatic-dca")
    space = Workspace.objects.create(name="自动定投回归")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        source = Account.objects.create(tenant=space, name="银行卡", kind="bank")
        holding = Account.objects.create(tenant=space, name="基金账户", kind="fund")
        instrument = Instrument.objects.create(
            tenant=space,
            name="易方达红利低波基金",
            code="020602",
            kind="fund",
            market="CN",
            specification={"confirmation_days": 1},
        )
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(source.pk),
                "economic_date": "2026-08-01",
                "amount": "100",
            },
        )
        yield SimpleNamespace(
            space=space,
            user=user,
            source=source,
            holding=holding,
            instrument=instrument,
        )


def plan(book, **extra):
    data = {
        "name": "每日10元",
        "kind": "dca",
        "account_id": str(book.source.pk),
        "instrument_id": str(book.instrument.pk),
        "start_date": "2026-09-23",
        "end_date": "2026-09-23",
        "frequency": "daily",
        "amount": "10",
        "currency": "CNY",
        "status": "active",
        "automation": {
            "enabled": True,
            "start_date": "2026-09-23",
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "zero",
        },
        **extra,
    }
    return save_resource(book.space, book.user, "plans", data)


def quote(book, **extra):
    return Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date=date(2026, 9, 23),
        kind="official_nav",
        value="1.7987",
        **extra,
    )


def run(book, plan):
    return run_plan(book.space, book.user, plan.pk)


def test_disabled_and_explicit_start_do_not_silently_import_all_past(book):
    value = plan(book, automation={"enabled": False})
    assert run(book, value)["processed"] == 0
    assert Event.objects.filter(tenant=book.space).count() == 1
    with pytest.raises(DomainError, match="起始日"):
        plan(
            book,
            automation={"enabled": True, "holding_account_id": str(book.holding.pk)},
        )
    value = plan(
        book,
        automation={
            "enabled": True,
            "start_date": "2026-09-24",
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "zero",
        },
    )
    assert run(book, value)["processed"] == 0
    assert balance(book.space, book.source, "cash") == 100


def test_two_stages_rounding_and_provenance_are_idempotent(book):
    value = plan(book)
    first = run(book, value)
    assert first["items"][0]["status"] == "waiting_nav"
    assert balance(book.space, book.source, "cash") == 90
    assert balance(book.space, book.source, "fund_transit") == 10
    quote(book)
    final = run(book, value)
    assert final["items"][0]["status"] == "recorded_estimate"
    assert position(book.space, book.holding, book.instrument) == (D("5.56"), D(10))
    assert balance(book.space, book.source, "fund_transit") == 0
    before = Event.objects.filter(tenant=book.space).count()
    run(book, value)
    assert Event.objects.filter(tenant=book.space).count() == before
    row = positions(book.space, date(2026, 9, 24))[0]
    assert (
        row["contains_automatic_estimates"] and row["entry_basis_label"] == "含自动推算"
    )
    registry = Resource.objects.get(tenant=book.space, kind="dca_import_periods")
    assert (
        registry.data["debit_entry_basis"]
        == registry.data["confirmation_entry_basis"]
        == "preview_confirmed"
    )


def test_fee_unknown_and_future_publication_wait_and_confirmation_date_respected(
    book, monkeypatch
):
    value = plan(
        book,
        automation={
            "enabled": True,
            "start_date": "2026-09-23",
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "unknown",
        },
    )
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 9, 23))
    assert run(book, value)["items"][0]["status"] == "waiting_confirmation"
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 9, 24))
    assert run(book, value)["items"][0]["status"] == "waiting_fee"
    value = save_resource(
        book.space,
        book.user,
        "plans",
        {"automation": {**value.data["automation"], "fee_mode": "zero"}},
        value,
    )
    price = quote(book, published_at=timezone.now() + timedelta(days=1))
    assert run(book, value)["items"][0]["status"] == "waiting_nav"
    price.published_at = timezone.now()
    price.save()
    assert run(book, value)["items"][0]["status"] == "recorded_estimate"


def test_insufficient_cash_and_excluded_days_never_overdraw_or_create_shares(book):
    book.source.frozen = D(95)
    book.source.save()
    value = plan(book)
    quote(book)
    assert run(book, value)["items"][0]["status"] == "waiting_cash"
    assert Event.objects.filter(tenant=book.space).count() == 1
    value = save_resource(
        book.space,
        book.user,
        "plans",
        {"automation": {**value.data["automation"], "excluded_dates": ["2026-09-23"]}},
        value,
    )
    assert run(book, value)["items"][0]["status"] == "excluded"
    assert balance(book.space, book.source, "cash") == 100


def test_manual_unlinked_debit_blocks_duplicates_and_partial_confirmation_is_not_done(
    book,
):
    value = plan(book)
    debit = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.source.pk),
            "instrument_id": str(book.instrument.pk),
            "amount": "10",
            "economic_date": "2026-09-23",
        },
    )
    assert run(book, value)["items"][0]["status"] == "needs_review"
    occurrence = Occurrence.objects.get(tenant=book.space, plan=value)
    confirm_occurrence(book.space, book.user, occurrence, debit.pk)
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_confirm",
            "account_id": str(book.holding.pk),
            "instrument_id": str(book.instrument.pk),
            "related_event_id": str(debit.pk),
            "quantity": "4",
            "price": "1",
            "economic_date": "2026-09-24",
        },
    )
    quote(book)
    assert run(book, value)["items"][0]["status"] == "needs_review"
    assert balance(book.space, book.source, "fund_transit") == 6


def test_linked_actual_debit_keeps_actual_source_when_units_automatically_estimated(
    book,
):
    value = plan(book)
    debit = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.source.pk),
            "instrument_id": str(book.instrument.pk),
            "amount": "10",
            "economic_date": "2026-09-23",
        },
    )
    occurrence = Occurrence.objects.get(tenant=book.space, plan=value)
    confirm_occurrence(book.space, book.user, occurrence, debit.pk)
    quote(book)
    assert run(book, value)["items"][0]["status"] == "recorded_estimate"
    registry = Resource.objects.get(tenant=book.space, kind="dca_import_periods")
    assert registry.data["debit_entry_basis"] == "institution"
    assert registry.data["confirmation_entry_basis"] == "preview_confirmed"
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 1


def test_reversed_or_later_excluded_payment_is_not_recreated(book):
    value = plan(book)
    run(book, value)
    debit = Event.objects.get(tenant=book.space, kind="fund_debit")
    reverse_event(book.space, book.user, debit, "实际未扣款")
    quote(book)
    assert run(book, value)["items"][0]["status"] == "needs_review"
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 1
    assert position(book.space, book.holding, book.instrument)[0] == 0


def test_paused_plan_stops_new_debits_but_can_finish_existing_pending_units(book):
    value = plan(book)
    run(book, value)
    value = save_resource(book.space, book.user, "plans", {"status": "paused"}, value)
    quote(book)
    assert run(book, value)["items"][0]["status"] == "recorded_estimate"
    other = plan(book, status="paused")
    assert run(book, other)["processed"] == 0


def test_more_than_500_periods_advance_cursor_and_status_reports_truncation(book):
    value = plan(
        book,
        start_date="2025-01-01",
        end_date="2026-09-23",
        status="paused",
        automation={
            "enabled": True,
            "start_date": "2025-01-01",
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "zero",
        },
    )
    rows = [
        Occurrence(
            tenant=book.space,
            plan=value,
            sequence=i + 1,
            due_date=date(2025, 1, 1) + timedelta(days=i),
            amount="10",
            currency="CNY",
            status="cancelled",
        )
        for i in range(501)
    ]
    Occurrence.objects.bulk_create(rows)
    assert run(book, value)["processed"] == 500
    last = Occurrence.objects.get(tenant=book.space, plan=value, sequence=501)
    assert "automation" not in last.details
    run(book, value)
    last.refresh_from_db()
    assert last.details["automation"]["status"] == "excluded"
    status = automation_status(book.space, value.pk)
    assert (
        status["total_count"] == 501
        and status["has_more"]
        and len(status["items"]) == 500
    )


def test_share_precision_policy_and_invalid_products_or_foreign_accounts(book):
    book.instrument.specification["share_precision"] = 3
    book.instrument.save()
    value = plan(book)
    quote(book)
    assert run(book, value)["items"][0]["quantity"] == "5.560"
    book.instrument.kind = "stock"
    book.instrument.save()
    with pytest.raises(DomainError, match="场外基金"):
        plan(book)
    book.instrument.kind = "fund"
    book.instrument.save()
    other = Workspace.objects.create(name="别人的空间")
    with tenant_context(other.pk):
        foreign = Account.objects.create(tenant=other, kind="fund", name="外部基金账户")
    with pytest.raises(DomainError):
        plan(
            book,
            automation={
                "enabled": True,
                "start_date": "2026-09-23",
                "holding_account_id": str(foreign.pk),
                "fee_mode": "zero",
            },
        )


def test_holidays_skip_and_worker_only_processes_opted_in_plan(book):
    from wealth.tasks import scan_all

    value = plan(book)
    untouched = plan(book, automation={"enabled": False})
    quote(book)
    scan_all()
    assert (
        automation_status(book.space, value.pk)["items"][0]["status"]
        == "recorded_estimate"
    )
    assert Occurrence.objects.get(tenant=book.space, plan=untouched).event_id is None
    holiday = plan(
        book,
        start_date="2026-09-19",
        end_date="2026-09-19",
        automation={
            "enabled": True,
            "start_date": "2026-09-19",
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "zero",
        },
    )
    assert run(book, holiday)["items"][0]["status"] == "excluded"


def test_run_api_is_versioned_idempotent_and_viewer_cannot_write(book):
    import json

    from django.test import Client

    value = plan(book)
    quote(book)
    client = Client()
    client.force_login(book.user)
    url = f"/api/v1/spaces/{book.space.pk}/plans/{value.pk}/automation/run"
    for invalid in (None, "", True, 0):
        result = client.post(
            url,
            json.dumps({"expected_plan_version": invalid}),
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"invalid-{invalid}",
        )
        assert result.status_code == 422, result.content
    payload = json.dumps({"expected_plan_version": value.version})
    first = client.post(
        url,
        payload,
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="auto-dca-264",
    )
    assert first.status_code == 200, first.content
    count = Event.objects.filter(tenant=book.space).count()
    second = client.post(
        url,
        payload,
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="auto-dca-264",
    )
    assert (
        second.status_code == 200
        and Event.objects.filter(tenant=book.space).count() == count
    )
    viewer = get_user_model().objects.create_user("auto-dca-viewer")
    Membership.objects.create(workspace=book.space, user=viewer, role="viewer")
    client.force_login(viewer)
    denied = client.post(
        url,
        payload,
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="auto-dca-viewer-264",
    )
    assert denied.status_code == 403


def test_formal_nav_does_not_upgrade_automatically_estimated_units_to_verified_profit(
    book,
):
    from wealth.daily_returns import daily_return_overview

    value = plan(book)
    quote(book)
    run(book, value)
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date=date(2026, 9, 24),
        kind="official_nav",
        value="1.8",
    )
    summary, _ = daily_return_overview(book.space, date(2026, 9, 24))
    assert summary["status"] == "estimated"
    assert summary["items"][0]["contains_automatic_estimates"] is True


def test_runtime_cursor_does_not_block_admin_plan_deletion_and_is_in_purge_scope(book):
    import json
    import uuid

    from django.test import Client
    from wealth.administration_purge import plan as purge_plan

    value = plan(
        book,
        start_date="2026-09-19",
        end_date="2026-09-19",
        automation={
            "enabled": True,
            "start_date": "2026-09-19",
            "holding_account_id": str(book.holding.pk),
            "fee_mode": "zero",
        },
    )
    assert run(book, value)["items"][0]["status"] == "excluded"
    runtime = Resource.objects.get(tenant=book.space, kind="dca_automation_runtime")
    assert Event.objects.filter(tenant=book.space).count() == 1
    administrator = get_user_model().objects.create_superuser("auto-dca-delete-admin")
    client = Client()
    client.force_login(administrator)
    book.space.refresh_from_db()
    response = client.delete(
        f"/api/v1/spaces/{book.space.pk}/administration/plans/{value.pk}",
        data=json.dumps(
            {
                "version": value.version,
                "expected_revision": book.space.revision,
                "confirm": True,
                "reason": "删除未产生账务的休市计划",
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 200, response.content
    assert not Resource.objects.filter(tenant=book.space, pk=value.pk).exists()
    deleted_plan = Resource.all_objects.get(tenant=book.space, pk=value.pk)
    book.space.refresh_from_db()
    preview, tables, _, _ = purge_plan(book.space, "plans", deleted_plan)
    assert str(runtime.pk) in tables["wealth_resource"]
    assert preview["record_count"] > 1
    assert (
        client.get(
            f"/api/v1/spaces/{book.space.pk}/administration/dca_automation_runtime"
        ).status_code
        == 404
    )
