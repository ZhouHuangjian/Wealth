"""Delegated changes retain evidence, tenant isolation and meaningful totals."""

import json
import uuid
from decimal import Decimal as D
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from wealth import models as m
from wealth.common import tenant_context
from wealth.ledger import balance, post_event
from wealth.reporting import formal_price, overview, positions, performance

pytestmark = pytest.mark.django_db


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    admin = get_user_model().objects.create_superuser("data-operator")
    owner = get_user_model().objects.create_user("data-owner")
    space = m.Workspace.objects.create(name="代管合成账簿", admin_access_enabled=True)
    m.Membership.objects.create(workspace=space, user=owner, role="owner")
    clients = {}
    for name, user in (("admin", admin), ("owner", owner)):
        clients[name] = Client()
        clients[name].force_login(user)
    with tenant_context(space.pk):
        account = m.Account.objects.create(tenant=space, name="基金账户", kind="fund")
        instrument = m.Instrument.objects.create(
            tenant=space, name="合成产品", code="019172"
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


def read(b, route="", client="admin"):
    return b.clients[client].get(f"/api/v1/spaces/{b.space.pk}/administration/{route}")


def write(b, route, values=None, method="post", client="admin", **extra):
    b.space.refresh_from_db()
    body = dict(expected_revision=b.space.revision, reason="合成测试更正", **extra)
    if values is not None:
        body["values"] = values
    return getattr(b.clients[client], method)(
        f"/api/v1/spaces/{b.space.pk}/administration/{route}",
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )


def good(response):
    assert response.status_code == 200, response.content.decode()
    return response.json()


def test_admin_only_tenant_scoped_and_revocation(book):
    assert len(good(read(book))["categories"]) >= 20
    assert read(book, client="owner").status_code == 403
    assert (
        write(
            book, "notes", {"title": "非法", "body": "非法"}, client="owner"
        ).status_code
        == 403
    )
    other = m.Workspace.objects.create(name="其他空间")
    with tenant_context(other.pk):
        note = m.Resource.objects.create(
            tenant=other, kind="notes", data={"title": "私密"}
        )
    assert read(book, f"notes/{note.pk}").status_code == 404
    book.admin.is_superuser = False
    book.admin.save()
    assert read(book).status_code in {403, 404}


def test_note_create_edit_delete_restore_and_audit(book):
    created = good(write(book, "notes", {"title": "原始判断", "body": "原文"}))["item"]
    edited = good(
        write(
            book,
            f"notes/{created['id']}",
            {"title": "修订判断", "body": "修订正文"},
            method="patch",
            version=created["version"],
        )
    )["item"]
    assert (
        write(
            book,
            f"notes/{created['id']}",
            {"title": "过期覆盖"},
            method="patch",
            version=1,
        ).status_code
        == 412
    )
    removed = good(
        write(
            book,
            f"notes/{created['id']}",
            method="delete",
            version=edited["version"],
            confirm=True,
        )
    )["item"]
    assert not m.Resource.objects.filter(pk=created["id"]).exists()
    assert m.Resource.all_objects.get(pk=created["id"]).data["body"] == "修订正文"
    assert good(read(book, "notes?status=deleted"))["count"] == 1
    restored = good(
        write(book, f"notes/{created['id']}/restore", version=removed["version"])
    )["item"]
    assert not restored["deleted"]
    assert m.ResourceRevision.objects.filter(resource_id=created["id"]).count() >= 4
    assert m.Audit.objects.filter(
        tenant=book.space, action="administration.notes.delete", created_by=book.admin
    ).exists()


def test_plan_delete_removes_due_items_and_restore_revalidates(book):
    item = good(
        write(
            book,
            "plans",
            dict(
                name="定期支出",
                kind="expense",
                account_id=str(book.account.pk),
                amount="10",
                currency="CNY",
                start_date="2026-09-01",
                frequency="daily",
                status="active",
            ),
        )
    )["item"]
    assert m.Occurrence.objects.filter(plan_id=item["id"]).exists()
    removed = good(
        write(
            book,
            f"plans/{item['id']}",
            method="delete",
            version=item["version"],
            confirm=True,
        )
    )["item"]
    assert not m.Occurrence.objects.filter(plan_id=item["id"]).exists()
    good(write(book, f"plans/{item['id']}/restore", version=removed["version"]))
    assert m.Occurrence.objects.filter(plan_id=item["id"]).exists()


@pytest.mark.parametrize(
    "category,values,model,change",
    [
        (
            "prices",
            {
                "value": "1.2",
                "economic_date": "2026-09-01",
                "kind": "official_nav",
                "source": "合成",
            },
            m.Price,
            {"value": "1.1"},
        ),
        (
            "fx",
            {
                "base": "USD",
                "quote": "CNY",
                "rate": "7.2",
                "economic_date": "2026-09-01",
                "purpose": "valuation",
                "source": "合成",
            },
            m.FxRate,
            {"rate": "7.1"},
        ),
        (
            "snapshots",
            {
                "equity": "1000",
                "currency": "CNY",
                "economic_date": "2026-09-01",
                "coverage": "客户权益",
                "complete": False,
            },
            m.Snapshot,
            {"equity": "990"},
        ),
    ],
)
def test_observation_correction_supersedes_without_destroying_original(
    book, category, values, model, change
):
    values = dict(values)
    if category == "prices":
        values["instrument_id"] = str(book.instrument.pk)
    if category == "snapshots":
        values["account_id"] = str(book.account.pk)
    created = good(write(book, category, values))["item"]
    updated = good(
        write(
            book,
            f"{category}/{created['id']}",
            {**created["values"], **change},
            method="patch",
            version=created["version"],
        )
    )["item"]
    assert updated["id"] != created["id"]
    assert not model.objects.filter(pk=created["id"]).exists()
    assert model.all_objects.filter(pk=created["id"]).exists()
    old = good(read(book, f"{category}/{created['id']}"))["item"]
    assert (
        write(
            book, f"{category}/{created['id']}/restore", version=old["version"]
        ).status_code
        == 409
    )
    if category == "prices":
        assert formal_price(book.space, book.instrument, "2026-09-02").value == D("1.1")
    good(
        write(
            book,
            f"{category}/{updated['id']}",
            method="delete",
            version=updated["version"],
            confirm=True,
        )
    )
    good(write(book, f"{category}/{created['id']}/restore", version=old["version"]))
    assert model.objects.filter(pk=created["id"]).exists()


def test_event_edit_reverses_and_reposts_atomically(book):
    created = good(
        write(
            book,
            "events",
            dict(
                kind="expense",
                account_id=str(book.account.pk),
                amount="20",
                economic_date="2026-09-02",
            ),
        )
    )["item"]
    before = m.Event.objects.count()
    failed = write(
        book,
        f"events/{created['id']}",
        {**created["values"], "amount": "invalid"},
        method="patch",
        version=created["version"],
    )
    assert failed.status_code == 422
    assert m.Event.objects.count() == before
    updated = good(
        write(
            book,
            f"events/{created['id']}",
            {**created["values"], "amount": "30"},
            method="patch",
            version=created["version"],
        )
    )["item"]
    assert updated["id"] != created["id"]
    assert balance(book.space, book.account) == D("970")
    good(
        write(
            book,
            f"events/{updated['id']}",
            method="delete",
            version=updated["version"],
            confirm=True,
        )
    )
    assert balance(book.space, book.account) == D("1000")


def test_admin_catalog_removal_hides_holding_and_dependent_plan_preserves_facts(book):
    post_event(
        book.space,
        book.owner,
        dict(
            kind="buy",
            account_id=str(book.account.pk),
            instrument_id=str(book.instrument.pk),
            amount="100",
            price="1",
            quantity="100",
            economic_date="2026-08-02",
        ),
    )
    m.Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        value="1.1",
        economic_date="2026-09-01",
    )
    plan = good(
        write(
            book,
            "plans",
            dict(
                name="定投",
                kind="dca",
                account_id=str(book.account.pk),
                instrument_id=str(book.instrument.pk),
                amount="10",
                currency="CNY",
                start_date="2026-09-01",
                frequency="daily",
                status="active",
            ),
        )
    )["item"]
    preview = good(read(book, f"instruments/{book.instrument.pk}"))
    assert D(preview["impact"]["removed_value"]) == 110
    counts = (
        m.Event.objects.count(),
        m.JournalLine.objects.count(),
        m.PositionMovement.objects.count(),
    )
    item = good(
        write(
            book,
            f"instruments/{book.instrument.pk}",
            method="delete",
            version=book.instrument.version,
            confirm=True,
        )
    )["item"]
    assert positions(book.space) == []
    assert not m.Resource.objects.filter(pk=plan["id"]).exists()
    assert D(overview(book.space)["net_assets"]) == 900
    assert performance(book.space)["net_profit"] is None
    assert counts == (
        m.Event.objects.count(),
        m.JournalLine.objects.count(),
        m.PositionMovement.objects.count(),
    )
    good(
        write(
            book, f"instruments/{book.instrument.pk}/restore", version=item["version"]
        )
    )
    assert len(positions(book.space)) == 1
    # Restoring the catalog never silently restarts previously removed plans.
    assert not m.Resource.objects.filter(pk=plan["id"]).exists()


def test_resource_reference_blocks_parent_delete_and_private_fields_rejected(book):
    goal = good(write(book, "goals", dict(name="房屋", amount="100", currency="CNY")))[
        "item"
    ]
    good(
        write(
            book,
            "scenarios",
            dict(name="方案", goal_id=goal["id"], amount="100", currency="CNY"),
        )
    )
    assert (
        write(
            book,
            f"goals/{goal['id']}",
            method="delete",
            version=goal["version"],
            confirm=True,
        ).status_code
        == 409
    )
    assert (
        write(
            book,
            "notes",
            {"title": "伪造", "body": "正文", "_administration_deleted": True},
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    "category,values",
    [
        (
            "budgets",
            dict(
                name="日常预算",
                amount="100",
                currency="CNY",
                start_date="2026-09-01",
                end_date="2026-09-30",
            ),
        ),
        (
            "reservations",
            dict(name="支出预留", amount="100", currency="CNY", status="active"),
        ),
        ("strategies", dict(name="配置策略", status="active", description="原策略")),
        ("todos", dict(name="整理账单", status="active")),
        ("watchlist", dict(name="观察产品", description="继续观察")),
        (
            "investment-tags",
            dict(name="长期持有", target_weight="30", instrument_ids=[]),
        ),
        ("market-watchlist", dict(enabled=False, show_on_home=True)),
        (
            "dashboard-preferences",
            dict(show_market_environment=True, show_valuation=True, show_signals=False),
        ),
        ("signal-rules", dict(name="回撤提醒", enabled=False, conditions=[])),
    ],
)
def test_remaining_resource_crud(book, category, values):
    values = dict(values)
    if category in {"budgets", "reservations"}:
        values["account_id"] = str(book.account.pk)
    if category in {"watchlist", "market-watchlist"}:
        values["instrument_id"] = str(book.instrument.pk)
    if category == "signal-rules":
        values["conditions"] = [
            dict(
                scope="instrument",
                instrument_id=str(book.instrument.pk),
                metric="drawdown",
                threshold="10",
                operator="gte",
                baseline="rolling_high",
            )
        ]
    item = good(write(book, category, values))["item"]
    edited = dict(item["values"])
    if "name" in edited:
        edited["name"] = "管理员修改"
    elif "show_on_home" in edited:
        edited["show_on_home"] = False
    else:
        edited["show_valuation"] = False
    item = good(
        write(
            book,
            f"{category}/{item['id']}",
            edited,
            method="patch",
            version=item["version"],
        )
    )["item"]
    assert all(item["values"][k] == v for k, v in edited.items())
    item = good(
        write(
            book,
            f"{category}/{item['id']}",
            method="delete",
            version=item["version"],
            confirm=True,
        )
    )["item"]
    good(write(book, f"{category}/{item['id']}/restore", version=item["version"]))


def test_debit_confirm_cascade_requires_confirmation_and_reverses_in_order(book):
    debit = post_event(
        book.space,
        book.owner,
        dict(
            kind="fund_debit",
            account_id=str(book.account.pk),
            instrument_id=str(book.instrument.pk),
            amount="100",
            economic_date="2026-09-01",
        ),
    )
    post_event(
        book.space,
        book.owner,
        dict(
            kind="fund_confirm",
            account_id=str(book.account.pk),
            instrument_id=str(book.instrument.pk),
            related_event_id=str(debit.pk),
            amount="100",
            quantity="50",
            price="2",
            economic_date="2026-09-02",
        ),
    )
    assert good(read(book, f"events/{debit.pk}"))["related_count"] == 2
    assert (
        write(
            book,
            f"events/{debit.pk}",
            method="delete",
            version=debit.version,
            confirm=True,
        ).status_code
        == 409
    )
    good(
        write(
            book,
            f"events/{debit.pk}",
            method="delete",
            version=debit.version,
            confirm=True,
            include_related=True,
        )
    )
    assert balance(book.space, book.account) == D("1000")
    assert not positions(book.space)


def test_observation_successor_chain_and_opening_lineage(book):
    from wealth.account_opening import initialize_account, trusted_opening_ids

    account = m.Account.objects.create(
        tenant=book.space, name="合成期初银行", kind="bank"
    )
    initialize_account(
        book.space,
        book.owner,
        account,
        dict(opening_balance="100", opening_date="2026-08-01"),
    )
    opening = m.Event.objects.get(
        tenant=book.space, stage_key=f"{book.space.pk}:opening:{account.pk}"
    )
    values = good(read(book, f"events/{opening.pk}"))["item"]["values"]
    item = good(
        write(
            book,
            f"events/{opening.pk}",
            {**values, "amount": "120"},
            method="patch",
            version=opening.version,
        )
    )["item"]
    assert item["id"] in trusted_opening_ids(book.space, account)["cash"]
    assert balance(book.space, account) == 120
    values = dict(
        instrument_id=str(book.instrument.pk),
        value="1",
        economic_date="2026-09-01",
        source="合成",
        kind="official_nav",
    )
    first = good(write(book, "prices", values))["item"]
    second = good(
        write(
            book,
            f"prices/{first['id']}",
            {**values, "value": "2"},
            method="patch",
            version=first["version"],
        )
    )["item"]
    good(
        write(
            book,
            f"prices/{second['id']}",
            {**values, "value": "3"},
            method="patch",
            version=second["version"],
        )
    )
    first = good(read(book, f"prices/{first['id']}"))["item"]
    assert (
        write(
            book, f"prices/{first['id']}/restore", version=first["version"]
        ).status_code
        == 409
    )


def test_delete_idempotency_and_fresh_revision(book):
    item = good(write(book, "notes", dict(title="删除一次", body="原文")))["item"]
    book.space.refresh_from_db()
    body = dict(
        version=item["version"],
        expected_revision=book.space.revision,
        confirm=True,
        reason="清理合成记录",
    )
    path = f"/api/v1/spaces/{book.space.pk}/administration/notes/{item['id']}"
    key = str(uuid.uuid4())
    first = book.clients["admin"].delete(
        path,
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    good(first)
    second = book.clients["admin"].delete(
        path,
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    assert good(second) == first.json()
    assert (
        m.Audit.objects.filter(
            tenant=book.space, action="administration.notes.delete"
        ).count()
        == 1
    )
