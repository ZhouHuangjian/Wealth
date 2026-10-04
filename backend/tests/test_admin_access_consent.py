"""Delegation is an owner permission, never a platform administrator's own toggle."""

import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from django.db import DatabaseError, connection, transaction
from django.test import Client
from wealth import models as m
from wealth.common import DomainError, tenant_context
from wealth.platform_models import PlatformAudit, PlatformCommand
from wealth.workspace_management import update_workspace_details

pytestmark = pytest.mark.django_db
User = get_user_model()


def write(client, route, body, method="put", key=None):
    return getattr(client, method)(
        "/api/v1/" + route,
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid4()),
    )


@pytest.fixture
def book(settings):
    settings.WEALTH_MARKET_DATA_ENABLED = False
    users = {
        role: User.objects.create_user(
            "consent-" + role, is_superuser=role == "admin", is_staff=role == "admin"
        )
        for role in ("admin", "owner", "editor", "viewer", "outsider")
    }
    space = m.Workspace.objects.create(name="需所有者同意的账簿")
    other = m.Workspace.objects.create(name="另一未授权账簿")
    for role in ("owner", "editor", "viewer"):
        m.Membership.objects.create(workspace=space, user=users[role], role=role)
    m.Membership.objects.create(workspace=other, user=users["outsider"], role="owner")
    clients = {}
    for role, user in users.items():
        clients[role] = Client()
        clients[role].force_login(user)
    with tenant_context(space.pk):
        account = m.Account.objects.create(tenant=space, name="不可见银行资料")
        note = m.Resource.objects.create(
            tenant=space, kind="notes", data={"title": "私密内容"}
        )
    return SimpleNamespace(
        space=space,
        other=other,
        account=account,
        note=note,
        users=users,
        clients=clients,
    )


def toggle(book, enabled, **kwargs):
    book.space.refresh_from_db()
    return write(
        book.clients["owner"],
        f"spaces/{book.space.pk}/admin-access",
        {"enabled": enabled, "version": book.space.admin_access_version},
        **kwargs,
    )


def test_default_denied_and_platform_metadata_reports_unavailable(book):
    assert book.space.admin_access_enabled is False
    assert book.space.admin_access_version == 0
    admin = book.clients["admin"]
    assert admin.get("/api/v1/auth/me").json()["spaces"] == []
    meta = admin.get(f"/api/v1/admin/spaces/{book.space.pk}").json()
    assert meta["can_delegate"] is False and meta["admin_access_enabled"] is False
    response = book.clients["owner"].get(f"/api/v1/spaces/{book.space.pk}/admin-access")
    assert response.json() == {"enabled": False, "version": 0, "can_manage": True}
    for role in ("editor", "viewer"):
        assert (
            book.clients[role]
            .get(f"/api/v1/spaces/{book.space.pk}/admin-access")
            .json()["can_manage"]
            is False
        )


@pytest.mark.parametrize(
    "route",
    [
        "accounts",
        "accounts/{account}",
        "events",
        "holdings",
        "profile",
        "members",
        "administration",
        "administration/notes/{note}",
        "exports",
        "admin-access",
        "overview",
        "income-calendar",
    ],
)
def test_all_delegated_reads_deny_without_consent(book, route):
    route = route.format(account=book.account.pk, note=book.note.pk)
    response = book.clients["admin"].get(f"/api/v1/spaces/{book.space.pk}/{route}")
    assert response.status_code == 403
    assert response.json()["code"] == "admin_access_required"
    assert "不可见银行资料" not in response.content.decode()


@pytest.mark.parametrize(
    "method,route,body",
    [
        ("post", "accounts", {"name": "不应创建"}),
        ("patch", "profile", {"version": 0, "name": "不应改名"}),
        ("post", "administration/notes", {"values": {"title": "不应创建"}}),
        ("post", "invitations", {}),
        ("post", "plans/00000000-0000-0000-0000-000000000001/history-preview", {}),
        (
            "post",
            "plans/00000000-0000-0000-0000-000000000001/history-import/validate",
            {},
        ),
        ("post", "exports", {}),
        ("put", "admin-access", {"enabled": True, "version": 0}),
    ],
)
def test_delegated_writes_and_readonly_posts_deny_before_execution(
    book, method, route, body
):
    response = write(
        book.clients["admin"], f"spaces/{book.space.pk}/{route}", body, method=method
    )
    assert response.status_code == 403
    with tenant_context(book.space.pk):
        assert not m.Idempotency.objects.filter(tenant=book.space).exists()
        assert m.Account.objects.filter(tenant=book.space).count() == 1
    book.space.refresh_from_db()
    assert not book.space.admin_access_enabled


@pytest.mark.parametrize("role", ["editor", "viewer", "outsider", "admin"])
def test_only_ordinary_owner_can_enable(book, role):
    response = write(
        book.clients[role],
        f"spaces/{book.space.pk}/admin-access",
        {"enabled": True, "version": 0},
    )
    assert response.status_code == (404 if role == "outsider" else 403)
    book.space.refresh_from_db()
    assert not book.space.admin_access_enabled


def test_admin_cannot_self_grant_even_with_legacy_owner_membership(book):
    m.Membership.objects.create(
        workspace=book.space, user=book.users["admin"], role="owner"
    )
    assert toggle(book, True).status_code == 200
    for enabled in (False, True):
        result = write(
            book.clients["admin"],
            f"spaces/{book.space.pk}/admin-access",
            {"enabled": enabled, "version": 1},
        )
        assert result.status_code == 403
    read = book.clients["admin"].get(f"/api/v1/spaces/{book.space.pk}/admin-access")
    assert read.json() == {"enabled": True, "version": 1, "can_manage": False}


def test_grant_revoke_same_session_and_old_idempotency_do_not_bypass(book):
    before = book.space.revision
    assert toggle(book, True).json() == {
        "enabled": True,
        "version": 1,
        "can_manage": True,
    }
    admin = book.clients["admin"]
    route = f"spaces/{book.space.pk}/accounts"
    body, key = (
        {"name": "明确授权代录账户", "kind": "bank", "currency": "CNY"},
        str(uuid4()),
    )
    result = write(admin, route, body, method="post", key=key)
    assert result.status_code == 200, result.content
    with tenant_context(book.space.pk):
        assert (
            m.Account.objects.get(pk=result.json()["id"]).created_by_id
            == book.users["admin"].pk
        )
        assert m.Audit.objects.filter(
            tenant=book.space,
            action="workspace.admin_access.changed",
            created_by=book.users["owner"],
        ).exists()
    assert admin.get(f"/api/v1/spaces/{book.other.pk}/accounts").status_code == 403
    assert toggle(book, False).status_code == 200
    assert admin.get("/api/v1/" + route).status_code == 403
    assert write(admin, route, body, method="post", key=key).status_code == 403
    assert book.clients["owner"].get("/api/v1/" + route).status_code == 200
    # Consent itself must not rewrite financial facts or invalidate reconciliations.
    assert before == 0
    assert toggle(book, True).status_code == 200
    assert admin.get("/api/v1/" + route).status_code == 200


def test_owner_version_validation_and_idempotent_replay(book):
    route = f"spaces/{book.space.pk}/admin-access"
    owner = book.clients["owner"]
    assert write(owner, route, {"enabled": True}).status_code == 428
    assert write(owner, route, {"enabled": "false", "version": 0}).status_code == 422
    assert (
        write(
            owner,
            route,
            {"enabled": True, "version": 0, "actor_id": book.users["admin"].pk},
        ).status_code
        == 422
    )
    key, body = str(uuid4()), {"enabled": True, "version": 0}
    first = write(owner, route, body, key=key)
    assert first.status_code == 200
    assert write(owner, route, body, key=key).json() == first.json()
    assert write(owner, route, {"enabled": False, "version": 0}).status_code == 412
    assert toggle(book, False).status_code == 200
    # Replaying a former grant acknowledges that command; it must not re-enable.
    assert write(owner, route, body, key=key).status_code == 200
    book.space.refresh_from_db()
    assert not book.space.admin_access_enabled and book.space.admin_access_version == 2
    assert book.space.revision == 0
    with tenant_context(book.space.pk):
        assert m.Event.objects.filter(tenant=book.space).count() == 0
        assert (
            m.Audit.objects.filter(
                tenant=book.space, action="workspace.admin_access.changed"
            ).count()
            == 2
        )


def test_revoked_owner_cannot_replay_old_grant(book):
    key, route = str(uuid4()), f"spaces/{book.space.pk}/admin-access"
    body = {"enabled": True, "version": 0}
    assert write(book.clients["owner"], route, body, key=key).status_code == 200
    m.Membership.objects.filter(workspace=book.space, user=book.users["owner"]).update(
        role="editor"
    )
    assert write(book.clients["owner"], route, body, key=key).status_code == 403


def test_platform_rename_requires_consent_including_replay_and_direct_service(book):
    admin, route = book.clients["admin"], f"admin/spaces/{book.space.pk}"
    body = {"name": "获许可改名", "version": 0}
    assert write(admin, route, body, method="patch").status_code == 403
    with pytest.raises(DomainError, match="尚未允许"):
        update_workspace_details(book.space, book.users["admin"], body)
    assert toggle(book, True).status_code == 200
    key = str(uuid4())
    first = write(admin, route, body, method="patch", key=key)
    assert first.status_code == 200, first.content
    assert toggle(book, False).status_code == 200
    assert write(admin, route, body, method="patch", key=key).status_code == 403
    assert (
        PlatformCommand.objects.filter(actor=book.users["admin"], key=key).count() == 1
    )


def test_platform_lifecycle_is_allowed_without_delegation_and_create_stays_closed(book):
    admin = book.clients["admin"]
    assert admin.get("/api/v1/admin/users").status_code == 200
    created = write(
        admin,
        "admin/spaces",
        {
            "name": "平台新建但未授权",
            "owner_user_id": book.users["owner"].pk,
            "admin_access_enabled": True,
        },
        method="post",
    )
    assert created.status_code == 200, created.content
    assert created.json()["can_delegate"] is False
    assert created.json()["admin_access_enabled"] is False
    sid = created.json()["id"]
    deleted = write(
        admin,
        f"admin/spaces/{sid}",
        {"version": 0, "confirm_name": "平台新建但未授权"},
        method="delete",
    )
    assert deleted.status_code == 200, deleted.content
    restored = write(
        admin,
        f"admin/spaces/{sid}/restore",
        {"version": deleted.json()["version"], "confirm_name": "平台新建但未授权"},
        method="post",
    )
    assert restored.status_code == 200, restored.content
    assert not m.Workspace.objects.get(pk=sid).admin_access_enabled


def test_template_snapshot_publish_list_apply_and_cached_publish_recheck_consent(book):
    admin = book.clients["admin"]
    params = {"user_id": book.users["owner"].pk, "space_id": str(book.space.pk)}
    route = "/api/v1/admin/configuration-templates/preview"
    assert admin.get(route, params).status_code == 403
    assert toggle(book, True).status_code == 200
    preview = admin.get(route, params)
    assert preview.status_code == 200, preview.content
    body = {
        "source_user_id": book.users["owner"].pk,
        "source_space_id": str(book.space.pk),
        "title": "用户的配置",
        "preview_digest": preview.json()["preview_digest"],
    }
    key = str(uuid4())
    published = write(
        admin, "admin/configuration-templates", body, method="post", key=key
    )
    assert published.status_code == 200, published.content
    template = published.json()
    assert (
        book.clients["outsider"].get("/api/v1/configuration-templates").json()["count"]
        == 1
    )
    assert toggle(book, False).status_code == 200
    assert admin.get(route, params).status_code == 403
    assert (
        write(
            admin, "admin/configuration-templates", body, method="post", key=key
        ).status_code
        == 403
    )
    assert admin.get("/api/v1/admin/configuration-templates").json()["count"] == 0
    assert (
        book.clients["outsider"].get("/api/v1/configuration-templates").json()["count"]
        == 0
    )
    applied = write(
        book.clients["outsider"],
        f"spaces/{book.other.pk}/configuration-templates/{template['id']}/apply",
        {
            "version": template["version"],
            "sections": ["dashboard"],
            "space_revision": 0,
        },
        method="post",
    )
    assert applied.status_code == 404
    assert (
        write(
            admin,
            f"admin/configuration-templates/{template['id']}",
            {"version": template["version"], "published": True},
            method="patch",
        ).status_code
        == 403
    )


def test_audit_keeps_lifecycle_metadata_but_redacts_financial_detail_on_revoke(book):
    entry = PlatformAudit.objects.create(
        actor=book.users["admin"],
        action="business_record.purged",
        target=str(book.account.pk),
        detail={"space_id": str(book.space.pk), "cash_effects": {"CNY": "987654.12"}},
    )
    rows = book.clients["admin"].get("/api/v1/admin/audit").json()["items"]
    row = next(r for r in rows if r["id"] == str(entry.pk))
    assert row["detail"]["redacted"] is True
    assert "987654.12" not in json.dumps(rows)
    assert toggle(book, True).status_code == 200
    rows = book.clients["admin"].get("/api/v1/admin/audit").json()["items"]
    assert next(r for r in rows if r["id"] == str(entry.pk))["detail"][
        "cash_effects"
    ] == {"CNY": "987654.12"}


def test_existing_export_download_is_revoked_for_the_same_administrator(book):
    assert toggle(book, True).status_code == 200
    admin = book.clients["admin"]
    exported = write(admin, f"spaces/{book.space.pk}/exports", {}, method="post")
    assert exported.status_code == 200, exported.content
    url = exported.json()["download_url"]
    download = admin.get(url)
    assert download.status_code == 200
    # Django's test iterator closes the response on exhaustion.
    assert b"".join(download.streaming_content).startswith(b"PK")
    assert toggle(book, False).status_code == 200
    denied = admin.get(url)
    assert denied.status_code == 403 and not denied.streaming
    assert denied.json()["code"] == "admin_access_required"
    with tenant_context(book.space.pk):
        # Revocation blocks access without deleting the existing evidence.
        assert m.Resource.objects.filter(
            pk=exported.json()["id"], kind="exports"
        ).exists()


@pytest.mark.parametrize(
    "actor_role,error",
    [
        ("admin", "Workspace owner consent required"),
        ("owner", "Active platform administrator required"),
    ],
)
def test_privileged_business_cleanup_function_also_requires_consent(
    book, actor_role, error
):
    with (
        pytest.raises(DatabaseError, match=error),
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        cursor.execute(
            "SELECT public.wealth_purge_business_record(%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
            [
                book.users[actor_role].pk,
                str(book.space.pk),
                "wealth_resource",
                str(book.note.pk),
                0,
                1,
                "私密内容",
                json.dumps({"wealth_resource": [str(book.note.pk)]}),
            ],
        )
    with tenant_context(book.space.pk):
        assert m.Resource.objects.filter(pk=book.note.pk).exists()
