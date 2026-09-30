"""Database guards executed with the non-owner, non-bypass runtime role."""

import uuid
import pytest
from django.contrib.auth import get_user_model
from django.db import connection, transaction, IntegrityError, ProgrammingError
from wealth import models as m
from wealth.common import tenant_context
from wealth.ledger import post_event

pytestmark = pytest.mark.django_db


def test_runtime_role_and_default_deny_rls():
    with connection.cursor() as c:
        c.execute(
            "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"
        )
        assert c.fetchone() == (False, False)
        c.execute(
            "SELECT current_user=tableowner FROM pg_tables WHERE tablename='wealth_event'"
        )
        assert c.fetchone() == (False,)
    a = m.Workspace.objects.create(name="租户甲")
    b = m.Workspace.objects.create(name="租户乙")
    with tenant_context(a.pk):
        first = m.Account.objects.create(tenant=a, name="甲的私密账户")
        with tenant_context(b.pk):
            m.Account.objects.create(tenant=b, name="乙的私密账户")
            assert not m.Account.objects.filter(pk=first.pk).exists()
        assert list(m.Account.objects.values_list("pk", flat=True)) == [first.pk]
    assert not m.Account.objects.exists()
    with pytest.raises(ProgrammingError), transaction.atomic():
        m.Account.objects.create(tenant=a, name="无上下文写入")


def test_balanced_ledger_is_deferred_until_transaction_commit():
    space = m.Workspace.objects.create(name="数据库复式校验")
    with tenant_context(space.pk):
        with pytest.raises(IntegrityError), transaction.atomic():
            event = m.Event.objects.create(
                tenant=space,
                kind="expense",
                economic_date="2026-01-01",
                stage_key=str(uuid.uuid4()),
                revision=1,
            )
            m.JournalLine.objects.create(
                tenant=space, event=event, code="expense", currency="CNY", amount="12"
            )
            with connection.cursor() as c:
                c.execute("SET CONSTRAINTS ALL IMMEDIATE")
        assert not m.Event.objects.filter(tenant=space).exists()
        with pytest.raises(IntegrityError), transaction.atomic():
            m.Event.objects.create(
                tenant=space,
                kind="expense",
                economic_date="2026-01-01",
                stage_key=str(uuid.uuid4()),
                revision=1,
            )
            with connection.cursor() as c:
                c.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_balanced_currencies_cannot_cancel_each_other():
    space = m.Workspace.objects.create(name="币种不混加")
    with tenant_context(space.pk):
        with pytest.raises(IntegrityError), transaction.atomic():
            event = m.Event.objects.create(
                tenant=space,
                kind="expense",
                economic_date="2026-01-01",
                stage_key=str(uuid.uuid4()),
                revision=1,
            )
            m.JournalLine.objects.create(
                tenant=space, event=event, code="cash", currency="CNY", amount="12"
            )
            m.JournalLine.objects.create(
                tenant=space, event=event, code="expense", currency="USD", amount="-12"
            )
            with connection.cursor() as c:
                c.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_fact_updates_and_cross_tenant_foreign_keys_rejected():
    user = get_user_model().objects.create_user("security-owner")
    space = m.Workspace.objects.create(name="审计隔离")
    other = m.Workspace.objects.create(name="另一空间")
    with tenant_context(other.pk):
        foreign = m.Account.objects.create(tenant=other, name="不可引用账户")
    with tenant_context(space.pk):
        account = m.Account.objects.create(tenant=space, name="本空间账户")
        event = post_event(
            space,
            user,
            {"kind": "income", "amount": "100", "account_id": str(account.pk)},
        )
        for model, where, changes in [
            (m.Event, {"pk": event.pk}, {"description": "篡改"}),
            (m.JournalLine, {"event": event}, {"amount": "0"}),
        ]:
            with pytest.raises(IntegrityError), transaction.atomic():
                model.objects.filter(**where).update(**changes)
        with pytest.raises(IntegrityError), transaction.atomic():
            m.JournalLine.objects.create(
                tenant=space,
                event=event,
                account=foreign,
                code="cash",
                currency="CNY",
                amount="0",
            )
            with connection.cursor() as c:
                c.execute("SET CONSTRAINTS ALL IMMEDIATE")
        with connection.cursor() as c:
            c.execute("SET CONSTRAINTS ALL IMMEDIATE")
