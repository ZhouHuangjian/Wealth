"""Combined account edits and admin-facing user/book names preserve real facts."""

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from django.utils import timezone

from wealth.account_opening import (
    apply_account_edit,
    effective_snapshots,
    initialize_account,
    opening_date_metadata,
)
from wealth.common import DomainError, audit, bump, record, tenant_context
from wealth.ledger import balance, post_event
from wealth.models import Account, Audit, Event, Membership, Snapshot, Workspace
from wealth.platform_models import PlatformAudit
from wealth.workspace_management import update_workspace_details

pytestmark = pytest.mark.django_db
User = get_user_model()


def call(client, path, body, method="patch", key=None):
    return getattr(client, method)(
        f"/api/v1/{path}",
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
    )


@pytest.fixture
def setup():
    admin = User.objects.create_superuser("admin-edit-261", password="Test-only-95218")
    owner = User.objects.create_user("owner-edit-261", email="owner@example.test")
    editor = User.objects.create_user("editor-edit-261")
    viewer = User.objects.create_user("viewer-edit-261")
    outsider = User.objects.create_user("outside-edit-261")
    space = Workspace.objects.create(name="原账簿名")
    for user, role in ((owner, "owner"), (editor, "editor"), (viewer, "viewer")):
        Membership.objects.create(workspace=space, user=user, role=role)
    clients = {}
    for role, user in (("admin", admin), ("owner", owner), ("viewer", viewer)):
        clients[role] = Client()
        clients[role].force_login(user)
    return SimpleNamespace(
        admin=admin,
        owner=owner,
        editor=editor,
        viewer=viewer,
        outsider=outsider,
        space=space,
        clients=clients,
    )


def opening(p, kind="bank"):
    row = Account.objects.create(
        tenant=p.space,
        created_by=p.owner,
        name="原账户",
        kind=kind,
        valuation_mode="snapshot" if kind == "futures" else "detailed",
    )
    initialize_account(
        p.space,
        p.owner,
        row,
        {
            "opening_balance": "1000",
            "opening_date": "2026-09-20",
            "opening_coverage": "全部机构权益，无期权",
            "opening_coverage_confirmed": True,
            "opening_option_scope": "no_options",
        },
    )
    metadata = opening_date_metadata(p.space, row)
    return row, {
        "version": metadata["version"],
        "expected_revision": metadata["data_revision"],
        "opening_date": "2026-09-18",
        "reason": "核对机构原始日期",
        "name": "新账户",
    }


def save_profile(p):
    def save(row, body):
        # Mirrors model_resource's versioned validation/save in the caller.
        assert body["version"] == row.version
        assert "opening_date" not in body
        if "expected_revision" in body:
            p.space.refresh_from_db()
            assert body["expected_revision"] == p.space.revision
        row.name = body["name"]
        row.version += 1
        row.full_clean(exclude=["created_by"])
        row.save()
        bump(p.space, p.admin)
        audit(p.space, p.admin, "accounts.saved", row)
        return record(row)

    return save


@pytest.mark.parametrize("kind", ["bank", "futures"])
def test_account_profile_and_opening_date_commit_together_without_changed_amount(
    setup, kind
):
    p = setup
    with tenant_context(p.space.pk):
        row, body = opening(p, kind)
        result = apply_account_edit(p.space, p.admin, row, body, save_profile(p))
        row.refresh_from_db()
        assert row.name == "新账户" and row.version == result["version"] == 3
        assert result["opening"]["opening_date"] == "2026-09-18"
        assert result["opening"]["version"] == result["version"]
        assert result["opening_date_changed"] is True
        if kind == "bank":
            assert balance(p.space, row) == Decimal("1000")
            assert (
                Event.objects.filter(
                    tenant=p.space, kind="opening", reversal__isnull=True
                ).count()
                == 1
            )
            assert not Event.objects.filter(
                tenant=p.space, kind__in=["income", "expense"]
            ).exists()
        else:
            assert effective_snapshots(p.space, row).get().equity == Decimal("1000")
            assert Snapshot.objects.filter(tenant=p.space, account=row).count() == 2
        assert Audit.objects.filter(
            tenant=p.space, action="accounts.saved", created_by=p.admin
        ).exists()


@pytest.mark.parametrize("kind", ["bank", "futures"])
def test_invalid_profile_rolls_back_earlier_financial_date_correction(setup, kind):
    p = setup
    with tenant_context(p.space.pk):
        row, body = opening(p, kind)
        original = opening_date_metadata(p.space, row)

        def reject(row, clean_body):
            assert row.version == 2
            raise DomainError("档案身份字段冲突")

        with pytest.raises(DomainError, match="档案身份"):
            apply_account_edit(p.space, p.admin, row, body, reject)
        row.refresh_from_db()
        assert row.name == "原账户" and row.version == 1
        assert opening_date_metadata(p.space, row) == original
        assert Event.objects.filter(tenant=p.space).count() == (
            1 if kind == "bank" else 0
        )
        assert Snapshot.objects.filter(tenant=p.space).count() == (
            1 if kind == "futures" else 0
        )


@pytest.mark.parametrize("field,value", [("version", 0), ("expected_revision", 0)])
def test_stale_combined_edits_do_not_rename_account(setup, field, value):
    p = setup
    with tenant_context(p.space.pk):
        row, body = opening(p)
        with pytest.raises(DomainError) as exc:
            apply_account_edit(
                p.space, p.admin, row, {**body, field: value}, save_profile(p)
            )
        assert exc.value.status == 412
        row.refresh_from_db()
        assert row.name == "原账户" and row.version == 1
        assert Event.objects.filter(tenant=p.space).count() == 1


def test_date_after_spending_does_not_partially_save_profile(setup):
    p = setup
    with tenant_context(p.space.pk):
        row, body = opening(p)
        post_event(
            p.space,
            p.owner,
            {
                "kind": "expense",
                "account_id": str(row.pk),
                "amount": "200",
                "economic_date": "2026-09-22",
            },
        )
        body.update(
            expected_revision=opening_date_metadata(p.space, row)["data_revision"],
            opening_date="2026-09-23",
        )
        with pytest.raises(DomainError, match="不能晚于已有"):
            apply_account_edit(p.space, p.admin, row, body, save_profile(p))
        row.refresh_from_db()
        assert row.name == "原账户" and balance(p.space, row) == Decimal("800")


def test_unchanged_opening_date_needs_no_reason_or_financial_revision(setup):
    p = setup
    with tenant_context(p.space.pk):
        row, _ = opening(p)
        result = apply_account_edit(
            p.space,
            p.admin,
            row,
            {"version": 1, "name": "仅改名称", "opening_date": "2026-09-20"},
            save_profile(p),
        )
        assert result["name"] == "仅改名称" and result["opening_date_changed"] is False
        assert (
            result["version"] == 2 and Event.objects.filter(tenant=p.space).count() == 1
        )


def test_profile_can_be_renamed_without_any_opening(setup):
    p = setup
    with tenant_context(p.space.pk):
        row = Account.objects.create(tenant=p.space, name="未填期初")
        result = apply_account_edit(
            p.space, p.admin, row, {"version": 1, "name": "已改名"}, save_profile(p)
        )
        assert result["name"] == "已改名" and result["opening"]["available"] is False
        assert not Event.objects.filter(tenant=p.space).exists()


def test_admin_space_context_returns_only_associated_users_with_edit_versions(setup):
    p = setup
    response = p.clients["admin"].get(f"/api/v1/admin/spaces/{p.space.pk}")
    assert response.status_code == 200
    users = response.json()["users"]
    assert {u["id"] for u in users} == {p.owner.pk, p.editor.pk, p.viewer.pk}
    owner = next(u for u in users if u["id"] == p.owner.pk)
    assert owner["username"] == p.owner.username and owner["version"] == 0
    assert all("password" not in u and "is_staff" not in u for u in users)
    assert (
        p.clients["owner"].get(f"/api/v1/admin/spaces/{p.space.pk}").status_code == 403
    )
    members = (
        p.clients["owner"].get(f"/api/v1/spaces/{p.space.pk}/members").json()["items"]
    )
    assert all("email" not in member and "password" not in member for member in members)


def test_admin_username_rename_preserves_identity_membership_and_login(setup):
    p = setup
    old_id = p.owner.pk
    path = f"admin/users/{old_id}"
    body = {"version": 0, "username": "更正后的用户名"}
    first = call(p.clients["admin"], path, body, key="rename-user-once")
    assert first.status_code == 200, first.content
    again = call(p.clients["admin"], path, body, key="rename-user-once")
    assert again.json() == first.json()
    assert first.json()["version"] == 1 and first.json()["id"] == old_id
    p.owner.refresh_from_db()
    assert p.owner.username == "更正后的用户名" and not p.owner.is_superuser
    assert Membership.objects.get(workspace=p.space, user_id=old_id).role == "owner"
    assert (
        p.clients["owner"].get("/api/v1/auth/me").json()["user"]["username"]
        == "更正后的用户名"
    )
    assert (
        call(
            p.clients["admin"], path, {"version": 0, "username": "陈旧修改"}
        ).status_code
        == 412
    )


@pytest.mark.parametrize(
    "extra",
    [
        {"id": 98765},
        {"is_superuser": True},
        {"is_staff": True},
        {"password": "Unexpected-new-pass"},
    ],
)
def test_admin_profile_edit_cannot_write_internal_identity_fields(setup, extra):
    p = setup
    original = p.owner.username
    response = call(
        p.clients["admin"],
        f"admin/users/{p.owner.pk}",
        {"version": 0, "username": "不可部分保存", **extra},
    )
    assert response.status_code == 422
    p.owner.refresh_from_db()
    assert p.owner.username == original and not p.owner.is_staff


def test_only_admin_can_edit_usernames_and_duplicates_are_rejected(setup):
    p = setup
    path = f"admin/users/{p.owner.pk}"
    assert (
        call(p.clients["owner"], path, {"version": 0, "username": "越权"}).status_code
        == 403
    )
    assert (
        call(
            p.clients["admin"], path, {"version": 0, "username": p.viewer.username}
        ).status_code
        == 422
    )
    p.owner.refresh_from_db()
    assert p.owner.username == "owner-edit-261"


@pytest.mark.parametrize("role", ["admin", "owner"])
def test_book_rename_preserves_members_currency_and_financial_facts(setup, role):
    p = setup
    with tenant_context(p.space.pk):
        row, _ = opening(p)
        before = list(
            Event.objects.filter(tenant=p.space).values(
                "id", "payload", "economic_date"
            )
        )
        p.space.refresh_from_db()
        result = update_workspace_details(
            p.space,
            getattr(p, role),
            {"version": p.space.revision, "name": "更正后的账簿"},
        )
        assert result.name == "更正后的账簿" and result.base_currency == "CNY"
        assert Membership.objects.filter(workspace=p.space).count() == 3
        assert balance(p.space, row) == Decimal("1000")
        assert (
            list(
                Event.objects.filter(tenant=p.space).values(
                    "id", "payload", "economic_date"
                )
            )
            == before
        )
        assert Audit.objects.filter(
            tenant=p.space,
            action="workspace.admin_updated"
            if role == "admin"
            else "workspace.updated",
        ).exists()
    if role == "admin":
        assert PlatformAudit.objects.filter(
            actor=p.admin, action="space.updated", target=str(p.space.pk)
        ).exists()


@pytest.mark.parametrize("role", ["editor", "viewer", "outsider"])
def test_nonowners_cannot_rename_books(setup, role):
    p = setup
    with pytest.raises(DomainError) as exc:
        update_workspace_details(
            p.space, getattr(p, role), {"version": 0, "name": "越权改名"}
        )
    assert exc.value.status == 403
    p.space.refresh_from_db()
    assert p.space.name == "原账簿名"


def test_admin_book_patch_uses_same_versioned_service(setup):
    p = setup
    response = call(
        p.clients["admin"],
        f"admin/spaces/{p.space.pk}",
        {"version": 0, "name": "管理员账簿名"},
    )
    assert response.status_code == 200, response.content
    assert response.json()["name"] == "管理员账簿名" and response.json()["version"] == 1
    assert (
        call(
            p.clients["admin"],
            f"admin/spaces/{p.space.pk}",
            {"version": 0, "name": "过期"},
        ).status_code
        == 412
    )


@pytest.mark.parametrize(
    "body",
    [
        {"name": None},
        {"name": " "},
        {"timezone": "Invalid/Zone"},
        {"base_currency": "USD"},
        {"owner_user_id": 9999},
    ],
)
def test_invalid_book_details_do_not_apply_any_fields(setup, body):
    p = setup
    with pytest.raises(DomainError):
        update_workspace_details(
            p.space, p.admin, {"version": 0, "name": "不得先保存", **body}
        )
    p.space.refresh_from_db()
    assert p.space.name == "原账簿名" and p.space.revision == 0


def test_disabled_owner_and_deleted_book_cannot_be_renamed(setup):
    p = setup
    User.objects.filter(pk=p.owner.pk).update(is_active=False)
    with pytest.raises(DomainError) as exc:
        update_workspace_details(
            p.space, p.owner, {"version": 0, "name": "停用用户改名"}
        )
    assert exc.value.status == 403
    Workspace.objects.filter(pk=p.space.pk).update(deleted_at=timezone.now())
    with pytest.raises(DomainError) as exc:
        update_workspace_details(p.space, p.admin, {"version": 0, "name": "已删除改名"})
    assert exc.value.status == 404
