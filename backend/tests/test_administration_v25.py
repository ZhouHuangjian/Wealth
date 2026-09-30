"""Independent operators, safe user erasure and narrowly scoped workspace purge."""

import json
import uuid
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.db import DatabaseError, connection, transaction
from django.test import Client
from wealth import models as m
from wealth.common import tenant_context
from wealth.ledger import post_event
from wealth.platform_admin import log_admin
from wealth.platform_cleanup import cleanup_workspace_files, retry_pending_file_cleanup
from wealth.platform_models import ConfigurationTemplate, PlatformAudit, PlatformSetting

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
def books():
    admin = User.objects.create_superuser(
        "operator-v25", password="Example-safe-only-55731"
    )
    owner = User.objects.create_user("owner-v25")
    other = User.objects.create_user("other-v25")
    space = m.Workspace.objects.create(name="可清理账簿")
    untouched = m.Workspace.objects.create(name="不可误删账簿")
    m.Membership.objects.create(workspace=space, user=owner, role="owner")
    m.Membership.objects.create(workspace=untouched, user=other, role="owner")
    events = {}
    accounts = {}
    for book, person in [(space, owner), (untouched, other)]:
        with tenant_context(book.pk):
            account = m.Account.objects.create(
                tenant=book, created_by=person, name="银行"
            )
            event = post_event(
                book,
                person,
                {
                    "kind": "opening",
                    "account_id": str(account.pk),
                    "amount": "100",
                    "economic_date": "2026-09-01",
                },
            )
            resource = m.Resource.objects.create(
                tenant=book, created_by=person, kind="notes", data={"title": "账务备注"}
            )
            m.ResourceRevision.objects.create(
                tenant=book, created_by=person, resource=resource, data=resource.data
            )
            events[book.pk], accounts[book.pk] = event, account
        book.refresh_from_db()
    clients = {}
    for key, person in [("admin", admin), ("owner", owner), ("other", other)]:
        clients[key] = Client()
        clients[key].force_login(person)
    return SimpleNamespace(
        admin=admin,
        owner=owner,
        other=other,
        space=space,
        untouched=untouched,
        clients=clients,
        events=events,
        accounts=accounts,
    )


def move_to_trash(p):
    response = call(
        p.clients["admin"],
        f"admin/spaces/{p.space.pk}",
        {"version": p.space.revision, "confirm_name": p.space.name},
        "delete",
    )
    assert response.status_code == 200, response.content
    p.space.refresh_from_db()
    return {"version": p.space.revision, "confirm_name": p.space.name}


def test_setup_creates_independent_administrator_without_personal_book():
    client = Client()
    response = call(
        client,
        "auth/setup",
        {
            "username": "first-platform-operator",
            "password": "Example-safe-only-55731",
            "space_name": "不得隐式创建",
        },
    )
    assert response.status_code == 200, response.content
    assert response.json()["user"]["is_platform_admin"] is True
    assert response.json()["spaces"] == []
    assert m.Workspace.objects.count() == m.Membership.objects.count() == 0


def test_administrator_has_only_explicit_managed_space_access(books):
    p = books
    assert p.clients["admin"].get("/api/v1/auth/me").json()["spaces"] == []
    assert (
        call(p.clients["admin"], "spaces", {"name": "管理员个人空间"}).status_code
        == 403
    )
    assert (
        call(
            p.clients["admin"],
            "admin/spaces",
            {"name": "越界", "owner_user_id": p.admin.pk},
        ).status_code
        == 422
    )
    assert (
        call(
            p.clients["admin"],
            f"spaces/{p.space.pk}/members",
            {"user_id": p.admin.pk, "role": "owner"},
        ).status_code
        == 422
    )
    response = p.clients["admin"].get(f"/api/v1/admin/spaces/{p.space.pk}")
    assert response.status_code == 200
    assert response.json()["administration"] is True
    assert response.json()["membership_role"] is None
    assert (
        p.clients["owner"].get(f"/api/v1/admin/spaces/{p.space.pk}").status_code == 403
    )
    assert not m.Membership.objects.filter(user=p.admin).exists()


def test_admin_invite_accept_is_rejected_without_consuming_invitation(books):
    p = books
    response = call(p.clients["owner"], f"spaces/{p.space.pk}/invitations", {})
    assert response.status_code == 200, response.content
    token = response.json()["token"]
    assert (
        call(p.clients["admin"], "invitations/accept", {"token": token}).status_code
        == 403
    )
    with tenant_context(p.space.pk):
        assert m.Invitation.objects.get(tenant=p.space).used_at is None


def test_admin_creation_type_is_explicit_and_immutable(books):
    p = books
    body = {
        "username": "another-operator",
        "password": "Example-safe-only-55731",
        "is_platform_admin": True,
    }
    assert (
        call(
            p.clients["admin"], "admin/users", {**body, "space_name": "无效"}
        ).status_code
        == 422
    )
    response = call(p.clients["admin"], "admin/users", body)
    assert response.status_code == 200, response.content
    assert (
        response.json()["is_platform_admin"] is True
        and response.json()["space_count"] == 0
    )
    assert (
        call(
            p.clients["admin"],
            f"admin/users/{p.owner.pk}",
            {"version": 0, "is_platform_admin": True},
            "patch",
        ).status_code
        == 422
    )


def test_delete_user_requires_confirmation_version_and_ownership_transfer(books):
    p = books
    path = f"admin/users/{p.owner.pk}"
    assert call(p.clients["owner"], path, {}, "delete").status_code == 403
    assert (
        call(
            p.clients["admin"], path, {"confirm_username": p.owner.username}, "delete"
        ).status_code
        == 428
    )
    assert (
        call(
            p.clients["admin"],
            path,
            {"version": 0, "confirm_username": "wrong"},
            "delete",
        ).status_code
        == 422
    )
    response = call(
        p.clients["admin"],
        path,
        {"version": 0, "confirm_username": p.owner.username},
        "delete",
    )
    assert response.status_code == 422
    assert response.json()["fields"]["space_ids"] == [str(p.space.pk)]
    assert User.objects.filter(pk=p.owner.pk).exists()


def test_delete_user_preserves_shared_facts_revokes_sessions_and_is_idempotent(books):
    p = books
    m.Membership.objects.create(workspace=p.space, user=p.other, role="owner")
    body = {"version": 0, "confirm_username": p.owner.username}
    path = f"admin/users/{p.owner.pk}"
    response = call(p.clients["admin"], path, body, "delete", "erase-owner-once")
    assert response.status_code == 200, response.content
    assert (
        call(p.clients["admin"], path, body, "delete", "erase-owner-once").json()
        == response.json()
    )
    assert not User.objects.filter(pk=p.owner.pk).exists()
    assert p.clients["owner"].get("/api/v1/auth/me").json()["user"] is None
    assert m.Workspace.objects.count() == 2
    assert m.Membership.objects.filter(workspace=p.space, user=p.other).exists()
    with tenant_context(p.space.pk):
        event = m.Event.objects.get(pk=p.events[p.space.pk].pk)
        assert event.created_by_id is None
        assert m.JournalLine.objects.filter(event=event).count() == 2
        assert m.ResourceRevision.objects.get(tenant=p.space).created_by_id is None
        with pytest.raises(DatabaseError), transaction.atomic():
            m.Event.objects.filter(pk=event.pk).update(description="cannot edit facts")
    assert PlatformAudit.objects.filter(
        action="user.deleted", target=str(p.owner.pk)
    ).exists()
    assert m.Event.objects.count() == 0


def test_delete_user_with_only_recycled_space_does_not_delete_space(books):
    p = books
    move_to_trash(p)
    response = call(
        p.clients["admin"],
        f"admin/users/{p.owner.pk}",
        {"version": 0, "confirm_username": p.owner.username},
        "delete",
    )
    assert response.status_code == 200, response.content
    assert m.Workspace.objects.filter(pk=p.space.pk, deleted_at__isnull=False).exists()


def test_delete_other_admin_preserves_attributed_platform_audit(books):
    p = books
    second = User.objects.create_superuser(
        "former-operator", password="Example-safe-only-55731"
    )
    audit = log_admin(second, "test.audit", "retained")
    response = call(
        p.clients["admin"],
        f"admin/users/{second.pk}",
        {"version": 0, "confirm_username": second.username},
        "delete",
    )
    assert response.status_code == 200, response.content
    audit.refresh_from_db()
    assert audit.actor_id is None and audit.actor_reference == second.pk
    assert audit.actor_label == second.username
    assert (
        call(
            p.clients["admin"],
            f"admin/users/{p.admin.pk}",
            {"version": 0, "confirm_username": p.admin.username},
            "delete",
        ).status_code
        == 422
    )


def test_purge_requires_trash_confirmation_and_current_version(books):
    p = books
    path = f"admin/spaces/{p.space.pk}/purge"
    body = {"version": p.space.revision, "confirm_name": p.space.name}
    assert call(p.clients["admin"], path, body, "delete").status_code == 422
    body = move_to_trash(p)
    assert call(p.clients["owner"], path, body, "delete").status_code == 403
    assert (
        call(
            p.clients["admin"], path, {**body, "confirm_name": "wrong"}, "delete"
        ).status_code
        == 422
    )
    assert (
        call(p.clients["admin"], path, {**body, "version": 0}, "delete").status_code
        == 412
    )


def test_purge_removes_one_tenant_files_and_references_preserves_other(
    books, settings, django_capture_on_commit_callbacks
):
    p = books
    template = ConfigurationTemplate.objects.create(
        title="仅配置参考",
        data={},
        source_workspace=p.space,
        source_user=p.owner,
        created_by=p.admin,
    )
    directory = settings.PRIVATE_MEDIA_ROOT / str(p.space.pk)
    directory.mkdir(parents=True)
    (directory / "example.attachment").write_text("private")
    other_directory = settings.PRIVATE_MEDIA_ROOT / str(p.untouched.pk)
    other_directory.mkdir()
    (other_directory / "keep.attachment").write_text("keep")
    body = move_to_trash(p)
    path = f"admin/spaces/{p.space.pk}/purge"
    with django_capture_on_commit_callbacks(execute=True):
        response = call(p.clients["admin"], path, body, "delete", "purge-one")
    assert response.status_code == 200, response.content
    assert (
        call(p.clients["admin"], path, body, "delete", "purge-one").json()
        == response.json()
    )
    assert not m.Workspace.objects.filter(pk=p.space.pk).exists()
    assert not directory.exists() and (other_directory / "keep.attachment").exists()
    template.refresh_from_db()
    assert template.source_workspace_id is None
    with tenant_context(p.space.pk):
        for model in [m.Account, m.Event, m.JournalLine, m.Audit, m.ResourceRevision]:
            assert model.objects.count() == 0
    with tenant_context(p.untouched.pk):
        assert m.Event.objects.filter(pk=p.events[p.untouched.pk].pk).exists()
    assert PlatformAudit.objects.filter(
        action="space.purged", target=str(p.space.pk)
    ).exists()


def test_immutable_and_rls_cannot_be_bypassed_with_context_flags_or_private_scope(
    books,
):
    p = books
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"
        )
        assert cursor.fetchone() == (False, False)
        with pytest.raises(DatabaseError), transaction.atomic():
            cursor.execute(
                "INSERT INTO public.wealth_cleanup_scope VALUES(pg_backend_pid(),txid_current(),%s,NULL)",
                [str(p.space.pk)],
            )
    with tenant_context(p.space.pk):
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_config('app.cleanup_allowed','true',true)")
        with pytest.raises(DatabaseError), transaction.atomic():
            m.JournalLine.objects.filter(tenant=p.space).delete()
    assert m.Event.objects.count() == 0


def test_cleanup_function_enforces_actor_and_trash_even_when_called_directly(books):
    p = books
    for operator, version, name in [
        (p.owner.pk, p.space.revision, p.space.name),
        (p.admin.pk, p.space.revision, p.space.name),
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT public.wealth_purge_workspace(%s,%s,%s,%s)",
                    [operator, str(p.space.pk), version, name],
                )
    assert m.Workspace.objects.filter(pk=p.space.pk).exists()


def test_file_cleanup_does_not_follow_symlink(books, settings, tmp_path):
    p = books
    body = move_to_trash(p)
    response = call(
        p.clients["admin"], f"admin/spaces/{p.space.pk}/purge", body, "delete"
    )
    assert response.status_code == 200, response.content
    external = tmp_path / "unrelated"
    external.mkdir()
    (external / "keep").write_text("safe")
    settings.PRIVATE_MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    (settings.PRIVATE_MEDIA_ROOT / str(p.space.pk)).symlink_to(
        external, target_is_directory=True
    )
    assert cleanup_workspace_files(p.space.pk) is True
    assert (external / "keep").read_text() == "safe"


def test_cleanup_functions_ignore_forged_temp_tables_and_tenant_flags(books):
    p = books
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT has_database_privilege(current_user,current_database(),'TEMP')"
        )
        can_create_temp = cursor.fetchone()[0]
        create_fake_user = "CREATE TEMP TABLE auth_user (id bigint,is_active boolean,is_superuser boolean)"
        if can_create_temp:
            cursor.execute(create_fake_user)
            cursor.execute(
                "INSERT INTO pg_temp.auth_user VALUES (%s,true,true)", [p.owner.pk]
            )
            cursor.execute(
                "CREATE TEMP TABLE wealth_cleanup_scope (backend_pid integer,transaction_id bigint,workspace_id uuid,target_user_id bigint)"
            )
            cursor.execute(
                "INSERT INTO pg_temp.wealth_cleanup_scope VALUES (pg_backend_pid(),txid_current(),%s,%s)",
                [str(p.space.pk), p.owner.pk],
            )
        else:
            with pytest.raises(DatabaseError), transaction.atomic():
                cursor.execute(create_fake_user)
        cursor.execute(
            "SELECT proconfig,pg_get_functiondef(oid) FROM pg_proc WHERE proname IN ('wealth_purge_workspace','wealth_delete_platform_user','wealth_cleanup_permitted')"
        )
        definitions = cursor.fetchall()
        assert len(definitions) == 3
        for config, definition in definitions:
            assert "search_path=pg_catalog, public" in config
            assert "public.wealth_cleanup_scope" in definition
        cursor.execute("SET LOCAL search_path=pg_temp,public,pg_catalog")
        for query, params in [
            (
                "SELECT public.wealth_purge_workspace(%s,%s,%s,%s)",
                [p.owner.pk, str(p.space.pk), p.space.revision, p.space.name],
            ),
            (
                "SELECT public.wealth_delete_platform_user(%s,%s,%s,%s)",
                [p.owner.pk, p.other.pk, 0, p.other.username],
            ),
        ]:
            with pytest.raises(DatabaseError), transaction.atomic():
                cursor.execute(query, params)
        cursor.execute(
            "SELECT public.wealth_cleanup_permitted(%s,%s)",
            [str(p.space.pk), p.owner.pk],
        )
        assert cursor.fetchone() == (False,)
        if can_create_temp:
            cursor.execute("DROP TABLE pg_temp.auth_user, pg_temp.wealth_cleanup_scope")
        cursor.execute("SET LOCAL search_path=public")
    with tenant_context(p.space.pk), pytest.raises(DatabaseError), transaction.atomic():
        m.JournalLine.objects.filter(tenant=p.space).delete()
    assert User.objects.filter(pk=p.other.pk).exists()


def test_failed_file_deletion_is_durable_and_retried(books, settings, monkeypatch):
    p = books
    body = move_to_trash(p)
    response = call(
        p.clients["admin"], f"admin/spaces/{p.space.pk}/purge", body, "delete"
    )
    assert response.status_code == 200, response.content
    directory = settings.PRIVATE_MEDIA_ROOT / str(p.space.pk)
    directory.mkdir(parents=True)
    import wealth.platform_cleanup as cleanup

    original = cleanup.shutil.rmtree
    monkeypatch.setattr(
        cleanup.shutil, "rmtree", lambda _: (_ for _ in ()).throw(OSError("busy"))
    )
    assert cleanup_workspace_files(p.space.pk) is False
    assert (
        PlatformSetting.objects.get(
            pk=cleanup.FILE_CLEANUP_PREFIX + str(p.space.pk)
        ).data["status"]
        == "pending"
    )
    monkeypatch.setattr(cleanup.shutil, "rmtree", original)
    assert retry_pending_file_cleanup()["completed"] == 1
    assert not directory.exists()
