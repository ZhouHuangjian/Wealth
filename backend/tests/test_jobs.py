"""Durable outbox, delivery leases, revision ordering and intention-only scans."""

from datetime import date, datetime, timedelta, timezone as datetime_timezone
from decimal import Decimal
from types import SimpleNamespace
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.db import connection, transaction

from wealth import tasks
from wealth.common import tenant_context
from wealth.ledger import balance, post_event
from wealth.models import (
    Account,
    Event,
    JournalLine,
    Membership,
    Occurrence,
    Outbox,
    Projection,
    Resource,
    Workspace,
)


pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def book():
    user = get_user_model().objects.create_user(
        username="jobs-owner", password="test-password-jobs"
    )
    space = Workspace.objects.create(name="后台任务空间")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        account = Account.objects.create(
            tenant=space, created_by=user, name="银行", currency="CNY"
        )
    return SimpleNamespace(user=user, space=space, account=account)


def post(book, amount="1000", kind="opening"):
    return post_event(
        book.space,
        book.user,
        {
            "kind": kind,
            "account_id": str(book.account.pk),
            "amount": amount,
            "economic_date": "2026-01-01",
            "currency": "CNY",
        },
    )


def current_scope():
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_setting('app.tenant_id', true)")
        return cursor.fetchone()[0] or ""


def test_outbox_and_financial_fact_share_the_same_rollback_boundary(book):
    with tenant_context(book.space.pk):
        with pytest.raises(RuntimeError, match="force rollback"):
            with transaction.atomic():
                event = post(book)
                assert (
                    Outbox.objects.filter(
                        tenant=book.space, revision=event.revision
                    ).count()
                    == 1
                )
                assert JournalLine.objects.filter(tenant=book.space).exists()
                raise RuntimeError("force rollback")
        assert not Outbox.objects.filter(tenant=book.space).exists()
        assert not Event.objects.filter(tenant=book.space).exists()
        assert not JournalLine.objects.filter(tenant=book.space).exists()
        book.space.refresh_from_db()
        assert book.space.revision == 0
        committed = post(book)
        assert (
            Outbox.objects.get(tenant=book.space, revision=committed.revision).status
            == "pending"
        )


def test_broker_failure_remains_durable_then_retries_without_reposting_money(
    book, monkeypatch
):
    with tenant_context(book.space.pk):
        post(book)
        job = Outbox.objects.get(tenant=book.space)

    def unavailable(*args, **kwargs):
        raise ConnectionError("simulated unavailable broker")

    monkeypatch.setattr(tasks.recompute, "delay", unavailable)
    result = tasks.dispatch_all()
    assert result == {"dispatched": 0, "failed": 1}
    with tenant_context(book.space.pk):
        job.refresh_from_db()
        assert (job.status, job.error, job.attempts) == (
            "failed",
            "broker_unavailable",
            1,
        )
        assert Event.objects.filter(tenant=book.space).count() == 1
    published = []
    monkeypatch.setattr(tasks.recompute, "delay", lambda *args: published.append(args))
    assert tasks.dispatch_all()["dispatched"] == 1
    assert published == [(str(book.space.pk), str(job.pk))]
    with tenant_context(book.space.pk):
        job.refresh_from_db()
        assert job.status == "queued"
        assert job.attempts == 2
        assert job.dispatched_at is not None
        assert job.error == ""
    assert tasks.recompute(str(book.space.pk), str(job.pk))["status"] == "done"
    with tenant_context(book.space.pk):
        assert Event.objects.filter(tenant=book.space).count() == 1
        assert balance(book.space, book.account, "cash") == D("1000")
        assert Projection.objects.filter(tenant=book.space).count() == 1


def test_delivery_lease_is_based_on_last_publish_not_creation_time(book, monkeypatch):
    now = datetime(2026, 9, 25, 10, 0, tzinfo=datetime_timezone.utc)
    with tenant_context(book.space.pk):
        post(book)
        job = Outbox.objects.get(tenant=book.space)
        Outbox.objects.filter(pk=job.pk).update(
            status="queued",
            attempts=1,
            dispatched_at=now,
            created_at=now - timedelta(days=10),
        )
    published = []
    monkeypatch.setattr(tasks.recompute, "delay", lambda *args: published.append(args))
    monkeypatch.setattr(tasks.timezone, "now", lambda: now)
    assert tasks.dispatch_all()["dispatched"] == 0
    assert published == []
    later = now + timedelta(minutes=6)
    monkeypatch.setattr(tasks.timezone, "now", lambda: later)
    assert tasks.dispatch_all()["dispatched"] == 1
    assert len(published) == 1
    with tenant_context(book.space.pk):
        job.refresh_from_db()
        assert job.dispatched_at == later
        assert job.attempts == 2
    assert tasks.dispatch_all()["dispatched"] == 0
    assert len(published) == 1


def test_legacy_queued_job_without_a_lease_is_redeliverable(book, monkeypatch):
    with tenant_context(book.space.pk):
        post(book)
        Outbox.objects.filter(tenant=book.space).update(
            status="queued", dispatched_at=None
        )
    calls = []
    monkeypatch.setattr(tasks.recompute, "delay", lambda *args: calls.append(args))
    assert tasks.dispatch_all()["dispatched"] == 1
    assert len(calls) == 1


def test_duplicate_worker_delivery_has_one_projection_and_no_new_facts(book):
    with tenant_context(book.space.pk):
        post(book)
        job = Outbox.objects.get(tenant=book.space)
        before_lines = JournalLine.objects.filter(tenant=book.space).count()
    first = tasks.recompute(str(book.space.pk), str(job.pk))
    second = tasks.recompute(str(book.space.pk), str(job.pk))
    assert first["status"] == second["status"] == "done"
    with tenant_context(book.space.pk):
        assert (
            Projection.objects.filter(tenant=book.space, revision=job.revision).count()
            == 1
        )
        assert JournalLine.objects.filter(tenant=book.space).count() == before_lines
        job.refresh_from_db()
        assert job.status == "done"


def test_old_revision_cannot_replace_a_newer_projection(book):
    with tenant_context(book.space.pk):
        first = post(book)
        old_job = Outbox.objects.get(tenant=book.space, revision=first.revision)
        second = post(book, "10", "expense")
        new_job = Outbox.objects.get(tenant=book.space, revision=second.revision)
    assert tasks.recompute(str(book.space.pk), str(new_job.pk))["status"] == "done"
    assert (
        tasks.recompute(str(book.space.pk), str(old_job.pk))["status"] == "superseded"
    )
    with tenant_context(book.space.pk):
        projection = Projection.objects.get(tenant=book.space)
        assert projection.revision == second.revision
        assert D(projection.payload["net_assets"]) == D("990")
        old_job.refresh_from_db()
        assert old_job.status == "superseded"


def test_existing_higher_projection_revision_is_never_overwritten(book, monkeypatch):
    with tenant_context(book.space.pk):
        post(book)
        job = Outbox.objects.get(tenant=book.space)
        future = Projection.objects.create(
            tenant=book.space,
            revision=100,
            as_of=date(2026, 9, 25),
            payload={"net_assets": "1234"},
        )

    def should_not_calculate(*args, **kwargs):
        raise AssertionError("old revision must not compute")

    monkeypatch.setattr(tasks, "overview", should_not_calculate)
    assert tasks.recompute(str(book.space.pk), str(job.pk))["status"] == "superseded"
    with tenant_context(book.space.pk):
        future.refresh_from_db()
        assert future.payload == {"net_assets": "1234"}
        assert Projection.objects.filter(tenant=book.space).count() == 1


def test_projection_failure_is_durable_and_inline_retry_recovers(book, monkeypatch):
    with tenant_context(book.space.pk):
        post(book)
        job = Outbox.objects.get(tenant=book.space)
    original = tasks.overview

    def fail(*args, **kwargs):
        raise RuntimeError("synthetic calculation failure")

    monkeypatch.setattr(tasks, "overview", fail)
    assert tasks.dispatch_all(inline=True) == {"dispatched": 0, "failed": 1}
    with tenant_context(book.space.pk):
        job.refresh_from_db()
        assert (job.status, job.error) == ("failed", "projection_failed")
        assert Projection.objects.filter(tenant=book.space).count() == 0
    monkeypatch.setattr(tasks, "overview", original)
    assert tasks.dispatch_all(inline=True) == {"dispatched": 1, "failed": 0}
    with tenant_context(book.space.pk):
        job.refresh_from_db()
        assert job.status == "done"
        assert job.error == ""
        assert job.attempts == 2
        assert Projection.objects.filter(tenant=book.space).count() == 1


def test_cross_space_job_id_is_rejected_and_nested_scope_is_restored(book):
    other = Workspace.objects.create(name="独立空间 B")
    Membership.objects.create(workspace=other, user=book.user, role="owner")
    with tenant_context(other.pk):
        other_account = Account.objects.create(
            tenant=other, created_by=book.user, name="B银行", currency="CNY"
        )
        post_event(
            other,
            book.user,
            {"kind": "opening", "account_id": str(other_account.pk), "amount": "2000"},
        )
        other_job = Outbox.objects.get(tenant=other)
    with tenant_context(book.space.pk):
        post(book, "1000")
        our_job = Outbox.objects.get(tenant=book.space)
        assert (
            tasks.recompute(str(book.space.pk), str(other_job.pk))["status"]
            == "not_found"
        )
        assert current_scope() == str(book.space.pk)
        assert tasks.recompute(str(other.pk), str(other_job.pk))["status"] == "done"
        assert current_scope() == str(book.space.pk)
        assert not Projection.objects.all().exists()  # RLS hides B's projection.
        tasks.recompute(str(book.space.pk), str(our_job.pk))
        assert D(Projection.objects.get().payload["net_assets"]) == D("1000")
    with tenant_context(other.pk):
        assert D(Projection.objects.get().payload["net_assets"]) == D("2000")


def test_unknown_job_is_harmless_and_does_not_leave_a_tenant_context(book):
    previous = current_scope()
    assert tasks.recompute(str(book.space.pk), str(uuid.uuid4())) == {
        "status": "not_found"
    }
    assert current_scope() == previous


def test_periodic_scan_catches_up_plans_and_loans_without_posting_cash(
    book, monkeypatch
):
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 9, 25))
    with tenant_context(book.space.pk):
        post(book, "10000")
        loan_account = Account.objects.create(
            tenant=book.space,
            created_by=book.user,
            name="贷款",
            kind="loan",
            currency="CNY",
        )
        plan = Resource.objects.create(
            tenant=book.space,
            created_by=book.user,
            kind="plans",
            data={
                "name": "定期生活费",
                "kind": "expense",
                "amount": "100",
                "currency": "CNY",
                "account_id": str(book.account.pk),
                "start_date": "2026-07-01",
                "frequency": "monthly",
                "count": 4,
                "status": "active",
            },
        )
        loan = Resource.objects.create(
            tenant=book.space,
            created_by=book.user,
            kind="loans",
            data={
                "name": "零息贷款",
                "account_id": str(book.account.pk),
                "liability_account_id": str(loan_account.pk),
                "principal": "1200",
                "annual_rate": "0",
                "currency": "CNY",
                "term_months": 12,
                "first_due_date": "2026-09-25",
                "method": "annuity",
                "status": "active",
            },
        )
        before_events = Event.objects.filter(tenant=book.space).count()
        before_lines = JournalLine.objects.filter(tenant=book.space).count()
    assert tasks.scan_all()["pending"] == 4
    with tenant_context(book.space.pk):
        assert Occurrence.objects.filter(plan=plan).count() == 4
        assert Occurrence.objects.filter(plan=loan).count() == 12
        ids = set(
            Occurrence.objects.filter(tenant=book.space).values_list("pk", flat=True)
        )
        assert not Occurrence.objects.filter(
            tenant=book.space, event__isnull=False
        ).exists()
        assert balance(book.space, book.account, "cash") == D("10000")
        assert Event.objects.filter(tenant=book.space).count() == before_events
        assert JournalLine.objects.filter(tenant=book.space).count() == before_lines
    assert tasks.scan_all()["pending"] == 4
    with tenant_context(book.space.pk):
        assert (
            set(
                Occurrence.objects.filter(tenant=book.space).values_list(
                    "pk", flat=True
                )
            )
            == ids
        )
        assert Event.objects.filter(tenant=book.space).count() == before_events


def test_paused_plan_is_not_automatically_advanced_by_periodic_scan(book, monkeypatch):
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 9, 25))
    with tenant_context(book.space.pk):
        plan = Resource.objects.create(
            tenant=book.space,
            created_by=book.user,
            kind="plans",
            data={
                "name": "已暂停",
                "amount": "100",
                "currency": "CNY",
                "account_id": str(book.account.pk),
                "start_date": "2026-09-01",
                "frequency": "monthly",
                "status": "paused",
            },
        )
        occurrence = Occurrence.objects.create(
            tenant=book.space,
            plan=plan,
            sequence=1,
            due_date=date(2026, 9, 1),
            amount=D("100"),
            currency="CNY",
            status="scheduled",
        )
    assert tasks.scan_all()["pending"] == 0
    with tenant_context(book.space.pk):
        occurrence.refresh_from_db()
        assert occurrence.status == "scheduled"
        assert not Event.objects.filter(tenant=book.space).exists()


def test_overdue_status_advance_bumps_projection_revision_without_financial_facts(
    book, monkeypatch
):
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 9, 25))
    with tenant_context(book.space.pk):
        plan = Resource.objects.create(
            tenant=book.space,
            created_by=book.user,
            kind="plans",
            data={
                "name": "离线前生成的到期计划",
                "amount": "100",
                "currency": "CNY",
                "account_id": str(book.account.pk),
                "start_date": "2026-09-01",
                "frequency": "monthly",
                "count": 1,
                "status": "active",
            },
        )
        occurrence = Occurrence.objects.create(
            tenant=book.space,
            plan=plan,
            sequence=1,
            due_date=date(2026, 9, 1),
            amount=D("100"),
            currency="CNY",
            status="scheduled",
        )
    assert tasks.scan_all()["pending"] == 1
    with tenant_context(book.space.pk):
        occurrence.refresh_from_db()
        book.space.refresh_from_db()
        assert occurrence.status == "pending"
        assert occurrence.version == 2
        assert book.space.revision == 1
        assert Outbox.objects.filter(tenant=book.space, revision=1).exists()
        assert not Event.objects.filter(tenant=book.space).exists()
