import json
import uuid
from types import SimpleNamespace
import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from django.db import connection, transaction, DatabaseError
from wealth import models as m
from wealth.common import tenant_context
from wealth.platform_models import PlatformAudit, PlatformCommand, NavigationPreference

pytestmark = pytest.mark.django_db
User = get_user_model()


def call(client, route, body=None, method="post", key=None):
    return getattr(client, method)(
        "/api/v1/" + route,
        data=json.dumps(body or {}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
    )


@pytest.fixture
def platform():
    admin = User.objects.create_superuser(
        "platform-owner", password="Example-safe-only-55731"
    )
    ordinary = User.objects.create_user(
        "ordinary-owner", password="Example-safe-only-55731"
    )
    reader = User.objects.create_user(
        "ordinary-reader", password="Example-safe-only-55731"
    )
    own = m.Workspace.objects.create(name="自己的账簿")
    foreign = m.Workspace.objects.create(name="他人的账簿", admin_access_enabled=True)
    m.Membership.objects.create(workspace=foreign, user=ordinary, role="owner")
    m.Membership.objects.create(workspace=foreign, user=reader, role="viewer")
    with tenant_context(foreign.pk):
        account = m.Account.objects.create(tenant=foreign, name="他人的银行")
    a, u, r = Client(), Client(), Client()
    a.force_login(admin)
    u.force_login(ordinary)
    r.force_login(reader)
    return SimpleNamespace(
        admin=admin,
        ordinary=ordinary,
        reader=reader,
        own=own,
        foreign=foreign,
        account=account,
        a=a,
        u=u,
        r=r,
    )


def test_admin_enters_foreign_space_with_real_actor_and_rls(platform):
    p = platform
    auth = p.a.get("/api/v1/auth/me").json()
    assert auth["user"]["is_platform_admin"] is True
    assert auth["spaces"] == []
    assert p.a.get("/api/v1/admin/spaces").json()["count"] == 2
    assert (
        p.a.get(f"/api/v1/spaces/{p.foreign.pk}/accounts").json()["items"][0]["name"]
        == "他人的银行"
    )
    response = call(
        p.a,
        f"spaces/{p.foreign.pk}/accounts",
        {"name": "协助新建", "kind": "bank", "currency": "CNY"},
    )
    assert response.status_code == 200, response.content
    with tenant_context(p.foreign.pk):
        account = m.Account.objects.get(pk=response.json()["id"])
        assert account.created_by_id == p.admin.pk
    assert PlatformAudit.objects.filter(
        actor=p.admin, action="space.command", target=str(p.foreign.pk)
    ).exists()
    assert not m.Membership.objects.filter(user=p.admin, workspace=p.foreign).exists()
    assert (
        m.Account.objects.count() == 0
    )  # No DB bypass introduced for platform admins.


def test_ordinary_cannot_elevate_or_access_foreign_space(platform):
    p = platform
    assert p.u.get("/api/v1/admin/users").status_code == 403
    assert (
        call(
            p.u, "admin/spaces", {"name": "bad", "owner_user_id": p.ordinary.pk}
        ).status_code
        == 403
    )
    assert p.u.get(f"/api/v1/spaces/{p.own.pk}/accounts").status_code == 404
    assert (
        call(p.r, f"spaces/{p.foreign.pk}/accounts", {"name": "bad"}).status_code == 403
    )
    auth = p.u.get("/api/v1/auth/me").json()
    assert not auth["user"]["is_platform_admin"] and len(auth["spaces"]) == 1


def test_admin_flag_cannot_be_injected_via_user_signup(platform):
    assert (
        call(platform.u, "spaces", {"name": "new", "is_superuser": True}).status_code
        == 201
    )
    platform.ordinary.refresh_from_db()
    assert not platform.ordinary.is_superuser


def test_navigation_per_user_persistent_versioned_and_recoverable(platform):
    p = platform
    body = {
        "version": 0,
        "groups": {
            "main": {"order": ["analytics", "home"], "hidden": ["home", "settings"]},
            "settings": {"hidden": ["navigation"], "order": ["navigation"]},
        },
    }
    response = call(p.u, "me/navigation-preferences", body, "put")
    assert response.status_code == 200, response.content
    assert response.json()["groups"]["main"]["hidden"] == ["home"]
    assert response.json()["groups"]["settings"]["hidden"] == []
    assert p.a.get("/api/v1/me/navigation-preferences").json()["groups"] == {}
    assert call(p.u, "me/navigation-preferences", body, "put").status_code == 412
    assert (
        call(
            p.u, "me/navigation-preferences", {"version": 1, "groups": {}}, "put"
        ).json()["groups"]
        == {}
    )


@pytest.mark.parametrize(
    "groups",
    [
        {"other": {}},
        {"main": {"hidden": ["home", "home"]}},
        {"main": {"order": "home"}},
        {"main": {"order": ["<script>"]}},
    ],
)
def test_navigation_rejects_invalid_payloads(platform, groups):
    assert (
        call(
            platform.u,
            "me/navigation-preferences",
            {"version": 0, "groups": groups},
            "put",
        ).status_code
        == 422
    )
    assert not NavigationPreference.objects.filter(user=platform.ordinary).exists()


def test_admin_create_user_idempotent_audit_without_credentials(platform):
    body = {
        "username": "managed-new",
        "password": "Example-manage-only-38201",
        "space_name": "新用户账簿",
    }
    first = call(platform.a, "admin/users", body, key="create-once")
    second = call(platform.a, "admin/users", body, key="create-once")
    assert first.status_code == 200, first.content
    assert second.json() == first.json()
    assert User.objects.filter(username="managed-new").count() == 1
    assert first.json()["space_count"] == 1 and not first.json()["is_platform_admin"]
    assert body["password"] not in str(list(PlatformAudit.objects.values()))
    assert body["password"] not in str(list(PlatformCommand.objects.values()))
    assert (
        call(
            platform.a,
            "admin/users",
            {**body, "username": "another"},
            key="create-once",
        ).status_code
        == 409
    )


def test_admin_updates_disable_revokes_sessions_and_version(platform):
    p = platform
    path = f"admin/users/{p.ordinary.pk}"
    response = call(p.a, path, {"version": 0, "is_active": False}, "patch")
    assert response.status_code == 200, response.content
    assert p.u.get("/api/v1/auth/me").json()["user"] is None
    assert (
        call(p.a, path, {"version": 0, "is_active": True}, "patch").status_code == 412
    )
    assert (
        call(p.a, path, {"version": 1, "is_active": True}, "patch").status_code == 200
    )
    assert p.u.get("/api/v1/auth/me").json()["user"] is None


def test_password_reset_and_self_protection(platform):
    p = platform
    response = call(
        p.a,
        f"admin/users/{p.ordinary.pk}/password",
        {"version": 0, "password": "Example-reset-only-80447"},
    )
    assert response.status_code == 200, response.content
    p.ordinary.refresh_from_db()
    assert p.ordinary.check_password("Example-reset-only-80447")
    assert p.u.get("/api/v1/auth/me").json()["user"] is None
    assert (
        call(
            p.a,
            f"admin/users/{p.admin.pk}/password",
            {"version": 0, "password": "Example-reset-only-80447"},
        ).status_code
        == 422
    )
    assert (
        call(
            p.a,
            f"admin/users/{p.admin.pk}",
            {"version": 0, "is_active": False},
            "patch",
        ).status_code
        == 422
    )
    assert (
        call(
            p.a,
            f"admin/users/{p.admin.pk}",
            {"version": 0, "is_platform_admin": False},
            "patch",
        ).status_code
        == 422
    )


def test_admin_revocation_removes_foreign_access(platform):
    p = platform
    p.admin.is_superuser = p.admin.is_staff = False
    p.admin.save()
    assert p.a.get("/api/v1/admin/users").status_code == 403
    assert p.a.get(f"/api/v1/spaces/{p.foreign.pk}/accounts").status_code == 404


def test_space_management_and_add_members(platform):
    p = platform
    response = call(
        p.a,
        "admin/spaces",
        {"name": "协助建立", "owner_user_id": p.ordinary.pk, "base_currency": "USD"},
    )
    assert response.status_code == 200, response.content
    sid = response.json()["id"]
    consent = call(
        p.u,
        f"spaces/{sid}/admin-access",
        {"enabled": True, "version": 0},
        "put",
    )
    assert consent.status_code == 200, consent.content
    response = call(
        p.a, f"admin/spaces/{sid}", {"version": 0, "name": "重新命名"}, "patch"
    )
    assert response.status_code == 200, response.content
    assert response.json()["version"] == 1
    assert (
        call(
            p.a, f"admin/spaces/{sid}", {"version": 0, "name": "过期"}, "patch"
        ).status_code
        == 412
    )
    assert (
        call(
            p.a, f"spaces/{sid}/members", {"user_id": p.reader.pk, "role": "editor"}
        ).status_code
        == 200
    )
    assert (
        call(
            p.u, f"spaces/{sid}/members", {"user_id": p.admin.pk, "role": "owner"}
        ).status_code
        == 403
    )


def test_platform_audit_immutable(platform):
    obj = PlatformAudit.objects.create(
        actor=platform.admin, action="test", target="no-secrets"
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        PlatformAudit.objects.filter(pk=obj.pk).update(action="changed")


def test_anonymous_and_csrf_protections(platform):
    c = Client(enforce_csrf_checks=True)
    assert c.get("/api/v1/admin/users").status_code == 401
    c.force_login(platform.admin)
    assert call(c, "admin/users", {"username": "bad"}).status_code == 403


def test_sources_settings_authorization_validation_and_runtime_policy(platform):
    from wealth.provider_policy import get_provider_config

    p = platform
    response = p.a.get("/api/v1/admin/data-sources")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["version"] == 0 and body["providers"]
    body["config"]["enabled"]["yahoo"] = False
    updated = call(
        p.a, "admin/data-sources", {"version": 0, "config": body["config"]}, "put"
    )
    assert updated.status_code == 200, updated.content
    assert get_provider_config()["enabled"]["yahoo"] is False
    assert (
        call(
            p.a, "admin/data-sources", {"version": 0, "config": body["config"]}, "put"
        ).status_code
        == 412
    )
    assert (
        call(
            p.a,
            "admin/data-sources",
            {"version": 1, "config": {"url": "http://127.0.0.1/private"}},
            "put",
        ).status_code
        == 422
    )
    assert p.u.get("/api/v1/admin/data-sources").status_code == 403
    assert (
        call(
            p.u, "admin/data-sources", {"version": 1, "config": body["config"]}, "put"
        ).status_code
        == 403
    )
    assert (
        PlatformAudit.objects.filter(
            action="data_sources.updated", actor=p.admin
        ).count()
        == 1
    )


def test_stale_self_password_request_cannot_restore_revoked_role(platform):
    from django.test import RequestFactory
    from wealth.views import auth_route

    p = platform
    stale_user = User.objects.get(pk=p.admin.pk)
    User.objects.filter(pk=p.admin.pk).update(is_superuser=False, is_staff=False)
    request = RequestFactory().post("/api/v1/auth/password")
    request.user = stale_user
    request.session = p.a.session
    result = auth_route(
        request,
        "auth/password",
        {
            "current_password": "Example-safe-only-55731",
            "password": "Updated-self-only-99071",
        },
    )
    assert result["ok"]
    p.admin.refresh_from_db()
    assert not p.admin.is_superuser and not p.admin.is_staff
    assert p.admin.check_password("Updated-self-only-99071")


def test_stale_self_password_request_rechecks_disabled_user_and_latest_password(
    platform,
):
    from django.test import RequestFactory
    from wealth.views import auth_route
    from wealth.common import DomainError

    p = platform
    request = RequestFactory().post("/api/v1/auth/password")
    request.user = User.objects.get(pk=p.ordinary.pk)
    request.session = p.u.session
    User.objects.filter(pk=p.ordinary.pk).update(is_active=False)
    with pytest.raises(DomainError, match="停用"):
        auth_route(
            request,
            "auth/password",
            {
                "current_password": "Example-safe-only-55731",
                "password": "Updated-self-only-99071",
            },
        )
    p.ordinary.is_active = True
    p.ordinary.set_password("Reset-latest-only-99072")
    p.ordinary.save()
    with pytest.raises(DomainError, match="原密码"):
        auth_route(
            request,
            "auth/password",
            {
                "current_password": "Example-safe-only-55731",
                "password": "Updated-self-only-99071",
            },
        )
