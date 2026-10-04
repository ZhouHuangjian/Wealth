"""Recoverable space management and explicitly published configuration sharing."""

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client, RequestFactory
from django.utils import timezone

from wealth import models as m
from wealth.common import tenant_context
from wealth.insights import save_configuration
from wealth.ledger import post_event
from wealth.platform_models import (
    ConfigurationTemplate,
    NavigationPreference,
    PlatformAudit,
)
from wealth.reporting import overview
from wealth.views import api

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
def books(settings):
    settings.WEALTH_MARKET_DATA_ENABLED = False
    users = {
        key: User.objects.create_user(
            "manage-v24-" + key, is_superuser=key == "admin", is_staff=key == "admin"
        )
        for key in ["owner", "editor", "viewer", "outsider", "admin"]
    }
    clients = {}
    for key, user in users.items():
        clients[key] = Client()
        clients[key].force_login(user)
    source = m.Workspace.objects.create(name="管理验收来源", admin_access_enabled=True)
    target = m.Workspace.objects.create(name="管理验收目标")
    for key in ["owner", "editor", "viewer"]:
        m.Membership.objects.create(workspace=source, user=users[key], role=key)
    m.Membership.objects.create(workspace=target, user=users["outsider"], role="owner")
    NavigationPreference.objects.create(
        user=users["owner"],
        groups={
            "main": {"order": ["analytics", "home"], "hidden": ["notebook"]},
            "admin": {"order": ["users"], "hidden": []},
        },
    )
    m.MarketSymbol.objects.create(
        code="TESTV24",
        name="公开验收指数",
        kind="index",
        market="US",
        currency="USD",
        search_text="TESTV24",
        specification={"is_index": True, "quote_unit": "points"},
        source="synthetic-public-catalog",
        refreshed_at=timezone.now(),
    )
    with tenant_context(source.pk):
        account = m.Account.objects.create(tenant=source, name="PRIVATE-BANK-NAME-8842")
        event = post_event(
            source,
            users["owner"],
            {
                "kind": "opening",
                "account_id": str(account.pk),
                "amount": "23456.78",
                "economic_date": "2026-09-01",
            },
        )
        inst = m.Instrument.objects.create(
            tenant=source,
            code="TESTV24",
            name="PRIVATE-PRODUCT-LABEL",
            kind="index",
            market="US",
            currency="USD",
            specification={
                "account_ids": [str(account.pk)],
                "personal_note": "PRIVATE-STRATEGY-DETAIL",
            },
        )
        m.Resource.objects.create(
            tenant=source,
            kind="notes",
            data={"title": "PRIVATE-NOTE-TITLE", "content": "PRIVATE-NOTE-CONTENT"},
        )
        save_configuration(
            source,
            users["owner"],
            "investment_tags",
            {
                "name": "长期权益",
                "color": "#345678",
                "target_weight": "60",
                "instrument_ids": [str(inst.pk)],
            },
        )
        save_configuration(
            source,
            users["owner"],
            "investment_tags",
            {"name": "黄金", "color": "#998800", "target_weight": "40"},
        )
        save_configuration(
            source,
            users["owner"],
            "dashboard_preferences",
            {
                "show_market_environment": False,
                "show_valuation": True,
                "show_signals": False,
            },
        )
        save_configuration(
            source,
            users["owner"],
            "market_watchlist",
            {
                "instrument_id": str(inst.pk),
                "show_on_home": False,
                "lookback_days": 100,
            },
        )
    with tenant_context(target.pk):
        target_account = m.Account.objects.create(tenant=target, name="目标自己的银行")
        post_event(
            target,
            users["outsider"],
            {
                "kind": "opening",
                "account_id": str(target_account.pk),
                "amount": "50",
                "economic_date": "2026-09-01",
            },
        )
    return SimpleNamespace(
        users=users,
        clients=clients,
        source=source,
        target=target,
        account=account,
        event=event,
        inst=inst,
        target_account=target_account,
    )


def preview(p, client=None):
    return (client or p.clients["admin"]).get(
        "/api/v1/admin/configuration-templates/preview",
        {"user_id": p.users["owner"].pk, "space_id": str(p.source.pk)},
    )


def publish(p, body=None, key=None):
    snap = preview(p)
    assert snap.status_code == 200, snap.content
    return call(
        p.clients["admin"],
        "admin/configuration-templates",
        {
            "source_user_id": p.users["owner"].pk,
            "source_space_id": str(p.source.pk),
            "title": "共享配置示例",
            "description": "仅作为界面配置参考",
            "preview_digest": snap.json()["preview_digest"],
            **(body or {}),
        },
        key=key,
    )


def apply(p, template, *, sections=None, body=None, client=None, space=None, key=None):
    target = space or p.target
    target.refresh_from_db()
    nav = NavigationPreference.objects.filter(user=p.users["outsider"]).first()
    return call(
        client or p.clients["outsider"],
        f"spaces/{target.pk}/configuration-templates/{template['id']}/apply",
        {
            "version": template["version"],
            "space_revision": target.revision,
            "navigation_version": nav.version if nav else 0,
            "sections": sections or ["navigation", "dashboard", "tags", "watchlist"],
            **(body or {}),
        },
        key=key,
    )


@pytest.mark.parametrize(
    "actor,allowed",
    [
        ("owner", True),
        ("admin", True),
        ("editor", False),
        ("viewer", False),
        ("outsider", False),
    ],
)
def test_delete_and_restore_authority_preserves_financial_facts(books, actor, allowed):
    p = books
    p.source.refresh_from_db()
    response = call(
        p.clients[actor],
        f"spaces/{p.source.pk}",
        {"version": p.source.revision, "confirm_name": p.source.name},
        "delete",
    )
    assert response.status_code == (200 if allowed else 404), response.content
    if allowed:
        assert response.json()["recoverable"] is True
        restored = call(
            p.clients[actor],
            f"spaces/{p.source.pk}/restore",
            {"version": response.json()["version"]},
        )
        assert restored.status_code == 200, restored.content
    else:
        p.source.deleted_at = timezone.now()
        p.source.save(update_fields=["deleted_at"])
        denied = call(
            p.clients[actor],
            f"spaces/{p.source.pk}/restore",
            {"version": p.source.revision},
        )
        assert denied.status_code == 404
    with tenant_context(p.source.pk):
        assert m.Event.objects.get(pk=p.event.pk).payload["amount"] == "23456.78"
        assert m.Account.objects.get(pk=p.account.pk).name == "PRIVATE-BANK-NAME-8842"
        assert Decimal(overview(p.source, "2026-09-01")["net_assets"]) == Decimal(
            "23456.78"
        )
    if actor == "admin":
        assert PlatformAudit.objects.filter(
            actor=p.users["admin"], action="space.deleted", target=str(p.source.pk)
        ).exists()
        assert not m.Membership.objects.filter(
            user=p.users["admin"], workspace=p.source
        ).exists()


def test_delete_requires_name_version_and_idempotent_retry(books):
    p = books
    p.source.refresh_from_db()
    route = f"spaces/{p.source.pk}"
    valid = {"version": p.source.revision, "confirm_name": p.source.name}
    assert (
        call(
            p.clients["owner"], route, {"confirm_name": p.source.name}, "delete"
        ).status_code
        == 428
    )
    assert (
        call(p.clients["owner"], route, {**valid, "version": -1}, "delete").status_code
        == 412
    )
    assert (
        call(
            p.clients["owner"], route, {**valid, "confirm_name": "错误名称"}, "delete"
        ).status_code
        == 422
    )
    first = call(p.clients["owner"], route, valid, "delete", key="delete-once")
    assert first.status_code == 200
    assert (
        call(p.clients["owner"], route, valid, "delete", key="delete-once").json()
        == first.json()
    )
    assert (
        call(
            p.clients["owner"],
            route,
            {**valid, "confirm_name": "different"},
            "delete",
            key="delete-once",
        ).status_code
        == 409
    )
    assert (
        call(
            p.clients["owner"], route + "/restore", {"version": valid["version"]}
        ).status_code
        == 412
    )
    body = {"version": first.json()["version"]}
    restored = call(p.clients["owner"], route + "/restore", body, key="restore-once")
    assert restored.status_code == 200
    assert (
        call(p.clients["owner"], route + "/restore", body, key="restore-once").json()
        == restored.json()
    )


def test_deleted_space_disappears_and_old_invitation_stays_revoked_after_restore(books):
    p = books
    invitation = call(
        p.clients["owner"], f"spaces/{p.source.pk}/invitations", {"role": "viewer"}
    ).json()
    p.source.refresh_from_db()
    deleted = call(
        p.clients["owner"],
        f"spaces/{p.source.pk}",
        {"version": p.source.revision, "confirm_name": p.source.name},
        "delete",
    )
    assert deleted.status_code == 200
    for actor in ["owner", "editor", "viewer", "admin"]:
        auth = p.clients[actor].get("/api/v1/auth/me").json()
        assert str(p.source.pk) not in {row["id"] for row in auth["spaces"]}
        assert (
            p.clients[actor].get(f"/api/v1/spaces/{p.source.pk}/accounts").status_code
            == 404
        )
    for actor, visible in [
        ("owner", True),
        ("admin", True),
        ("editor", False),
        ("outsider", False),
    ]:
        trash = p.clients[actor].get("/api/v1/spaces/trash").json()["items"]
        assert (str(p.source.pk) in {row["id"] for row in trash}) is visible
    assert (
        call(
            Client(), "invitations/preview", {"token": invitation["token"]}
        ).status_code
        == 422
    )
    restored = call(
        p.clients["owner"],
        f"spaces/{p.source.pk}/restore",
        {"version": deleted.json()["version"]},
    )
    assert restored.status_code == 200
    assert (
        call(
            Client(), "invitations/preview", {"token": invitation["token"]}
        ).status_code
        == 422
    )
    with tenant_context(p.source.pk):
        assert m.Invitation.objects.get(pk=invitation["id"]).revoked is True


def test_new_space_can_issue_invitation_consumed_once_during_signup(books):
    p = books
    created = call(
        p.clients["owner"],
        "spaces",
        {"name": "可邀请的新空间", "create_invitation": True},
    )
    assert created.status_code == 201, created.content
    space = created.json()
    token = space["invitation"]["token"]
    assert space["invitation"]["role"] == "viewer"
    previewed = call(Client(), "invitations/preview", {"token": token})
    assert previewed.status_code == 200
    joined = call(
        Client(),
        "auth/join",
        {
            "token": token,
            "username": "invite-new-v24",
            "password": "Synthetic-join-only-82914",
        },
    )
    assert joined.status_code == 200, joined.content
    assert joined.json()["spaces"][0]["id"] == space["id"]
    assert joined.json()["spaces"][0]["role"] == "viewer"
    reused = call(
        Client(),
        "auth/join",
        {
            "token": token,
            "username": "invite-reused-v24",
            "password": "Synthetic-join-only-82914",
        },
    )
    assert reused.status_code == 422
    assert not User.objects.filter(username="invite-reused-v24").exists()


@pytest.mark.parametrize("route", ["spaces", "invitations/accept"])
def test_already_loaded_user_cannot_create_or_join_after_deactivation(books, route):
    p = books
    token = call(p.clients["owner"], f"spaces/{p.source.pk}/invitations", {}).json()[
        "token"
    ]
    stale = User.objects.get(pk=p.users["outsider"].pk)
    User.objects.filter(pk=stale.pk).update(is_active=False)
    request = RequestFactory().post(
        "/api/v1/" + route,
        data=json.dumps(
            {"name": "must-not-create", "token": token, "create_invitation": True}
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    request.user = stale
    request.session = {}
    response = api(request, route)
    assert response.status_code == 403, response.content
    assert not m.Workspace.objects.filter(name="must-not-create").exists()
    assert not m.Membership.objects.filter(workspace=p.source, user=stale).exists()


def test_template_admin_authority_preview_digest_and_safe_public_output(books):
    p = books
    assert preview(p, p.clients["owner"]).status_code == 403
    assert (
        call(p.clients["owner"], "admin/configuration-templates", {}).status_code == 403
    )
    assert publish(p, {"preview_digest": "stale-digest"}).status_code == 412
    assert ConfigurationTemplate.objects.count() == 0
    first = publish(p, key="publish-once")
    assert first.status_code == 200, first.content
    assert publish(p, key="publish-once").json() == first.json()
    assert ConfigurationTemplate.objects.count() == 1
    visible = (
        p.clients["outsider"].get("/api/v1/configuration-templates").json()["items"][0]
    )
    assert not {"source_user_id", "source_space_id", "created_by_id"} & visible.keys()
    assert "admin" not in visible["data"]["navigation"]
    encoded = json.dumps(visible, ensure_ascii=False)
    for secret in [
        "PRIVATE-BANK-NAME-8842",
        "PRIVATE-PRODUCT-LABEL",
        "PRIVATE-STRATEGY-DETAIL",
        "PRIVATE-NOTE",
        "23456.78",
        str(p.source.pk),
        str(p.account.pk),
        str(p.event.pk),
        str(p.inst.pk),
    ]:
        assert secret not in encoded
    assert visible["data"]["watchlist"][0]["product"]["name"] == "公开验收指数"


def test_changed_source_configuration_invalidates_publish_preview(books):
    p = books
    digest = preview(p).json()["preview_digest"]
    nav = NavigationPreference.objects.get(user=p.users["owner"])
    nav.groups = {"main": {"order": ["home"], "hidden": []}}
    nav.version += 1
    nav.save()
    response = publish(p, {"preview_digest": digest})
    assert response.status_code == 412
    assert ConfigurationTemplate.objects.count() == 0


def test_uncached_private_product_identity_is_not_published(books):
    p = books
    with tenant_context(p.source.pk):
        inst = m.Instrument.objects.create(
            tenant=p.source,
            code="PRIVATE-CUSTOM-CODE",
            name="私人投资计划",
            kind="fund",
        )
        m.Resource.objects.create(
            tenant=p.source,
            kind="market_watchlist",
            data={"instrument_id": str(inst.pk), "enabled": True},
        )
    response = preview(p)
    assert response.status_code == 200
    assert "PRIVATE-CUSTOM-CODE" not in json.dumps(response.json())


def test_template_visibility_and_versions_are_enforced(books):
    p = books
    template = publish(p).json()
    route = f"admin/configuration-templates/{template['id']}"
    assert (
        call(
            p.clients["admin"], route, {"version": 0, "published": False}, "patch"
        ).status_code
        == 412
    )
    changed = call(
        p.clients["admin"],
        route,
        {"version": template["version"], "published": False},
        "patch",
    )
    assert changed.status_code == 200
    assert (
        p.clients["outsider"].get("/api/v1/configuration-templates").json()["items"]
        == []
    )
    assert apply(p, template).status_code == 404
    public = call(
        p.clients["admin"],
        route,
        {"version": changed.json()["version"], "published": True},
        "patch",
    )
    assert public.status_code == 200
    assert apply(p, template).status_code == 412


def test_apply_changes_selected_configuration_without_copying_financial_facts(books):
    p = books
    template = publish(p).json()
    p.target.refresh_from_db()
    initial_revision = p.target.revision
    response = apply(p, template, key="adopt-once")
    assert response.status_code == 200, response.content
    retry = apply(
        p,
        template,
        key="adopt-once",
        body={"space_revision": initial_revision, "navigation_version": 0},
    )
    assert retry.status_code == 200 and retry.json() == response.json()
    assert (
        response.json()["tags_added"] == 2 and response.json()["watchlist_added"] == 1
    )
    with tenant_context(p.target.pk):
        assert m.Account.objects.filter(tenant=p.target).count() == 1
        assert m.Event.objects.filter(tenant=p.target).count() == 1
        assert m.PositionMovement.objects.filter(tenant=p.target).count() == 0
        assert not m.Resource.objects.filter(tenant=p.target, kind="notes").exists()
        assert Decimal(overview(p.target, "2026-09-01")["net_assets"]) == 50
        copied = m.Instrument.objects.get(tenant=p.target, code="TESTV24")
        assert copied.pk != p.inst.pk
        assert "account_ids" not in copied.specification
        assert (
            m.Resource.objects.get(tenant=p.target, kind="dashboard_preferences").data[
                "show_market_environment"
            ]
            is False
        )
    nav = NavigationPreference.objects.get(user=p.users["outsider"])
    assert nav.groups["main"]["hidden"] == ["notebook"]
    assert "admin" not in nav.groups


def test_same_named_tags_and_existing_watch_entries_keep_recipient_settings(books):
    p = books
    with tenant_context(p.target.pk):
        existing_tag = save_configuration(
            p.target,
            p.users["outsider"],
            "investment_tags",
            {"name": "长期权益", "color": "#112233", "target_weight": "15"},
        )
        own_inst = m.Instrument.objects.create(
            tenant=p.target,
            code="TESTV24",
            name="我自己的标注",
            kind="index",
            market="US",
            currency="USD",
        )
        existing_watch = save_configuration(
            p.target,
            p.users["outsider"],
            "market_watchlist",
            {
                "instrument_id": str(own_inst.pk),
                "show_on_home": True,
                "lookback_days": 300,
            },
        )
    result = apply(p, publish(p).json(), sections=["tags", "watchlist"])
    assert result.status_code == 200, result.content
    assert (
        result.json()["tags_skipped"] == 1 and result.json()["watchlist_skipped"] == 1
    )
    with tenant_context(p.target.pk):
        tag = m.Resource.objects.get(pk=existing_tag["id"])
        watch = m.Resource.objects.get(pk=existing_watch["id"])
        own_inst.refresh_from_db()
        assert tag.data["target_weight"] == "15" and tag.data["color"] == "#112233"
        assert watch.data["show_on_home"] is True and watch.data["lookback_days"] == 300
        assert own_inst.name == "我自己的标注"


def test_allocation_conflict_rolls_back_navigation_dashboard_and_partial_tags(books):
    p = books
    with tenant_context(p.target.pk):
        save_configuration(
            p.target,
            p.users["outsider"],
            "investment_tags",
            {"name": "已有组合", "target_weight": "10"},
        )
    p.target.refresh_from_db()
    before = p.target.revision
    result = apply(p, publish(p).json())
    assert result.status_code == 422, result.content
    p.target.refresh_from_db()
    assert p.target.revision == before
    assert not NavigationPreference.objects.filter(user=p.users["outsider"]).exists()
    with tenant_context(p.target.pk):
        assert not m.Resource.objects.filter(
            tenant=p.target, kind="dashboard_preferences"
        ).exists()
        assert (
            m.Resource.objects.filter(tenant=p.target, kind="investment_tags").count()
            == 1
        )
        assert not m.Resource.objects.filter(
            tenant=p.target, kind="market_watchlist"
        ).exists()


@pytest.mark.parametrize("actor", ["viewer", "editor"])
def test_non_owner_cannot_apply_shared_book_configuration(books, actor):
    p = books
    result = apply(
        p, publish(p).json(), client=p.clients[actor], space=p.source, sections=["tags"]
    )
    assert result.status_code == 403, result.content


def test_template_apply_rejects_stale_space_or_navigation(books):
    p = books
    template = publish(p).json()
    assert apply(p, template, body={"space_revision": -1}).status_code == 412
    assert apply(p, template, body={"navigation_version": -1}).status_code == 412
