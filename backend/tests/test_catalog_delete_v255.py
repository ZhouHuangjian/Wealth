"""Recoverable catalog removal never deletes immutable financial evidence."""

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from wealth.account_opening import initialize_account
from wealth.catalog_lifecycle import (
    KIND,
    delete_catalog_item,
    deleted_catalog_ids,
    deletion_preview,
    filter_active_catalog,
    is_catalog_deleted,
    restore_catalog_item,
)
from wealth.common import DomainError, get_obj, tenant_context
from wealth.ledger import balance, post_event, reverse_event
from wealth.models import (
    Account,
    Audit,
    Event,
    ImportBatch,
    Instrument,
    JournalLine,
    Membership,
    Occurrence,
    PositionMovement,
    Price,
    Resource,
    ResourceRevision,
    Snapshot,
    SourceRecord,
    Workspace,
)
from wealth.planning import save_resource

pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    user = get_user_model().objects.create_user("catalog-delete-owner")
    space = Workspace.objects.create(name="删除合成账簿")
    Membership.objects.create(workspace=space, user=user, role="owner")
    client = Client()
    client.force_login(user)
    with tenant_context(space.pk):
        account = Account.objects.create(tenant=space, kind="bank", name="误建期初账户")
        initialize_account(
            space,
            user,
            account,
            {"opening_balance": "100", "opening_date": "2026-08-01"},
        )
        instrument = Instrument.objects.create(
            tenant=space, code="019173", name="误建产品", kind="fund"
        )
        yield SimpleNamespace(
            space=space,
            user=user,
            account=account,
            instrument=instrument,
            client=client,
        )


def facts(book):
    return {
        model.__name__: list(
            model.objects.filter(tenant=book.space).order_by("pk").values()
        )
        for model in (
            Event,
            JournalLine,
            PositionMovement,
            Snapshot,
            Price,
            ImportBatch,
            SourceRecord,
        )
    }


def request_body(book, kind="accounts", obj=None):
    obj = obj or (book.account if kind == "accounts" else book.instrument)
    preview = deletion_preview(book.space, kind, obj.pk)
    return {
        "version": preview["object"]["version"],
        "expected_revision": preview["data_revision"],
        "confirm": True,
    }


def delete(book, kind="accounts", obj=None):
    obj = obj or (book.account if kind == "accounts" else book.instrument)
    return delete_catalog_item(
        book.space, book.user, kind, obj.pk, request_body(book, kind, obj)
    )


def restore(book, kind="accounts", obj=None):
    obj = obj or (book.account if kind == "accounts" else book.instrument)
    return restore_catalog_item(
        book.space, book.user, kind, obj.pk, request_body(book, kind, obj)
    )


def test_initial_cash_delete_restore_retains_facts_and_versions(book):
    before = facts(book)
    count_audit = Audit.objects.count()
    count_resources = Resource.objects.count()
    preview = deletion_preview(book.space, "accounts", book.account.pk)
    assert preview["can_delete"] and not preview["deleted"]
    assert D(preview["impact"]["removed_value"]) == 100
    assert D(preview["impact"]["net_asset_change"]) == -100
    assert preview["retained"]["opening_events"] == 1
    assert facts(book) == before and Audit.objects.count() == count_audit
    assert Resource.objects.count() == count_resources
    deleted = delete(book)
    assert deleted["deleted"] is True and deleted["item"]["archived"] is True
    assert deleted["item"]["version"] == 2
    assert is_catalog_deleted(book.space, "accounts", book.account.pk)
    assert deleted_catalog_ids(book.space, "accounts") == [str(book.account.pk)]
    assert not filter_active_catalog(
        Account.objects.filter(tenant=book.space), book.space, "accounts"
    ).exists()
    assert Account.objects.filter(pk=book.account.pk).exists()
    assert facts(book) == before and balance(book.space, book.account) == 100
    assert deletion_preview(book.space, "accounts", book.account.pk)["can_restore"]
    restored = restore(book)
    assert restored["deleted"] is False and restored["item"]["archived"] is False
    assert restored["item"]["version"] == 3
    assert not is_catalog_deleted(book.space, "accounts", book.account.pk)
    assert facts(book) == before
    tomb = Resource.objects.get(kind=KIND)
    assert tomb.version == 2
    assert ResourceRevision.objects.filter(resource=tomb).count() == 2
    assert set(
        Audit.objects.filter(action__startswith="catalog.").values_list(
            "action", flat=True
        )
    ) == {"catalog.deleted", "catalog.restored"}
    assert (
        D(
            Audit.objects.get(action="catalog.deleted").detail["impact"][
                "net_asset_change"
            ]
        )
        == -100
    )
    assert (
        D(
            Audit.objects.get(action="catalog.restored").detail["impact"][
                "net_asset_change"
            ]
        )
        == 100
    )


def test_deleted_account_get_obj_rejected_but_restore_can_read_target(book):
    delete(book)
    with pytest.raises(DomainError) as caught:
        get_obj(Account, book.space, book.account.pk)
    assert caught.value.status == 409
    assert deletion_preview(book.space, "accounts", book.account.pk)["deleted"]
    restore(book)
    assert get_obj(Account, book.space, book.account.pk).pk == book.account.pk


def test_existing_archived_state_survives_delete_restore(book):
    account = Account.objects.create(
        tenant=book.space, kind="bank", name="原已归档", archived=True
    )
    delete(book, obj=account)
    assert restore(book, obj=account)["item"]["archived"] is True


def test_institution_opening_snapshot_is_preserved_and_restore_restores_reference(book):
    account = Account.objects.create(
        tenant=book.space, kind="futures", valuation_mode="snapshot", name="误建期货"
    )
    initialize_account(
        book.space,
        book.user,
        account,
        {
            "opening_balance": "120",
            "opening_date": "2026-09-24",
            "opening_coverage": "客户权益",
            "opening_coverage_confirmed": True,
            "opening_option_scope": "no_options",
            "opening_valuation_basis": "intraday",
        },
    )
    before = facts(book)
    preview = deletion_preview(book.space, "accounts", account.pk)
    assert preview["can_delete"]
    assert D(preview["impact"]["removed_value"]) == 120
    assert preview["impact"]["valuation_basis"] == "institution_estimate"
    delete(book, obj=account)
    restore(book, obj=account)
    assert facts(book) == before


@pytest.mark.parametrize("snapshot", [False, True])
def test_audited_opening_date_correction_remains_deletable_without_losing_sources(
    book, snapshot
):
    from wealth.account_opening import correct_opening_date

    account = book.account
    if snapshot:
        account = Account.objects.create(
            tenant=book.space,
            name="更正期初机构",
            kind="futures",
            valuation_mode="snapshot",
        )
        initialize_account(
            book.space,
            book.user,
            account,
            {
                "opening_balance": "120",
                "opening_date": "2026-09-24",
                "opening_coverage": "客户权益",
                "opening_coverage_confirmed": True,
                "opening_option_scope": "no_options",
                "opening_valuation_basis": "intraday",
            },
        )
    correct_opening_date(
        book.space,
        book.user,
        account,
        {
            "version": account.version,
            "expected_revision": Workspace.objects.get(pk=book.space.pk).revision,
            "opening_date": "2026-07-01",
            "reason": "更正合成期初日期",
        },
    )
    before = facts(book)
    preview = deletion_preview(book.space, "accounts", account.pk)
    assert preview["can_delete"], preview
    assert D(preview["impact"]["removed_value"]) == (120 if snapshot else 100)
    delete(book, obj=account)
    restore(book, obj=account)
    assert facts(book) == before


def test_fake_opening_snapshot_details_do_not_authorize_deletion(book):
    Snapshot.objects.create(
        tenant=book.space,
        account=book.account,
        economic_date="2026-09-21",
        equity=100,
        currency="CNY",
        coverage="伪期初",
        details={"source": "manual_account_opening", "opening_account": True},
    )
    preview = deletion_preview(book.space, "accounts", book.account.pk)
    assert not preview["can_delete"]
    assert any(row["code"] == "snapshots" for row in preview["blockers"])


def test_generic_opening_payload_cannot_masquerade_as_account_initialization(book):
    account = Account.objects.create(tenant=book.space, name="通用接口期初")
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(account.pk),
            "economic_date": "2026-08-02",
            "amount": "50",
            "opening_account": True,
            "source": "manual_account_opening",
            "stage_key": f"{book.space.pk}:opening:{account.pk}",
        },
    )
    assert any(
        row["code"] == "financial_history"
        for row in deletion_preview(book.space, "accounts", account.pk)["blockers"]
    )


def test_unused_product_can_be_deleted_with_automatic_prices_and_quotes(book):
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        value="1.23",
        kind="official_nav",
        economic_date="2026-09-24",
        source="public",
    )
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={"instrument_id": str(book.instrument.pk), "status": "updated"},
    )
    before = facts(book)
    preview = deletion_preview(book.space, "instruments", book.instrument.pk)
    assert preview["can_delete"]
    assert preview["retained"]["prices"] == preview["retained"]["market_resources"] == 1
    deleted = delete(book, "instruments")
    assert (
        deleted["deleted"] and Instrument.objects.filter(pk=book.instrument.pk).exists()
    )
    assert facts(book) == before
    restored = restore(book, "instruments")
    assert not restored["deleted"] and facts(book) == before


@pytest.mark.parametrize("reverse", [False, True])
def test_real_cashflow_blocks_account_even_when_reversed(book, reverse):
    event = post_event(
        book.space,
        book.user,
        {
            "kind": "expense",
            "account_id": str(book.account.pk),
            "amount": "10",
            "economic_date": "2026-08-02",
        },
    )
    if reverse:
        reverse_event(book.space, book.user, event, "撤销合成记录")
    before = facts(book)
    preview = deletion_preview(book.space, "accounts", book.account.pk)
    assert not preview["can_delete"]
    assert any(row["code"] == "financial_history" for row in preview["blockers"])
    with pytest.raises(DomainError) as caught:
        delete(book)
    assert caught.value.code == "catalog_has_dependencies"
    assert facts(book) == before and not Resource.objects.filter(kind=KIND).exists()


@pytest.mark.parametrize("reverse", [False, True])
def test_position_facts_block_both_product_and_account_deletion(book, reverse):
    event = post_event(
        book.space,
        book.user,
        {
            "kind": "buy",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.instrument.pk),
            "quantity": "2",
            "price": "3",
            "economic_date": "2026-09-21",
        },
    )
    if reverse:
        reverse_event(book.space, book.user, event, "撤销合成买入")
    assert not deletion_preview(book.space, "accounts", book.account.pk)["can_delete"]
    assert not deletion_preview(book.space, "instruments", book.instrument.pk)[
        "can_delete"
    ]


@pytest.mark.parametrize(
    "resource_kind,payload,kind",
    [
        ("plans", {"account_id": "TARGET"}, "accounts"),
        ("plans", {"instrument_id": "TARGET"}, "instruments"),
        ("reservations", {"funding": [{"source_account_id": "TARGET"}]}, "accounts"),
        ("option_positions", {"account_id": "TARGET", "status": "closed"}, "accounts"),
        (
            "option_positions",
            {"instrument_id": "TARGET", "status": "active"},
            "instruments",
        ),
        ("dca_import_periods", {"instrument_id": "TARGET"}, "instruments"),
    ],
)
def test_referenced_resources_are_listed_without_cascade_changes(
    book, resource_kind, payload, kind
):
    obj = book.account if kind == "accounts" else book.instrument
    data = json.loads(json.dumps(payload).replace("TARGET", str(obj.pk)))
    resource = Resource.objects.create(
        tenant=book.space, kind=resource_kind, data={"name": "关联数据", **data}
    )
    preview = deletion_preview(book.space, kind, obj.pk)
    assert not preview["can_delete"]
    dependency = next(
        row for row in preview["blockers"] if row["code"] == f"resource_{resource_kind}"
    )
    assert dependency["items"][0] == {"id": str(resource.pk), "name": "关联数据"}
    assert Resource.objects.get(pk=resource.pk).data == {"name": "关联数据", **data}


def test_product_account_link_requires_ordered_delete_and_restore(book):
    book.instrument.specification = {"account_ids": [str(book.account.pk)]}
    book.instrument.save()
    assert not deletion_preview(book.space, "accounts", book.account.pk)["can_delete"]
    delete(book, "instruments")
    delete(book)
    preview = deletion_preview(book.space, "instruments", book.instrument.pk)
    assert (
        not preview["can_restore"]
        and preview["restore_blockers"][0]["code"] == "deleted_linked_account"
    )
    with pytest.raises(DomainError) as caught:
        restore(book, "instruments")
    assert caught.value.code == "catalog_restore_dependencies"
    restore(book)
    restore(book, "instruments")
    assert Instrument.objects.get(pk=book.instrument.pk).specification[
        "account_ids"
    ] == [str(book.account.pk)]


def test_import_and_pending_occurrence_references_are_blockers(book):
    batch = ImportBatch.objects.create(
        tenant=book.space,
        source="synthetic",
        filename="合成账单.csv",
        digest="x",
        storage_key="test",
    )
    SourceRecord.objects.create(
        tenant=book.space,
        batch=batch,
        row_number=1,
        raw={},
        normalized={"account_id": str(book.account.pk)},
    )
    plan = Resource.objects.create(
        tenant=book.space, kind="plans", data={"name": "测试期次"}
    )
    Occurrence.objects.create(
        tenant=book.space,
        plan=plan,
        sequence=1,
        due_date="2026-09-21",
        amount=10,
        currency="CNY",
        details={"account_id": str(book.account.pk)},
    )
    codes = {
        row["code"]
        for row in deletion_preview(book.space, "accounts", book.account.pk)["blockers"]
    }
    assert {"import_records", "occurrences"} <= codes


@pytest.mark.parametrize(
    "change",
    [
        {"confirm": False},
        {"confirm": "true"},
        {"confirm": 1},
        {"version": 0},
        {"expected_revision": 0},
        {"version": True},
    ],
)
def test_explicit_confirmation_and_fresh_version_are_required(book, change):
    data = {**request_body(book), **change}
    before = facts(book)
    with pytest.raises(DomainError):
        delete_catalog_item(book.space, book.user, "accounts", book.account.pk, data)
    assert facts(book) == before and not Resource.objects.filter(kind=KIND).exists()


def test_deleted_restore_version_protection_and_single_tombstone(book):
    old_body = request_body(book)
    delete(book)
    with pytest.raises(DomainError) as caught:
        restore_catalog_item(
            book.space, book.user, "accounts", book.account.pk, old_body
        )
    assert caught.value.code == "version_conflict"
    restore(book)
    delete(book)
    assert Resource.objects.filter(kind=KIND).count() == 1
    assert Resource.objects.get(kind=KIND).version == 3


def test_cross_space_lookup_and_generic_tombstone_writes_are_rejected(book):
    other = Workspace.objects.create(name="别人的账簿")
    with tenant_context(other.pk):
        foreign = Account.objects.create(tenant=other, name="隔离账户")
    with pytest.raises(DomainError) as caught:
        deletion_preview(book.space, "accounts", foreign.pk)
    assert caught.value.status == 404
    with pytest.raises(DomainError):
        save_resource(
            book.space,
            book.user,
            KIND,
            {
                "target_id": str(book.account.pk),
                "target_kind": "accounts",
                "status": "deleted",
            },
        )
    assert not is_catalog_deleted(book.space, "accounts", book.account.pk)


def test_api_delete_is_idempotent_and_viewer_cannot_delete(book):
    base = f"/api/v1/spaces/{book.space.pk}/accounts/{book.account.pk}"
    preview = book.client.get(base + "/deletion")
    assert preview.status_code == 200, preview.content
    data = {
        "version": preview.json()["object"]["version"],
        "expected_revision": preview.json()["data_revision"],
        "confirm": True,
    }
    key = str(uuid.uuid4())
    first = book.client.delete(
        base,
        data=json.dumps(data),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    assert first.status_code == 200, first.content
    revision = Workspace.objects.get(pk=book.space.pk).revision
    second = book.client.delete(
        base,
        data=json.dumps(data),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    assert second.status_code == 200 and second.json() == first.json()
    assert Workspace.objects.get(pk=book.space.pk).revision == revision
    assert book.client.get(base).status_code == 409
    deleted_list = book.client.get(
        f"/api/v1/spaces/{book.space.pk}/accounts?status=deleted"
    )
    assert str(book.account.pk) in {row["id"] for row in deleted_list.json()["items"]}
    restore(book)
    Membership.objects.filter(workspace=book.space, user=book.user).update(
        role="viewer"
    )
    preview = book.client.get(base + "/deletion")
    assert preview.status_code == 200
    denied = book.client.delete(
        base,
        data=json.dumps(request_body(book)),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert denied.status_code == 403
