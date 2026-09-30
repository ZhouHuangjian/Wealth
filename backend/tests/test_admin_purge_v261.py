"""Irreversible business cleanup is explicit, scoped and dependency complete."""

from datetime import date
from decimal import Decimal as D
import json
from types import SimpleNamespace
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.db import connection, DatabaseError, transaction
from django.db.models import Sum
from django.test import Client

from wealth import models as m
from wealth.common import tenant_context
from wealth.ledger import balance, post_event
from wealth.planning import confirm_occurrence, generate_schedule, save_resource
from wealth.reporting import formal_price

pytestmark = pytest.mark.django_db


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    monkeypatch.setattr("wealth.planning.today", lambda _: date(2026, 9, 28))
    admin = get_user_model().objects.create_superuser("purge-v261-operator")
    owner = get_user_model().objects.create_user("purge-v261-owner")
    space = m.Workspace.objects.create(name="彻底删除合成账簿")
    m.Membership.objects.create(workspace=space, user=owner, role="owner")
    clients = {}
    for name, user in (("admin", admin), ("owner", owner)):
        clients[name] = Client()
        clients[name].force_login(user)
    with tenant_context(space.pk):
        account = m.Account.objects.create(
            tenant=space, name="待整理基金账户", kind="fund"
        )
        instrument = m.Instrument.objects.create(
            tenant=space, name="待整理合成基金", code="PURGE-A", kind="fund"
        )
        post_event(
            space,
            owner,
            dict(
                kind="opening",
                account_id=str(account.pk),
                amount="1000",
                economic_date="2026-08-01",
            ),
        )
        yield SimpleNamespace(
            space=space,
            admin=admin,
            owner=owner,
            clients=clients,
            account=account,
            instrument=instrument,
        )


def read(book, route, client="admin"):
    return book.clients[client].get(
        f"/api/v1/spaces/{book.space.pk}/administration/{route}"
    )


def write(book, route, values=None, method="post", client="admin", **extra):
    book.space.refresh_from_db()
    body = {
        "expected_revision": book.space.revision,
        "reason": "合成验收彻底删除",
        **extra,
    }
    if values is not None:
        body["values"] = values
    return getattr(book.clients[client], method)(
        f"/api/v1/spaces/{book.space.pk}/administration/{route}",
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )


def good(response):
    assert response.status_code == 200, response.content.decode()
    return response.json()


def remove(book, category, obj, **extra):
    current = good(read(book, f"{category}/{obj.pk}"))["item"]
    return good(
        write(
            book,
            f"{category}/{obj.pk}",
            method="delete",
            version=current["version"],
            confirm=True,
            **extra,
        )
    )["item"]


def preview(book, category, obj):
    return good(read(book, f"{category}/{obj.pk}/purge-preview"))


def purge(book, category, obj, checked=None, **extra):
    checked = checked or preview(book, category, obj)
    return write(
        book,
        f"{category}/{obj.pk}/purge",
        **{
            "version": checked["item"]["version"],
            "expected_revision": checked["data_revision"],
            "preview_token": checked["preview_token"],
            "confirm_name": checked["item"]["name"],
            "confirm": True,
            **extra,
        },
    )


def buy(book, instrument=None, account=None, quantity="100", when="2026-08-02"):
    event = post_event(
        book.space,
        book.owner,
        dict(
            kind="buy",
            account_id=str((account or book.account).pk),
            instrument_id=str((instrument or book.instrument).pk),
            quantity=quantity,
            price="1",
            economic_date=when,
        ),
    )
    # A buy first creates the payable; only an actual settlement debits cash.
    post_event(
        book.space,
        book.owner,
        dict(
            kind="settlement",
            account_id=str((account or book.account).pk),
            related_event_id=str(event.pk),
            economic_date=when,
        ),
    )
    return event


def assert_remaining_events_balanced(book):
    assert all(
        row["total"] == 0
        for row in m.JournalLine.objects.filter(tenant=book.space)
        .values("event_id", "currency")
        .annotate(total=Sum("amount"))
    )
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        cursor.execute("SET CONSTRAINTS ALL DEFERRED")


def test_purge_requires_admin_and_soft_deleted_root(book):
    route = f"instruments/{book.instrument.pk}"
    assert read(book, f"{route}/purge-preview").status_code == 409
    assert write(book, f"{route}/purge", version=1, confirm=True).status_code == 409
    remove(book, "instruments", book.instrument)
    assert read(book, f"{route}/purge-preview", client="owner").status_code == 403
    checked = preview(book, "instruments", book.instrument)
    assert (
        purge(book, "instruments", book.instrument, checked, client="owner").status_code
        == 403
    )
    assert m.Instrument.objects.filter(pk=book.instrument.pk).exists()


def test_purge_cannot_target_another_workspace(book):
    other = m.Workspace.objects.create(name="不可跨入的账簿")
    with tenant_context(other.pk):
        note = m.Resource.objects.create(
            tenant=other,
            kind="notes",
            data={"title": "其他空间私密笔记", "_administration_deleted": True},
        )
    assert read(book, f"notes/{note.pk}/purge-preview").status_code == 404
    assert (
        write(book, f"notes/{note.pk}/purge", version=1, confirm=True).status_code
        == 404
    )
    with tenant_context(other.pk):
        assert m.Resource.all_objects.filter(pk=note.pk).exists()


@pytest.mark.parametrize(
    "change",
    [
        {"confirm_name": "错误名称"},
        {"confirm_name": " 待整理合成基金"},
        {"confirm": False},
    ],
)
def test_exact_name_and_explicit_confirmation_are_required(book, change):
    remove(book, "instruments", book.instrument)
    checked = preview(book, "instruments", book.instrument)
    response = purge(book, "instruments", book.instrument, checked, **change)
    assert response.status_code == 422
    assert m.Instrument.objects.filter(pk=book.instrument.pk).exists()


def test_stale_revision_and_stale_preview_token_cannot_purge(book):
    remove(book, "instruments", book.instrument)
    checked = preview(book, "instruments", book.instrument)
    good(write(book, "notes", {"title": "预览后新增", "body": "使账簿版本变化"}))
    assert purge(book, "instruments", book.instrument, checked).status_code == 412
    book.space.refresh_from_db()
    assert (
        purge(
            book,
            "instruments",
            book.instrument,
            checked,
            expected_revision=book.space.revision,
        ).status_code
        == 409
    )
    current = preview(book, "instruments", book.instrument)
    assert (
        purge(
            book, "instruments", book.instrument, current, preview_token="0" * 64
        ).status_code
        == 409
    )
    assert m.Instrument.objects.filter(pk=book.instrument.pk).exists()


def test_empty_product_is_physically_removed_but_audits_and_other_facts_survive(book):
    remove(book, "instruments", book.instrument)
    checked = preview(book, "instruments", book.instrument)
    assert checked["counts"] and "affected_items" in checked
    prior_audits = set(m.Audit.objects.values_list("pk", flat=True))
    result = good(purge(book, "instruments", book.instrument, checked))
    assert result["purged"] is True
    assert not m.Instrument.objects.filter(pk=book.instrument.pk).exists()
    assert m.Account.objects.filter(pk=book.account.pk).exists()
    assert balance(book.space, book.account) == D("1000")
    assert prior_audits <= set(m.Audit.objects.values_list("pk", flat=True))
    assert m.Audit.objects.filter(
        action="administration.record.purged", created_by=book.admin
    ).exists()
    assert read(book, f"instruments/{book.instrument.pk}").status_code == 404
    assert (
        write(
            book,
            f"instruments/{book.instrument.pk}/restore",
            version=checked["item"]["version"],
        ).status_code
        == 404
    )
    assert_remaining_events_balanced(book)


def test_direct_sql_function_rejects_ordinary_actor(book):
    removed = remove(book, "instruments", book.instrument)
    book.space.refresh_from_db()
    with pytest.raises(DatabaseError), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.wealth_purge_business_record(%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                [
                    book.owner.pk,
                    str(book.space.pk),
                    "wealth_instrument",
                    str(book.instrument.pk),
                    book.space.revision,
                    removed["version"],
                    book.instrument.name,
                    json.dumps({"wealth_instrument": [str(book.instrument.pk)]}),
                ],
            )
    assert m.Instrument.objects.filter(pk=book.instrument.pk).exists()


@pytest.mark.parametrize("model", [m.JournalLine, m.PositionMovement, m.SourceFact])
def test_direct_sql_cannot_erase_one_financial_fact_of_a_retained_event(book, model):
    event = buy(book)
    m.SourceFact.objects.create(
        tenant=book.space,
        identity=str(uuid.uuid4()),
        event=event,
        fingerprint="c" * 64,
    )
    target = model.objects.filter(tenant=book.space, event=event).first()
    assert target is not None
    created = good(
        write(
            book, "notes", {"title": "可删除根记录", "body": "不能借此删除其他金融事实"}
        )
    )["item"]
    root = m.Resource.objects.get(pk=created["id"])
    removed = remove(book, "notes", root)
    book.space.refresh_from_db()
    before = balance(book.space, book.account, "cash")
    with (
        pytest.raises(
            DatabaseError, match="Financial fact deletion requires its whole event"
        ),
        transaction.atomic(),
    ):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.wealth_purge_business_record(%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                [
                    book.admin.pk,
                    str(book.space.pk),
                    "wealth_resource",
                    str(root.pk),
                    book.space.revision,
                    removed["version"],
                    removed["name"],
                    json.dumps(
                        {
                            "wealth_resource": [str(root.pk)],
                            model._meta.db_table: [str(target.pk)],
                        }
                    ),
                ],
            )
    assert m.Resource.all_objects.filter(pk=root.pk).exists()
    assert model.objects.filter(pk=target.pk).exists()
    assert m.Event.objects.filter(pk=event.pk).exists()
    assert balance(book.space, book.account, "cash") == before
    assert_remaining_events_balanced(book)


def test_direct_sql_event_deletion_cannot_leave_one_of_its_journal_legs(book):
    event = m.Event.objects.get(tenant=book.space, kind="opening")
    lines = list(event.lines.order_by("pk"))
    assert len(lines) == 2
    created = good(
        write(book, "notes", {"title": "不能掩盖部分删除", "body": "合成根记录"})
    )["item"]
    root = m.Resource.objects.get(pk=created["id"])
    removed = remove(book, "notes", root)
    book.space.refresh_from_db()
    with pytest.raises(DatabaseError), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.wealth_purge_business_record(%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                [
                    book.admin.pk,
                    str(book.space.pk),
                    "wealth_resource",
                    str(root.pk),
                    book.space.revision,
                    removed["version"],
                    removed["name"],
                    json.dumps(
                        {
                            "wealth_resource": [str(root.pk)],
                            "wealth_event": [str(event.pk)],
                            "wealth_journalline": [str(lines[0].pk)],
                        }
                    ),
                ],
            )
    assert m.Resource.all_objects.filter(pk=root.pk).exists()
    assert m.Event.objects.filter(pk=event.pk).exists()
    assert event.lines.count() == 2
    assert balance(book.space, book.account, "cash") == D("1000")
    assert_remaining_events_balanced(book)


def test_product_purge_removes_whole_trade_effect_and_keeps_other_product(book):
    target_buy = buy(book)
    other = m.Instrument.objects.create(
        tenant=book.space, name="保留基金", code="PURGE-B", kind="fund"
    )
    retained_buy = buy(book, other, quantity="50", when="2026-08-03")
    m.Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        value="1.1",
        economic_date="2026-09-01",
    )
    assert balance(book.space, book.account, "cash") == D("850")
    remove(book, "instruments", book.instrument)
    checked = preview(book, "instruments", book.instrument)
    effect = next(
        row
        for row in checked["cash_effects"]
        if row["account_id"] == str(book.account.pk)
    )
    assert D(effect["change"]) == D("100")
    good(purge(book, "instruments", book.instrument, checked))
    assert not m.Event.objects.filter(pk=target_buy.pk).exists()
    assert not m.PositionMovement.objects.filter(
        instrument_id=book.instrument.pk
    ).exists()
    assert not m.Price.all_objects.filter(instrument_id=book.instrument.pk).exists()
    assert m.Instrument.objects.filter(pk=other.pk).exists()
    assert m.Event.objects.filter(pk=retained_buy.pk).exists()
    assert balance(book.space, book.account, "cash") == D("950")
    assert_remaining_events_balanced(book)


def test_account_purge_previews_other_account_change_and_keeps_it_balanced(book):
    other = m.Account.objects.create(
        tenant=book.space, name="保留银行账户", kind="bank"
    )
    retained = post_event(
        book.space,
        book.owner,
        dict(
            kind="opening",
            account_id=str(other.pk),
            amount="500",
            economic_date="2026-08-01",
        ),
    )
    transfer = post_event(
        book.space,
        book.owner,
        dict(
            kind="transfer",
            account_id=str(book.account.pk),
            target_account_id=str(other.pk),
            amount="200",
            economic_date="2026-08-02",
        ),
    )
    assert balance(book.space, other, "cash") == D("700")
    remove(book, "accounts", book.account)
    checked = preview(book, "accounts", book.account)
    effect = next(
        row for row in checked["cash_effects"] if row["account_id"] == str(other.pk)
    )
    assert D(effect["change"]) == D("-200") and not effect["account_removed"]
    good(purge(book, "accounts", book.account, checked))
    assert not m.Account.objects.filter(pk=book.account.pk).exists()
    assert m.Account.objects.filter(pk=other.pk).exists()
    assert m.Instrument.objects.filter(pk=book.instrument.pk).exists()
    assert m.Event.objects.filter(pk=retained.pk).exists()
    assert not m.Event.objects.filter(pk=transfer.pk).exists()
    assert balance(book.space, other, "cash") == D("500")
    assert_remaining_events_balanced(book)


@pytest.mark.parametrize(
    "category,model,values,change",
    [
        (
            "prices",
            m.Price,
            {
                "value": "1",
                "economic_date": "2026-09-01",
                "kind": "official_nav",
                "source": "合成",
            },
            "value",
        ),
        (
            "fx",
            m.FxRate,
            {
                "base": "USD",
                "quote": "CNY",
                "rate": "7",
                "economic_date": "2026-09-01",
                "purpose": "valuation",
                "source": "合成",
            },
            "rate",
        ),
        (
            "snapshots",
            m.Snapshot,
            {
                "equity": "1000",
                "currency": "CNY",
                "economic_date": "2026-09-01",
                "coverage": "客户权益",
                "complete": False,
            },
            "equity",
        ),
    ],
)
def test_purging_latest_correction_never_reactivates_superseded_observations(
    book, category, model, values, change
):
    values = dict(values)
    if category == "prices":
        values["instrument_id"] = str(book.instrument.pk)
    if category == "snapshots":
        values["account_id"] = str(book.account.pk)
    original = good(write(book, category, values))["item"]
    second = good(
        write(
            book,
            f"{category}/{original['id']}",
            {**original["values"], change: "2"},
            method="patch",
            version=original["version"],
        )
    )["item"]
    latest = good(
        write(
            book,
            f"{category}/{second['id']}",
            {**second["values"], change: "3"},
            method="patch",
            version=second["version"],
        )
    )["item"]
    obj = model.all_objects.get(pk=latest["id"])
    remove(book, category, obj)
    good(purge(book, category, obj))
    assert not model.all_objects.filter(pk=latest["id"]).exists()
    assert not model.objects.filter(pk__in=[original["id"], second["id"]]).exists()
    if category == "prices":
        assert formal_price(book.space, book.instrument, "2026-09-02") is None


def test_shared_investment_tag_keeps_other_members_after_product_purge(book):
    other = m.Instrument.objects.create(
        tenant=book.space, name="继续持有产品", code="PURGE-TAG-B", kind="fund"
    )
    tag = good(
        write(
            book,
            "investment-tags",
            {
                "name": "共享长期标签",
                "target_weight": "50",
                "instrument_ids": [str(book.instrument.pk), str(other.pk)],
            },
        )
    )["item"]
    remove(book, "instruments", book.instrument)
    checked = preview(book, "instruments", book.instrument)
    assert "共享长期标签" in json.dumps(checked["affected_items"], ensure_ascii=False)
    good(purge(book, "instruments", book.instrument, checked))
    remaining = m.Resource.objects.get(pk=tag["id"])
    assert remaining.data["instrument_ids"] == [str(other.pk)]
    assert remaining.data["name"] == "共享长期标签"
    assert m.Instrument.objects.filter(pk=other.pk).exists()


def test_purged_occurrence_event_stays_cancelled_when_retained_plan_regenerates(book):
    plan = save_resource(
        book.space,
        book.owner,
        "plans",
        {
            "name": "保留的日常支出计划",
            "kind": "expense",
            "account_id": str(book.account.pk),
            "amount": "10",
            "currency": "CNY",
            "start_date": "2026-09-28",
            "end_date": "2026-09-29",
            "frequency": "daily",
            "status": "active",
        },
    )
    occurrence = m.Occurrence.objects.get(plan=plan, due_date="2026-09-28")
    event = post_event(
        book.space,
        book.owner,
        dict(
            kind="expense",
            account_id=str(book.account.pk),
            amount="10",
            economic_date="2026-09-28",
        ),
    )
    confirm_occurrence(book.space, book.owner, occurrence, event.pk)
    remove(book, "events", event)
    # Soft reversal unlinks this FK; purge must remember the past association.
    occurrence.refresh_from_db()
    assert occurrence.event_id is None
    good(purge(book, "events", event))
    assert m.Resource.objects.filter(pk=plan.pk).exists()
    occurrence.refresh_from_db()
    assert occurrence.status == "cancelled" and occurrence.event_id is None
    generate_schedule(book.space, book.owner, plan, date(2026, 9, 29))
    occurrence.refresh_from_db()
    assert occurrence.status == "cancelled" and occurrence.event_id is None
    assert (
        m.Occurrence.objects.filter(plan=plan, sequence=occurrence.sequence).count()
        == 1
    )
    assert m.Occurrence.objects.filter(plan=plan, due_date="2026-09-29").exists()


def test_mixed_import_preserves_unrelated_rows_and_shared_file(book, settings):
    target = buy(book)
    other = m.Instrument.objects.create(
        tenant=book.space, name="账单保留产品", code="PURGE-IMPORT-B", kind="fund"
    )
    retained = buy(book, other, quantity="50", when="2026-08-03")
    settings.PRIVATE_MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    shared_file = settings.PRIVATE_MEDIA_ROOT / "mixed-source.csv"
    shared_file.write_text("synthetic statement", encoding="utf-8")
    batch = m.ImportBatch.objects.create(
        tenant=book.space,
        source="generic",
        filename="mixed-source.csv",
        digest="a" * 64,
        storage_key="mixed-source.csv",
        account=book.account,
        status="committed",
    )
    source_rows = []
    for index, event in enumerate((target, retained), 1):
        row = m.SourceRecord.objects.create(
            tenant=book.space,
            batch=batch,
            row_number=index,
            normalized=event.payload,
            identity=str(uuid.uuid4()),
        )
        m.EvidenceLink.objects.create(
            tenant=book.space, record=row, event=event, introduced=True
        )
        m.SourceFact.objects.create(
            tenant=book.space, identity=row.identity, event=event, fingerprint="b" * 64
        )
        source_rows.append(row)
    remove(book, "instruments", book.instrument)
    good(purge(book, "instruments", book.instrument))
    assert m.ImportBatch.objects.filter(pk=batch.pk).exists()
    assert not m.SourceRecord.objects.filter(pk=source_rows[0].pk).exists()
    assert m.SourceRecord.objects.filter(pk=source_rows[1].pk).exists()
    assert m.EvidenceLink.objects.filter(record=source_rows[1], event=retained).exists()
    assert m.SourceFact.objects.filter(event=retained).exists()
    assert shared_file.read_text(encoding="utf-8") == "synthetic statement"
    assert_remaining_events_balanced(book)
