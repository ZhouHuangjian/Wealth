import hashlib
import json
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from wealth.chat_models import ChatAccess, ChatDevice, ChatDraftBatch
from wealth.platform_models import PlatformAudit

pytestmark = pytest.mark.django_db
User = get_user_model()


def call(client, path, body=None, method="post", **headers):
    headers.setdefault(
        "HTTP_X_CHAT_USER_ID", str(client.session.get("_auth_user_id", ""))
    )
    return getattr(client, method)(
        "/api/v1/" + path,
        data=json.dumps(body or {}),
        content_type="application/json",
        **headers,
    )


@pytest.fixture
def actors():
    admin = User.objects.create_superuser(
        "chat-admin", password="Example-chat-test-99001"
    )
    first = User.objects.create_user("chat-first", password="Example-chat-test-99001")
    second = User.objects.create_user("chat-second", password="Example-chat-test-99001")
    clients = [Client(), Client(), Client()]
    for user, client in zip((admin, first, second), clients):
        client.force_login(user)
    return SimpleNamespace(
        admin=admin,
        first=first,
        second=second,
        a=clients[0],
        f=clients[1],
        s=clients[2],
    )


def enable(actors, user):
    response = call(actors.a, f"admin/chat/users/{user.pk}", {"enabled": True}, "patch")
    assert response.status_code == 200, response.content
    assert response.json()["user_id"] == actors.admin.pk


def device(actors, user, client, name="测试 Mac"):
    enable(actors, user)
    response = call(client, "chat/devices", {"name": name})
    assert response.status_code == 200, response.content
    return response.json()


def packet(batch_id="batch_1"):
    return {
        "id": batch_id,
        "conversationKey": "local_conversation_1",
        "conversationName": "测试会话",
        "basedOnMessageId": "local_message_1",
        "createdAt": "2026-10-11T04:00:00.123Z",
        "provider": "codex",
        "profileVersion": "v1.8",
        "drafts": [
            {"text": "测试私有草稿内容", "label": "自然", "reason": "仅合成测试内容"}
        ],
    }


def upload(token, body=None, client=None, key=None):
    body = packet() if body is None else body
    return call(
        client or Client(enforce_csrf_checks=True),
        "chat/ingest",
        body,
        HTTP_AUTHORIZATION="Bearer " + token,
        HTTP_IDEMPOTENCY_KEY=body.get("id", "") if key is None else key,
    )


def test_default_off_admin_cannot_bypass_and_grants_are_explicit(actors):
    p = actors
    assert p.a.get("/api/v1/chat/me").json() == {
        "enabled": False,
        "is_admin": True,
        "user_id": p.admin.pk,
    }
    assert p.f.get("/api/v1/chat/me").json() == {
        "enabled": False,
        "is_admin": False,
        "user_id": p.first.pk,
    }
    for client in (p.a, p.f):
        assert client.get("/api/v1/chat/drafts").status_code == 403
        assert call(client, "chat/devices", {"name": "Mac"}).status_code == 403
    assert p.f.get("/api/v1/admin/chat/users").status_code == 403
    assert (
        call(
            p.f, f"admin/chat/users/{p.first.pk}", {"enabled": True}, "patch"
        ).status_code
        == 403
    )
    enable(p, p.admin)
    assert p.a.get("/api/v1/chat/me").json()["enabled"] is True
    assert p.a.get("/api/v1/chat/drafts").json()["items"] == []
    assert Client().get("/api/v1/chat/me").status_code == 401
    assert Client().get("/api/v1/chat/devices").status_code == 401


def test_token_is_one_time_hash_only_and_limited_to_upload(actors):
    info = device(actors, actors.first, actors.f)
    token = info["token"]
    assert info["user_id"] == actors.first.pk
    row = ChatDevice.objects.get(pk=info["device"]["id"])
    assert (
        len(token) >= 32
        and row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    )
    assert info["upload_path"] == "/api/v1/chat/ingest"
    listing = actors.f.get("/api/v1/chat/devices")
    assert "token" not in listing.content.decode()
    assert listing["Cache-Control"] == "no-store"
    assert listing.json()["user_id"] == actors.first.pk
    assert "token_hash" not in info["device"]
    bare = Client()
    for path in ("chat/devices", "chat/drafts", "admin/chat/users"):
        assert (
            bare.get(
                "/api/v1/" + path, HTTP_AUTHORIZATION="Bearer " + token
            ).status_code
            == 401
        )
    assert (
        call(
            actors.f, "chat/ingest", packet(), HTTP_IDEMPOTENCY_KEY="batch_1"
        ).status_code
        == 401
    )
    assert (
        upload(token).status_code == 200
    )  # no session or CSRF required for token ingress


def test_user_isolation_admin_not_allowed_to_view_or_delete_others(actors):
    p = actors
    first = device(p, p.first, p.f)
    second = device(p, p.second, p.s)
    enable(p, p.admin)
    assert upload(first["token"]).status_code == 200
    assert upload(second["token"]).status_code == 200
    inbox = p.f.get("/api/v1/chat/drafts").json()
    assert inbox["user_id"] == p.first.pk
    rows = inbox["items"]
    assert len(rows) == 1 and rows[0]["device_id"] == first["device"]["id"]
    foreign_id = rows[0]["id"]
    for client in (p.s, p.a):
        assert (
            call(client, "chat/drafts/" + foreign_id, method="delete").status_code
            == 404
        )
        assert (
            call(
                client, "chat/devices/" + first["device"]["id"], method="delete"
            ).status_code
            == 404
        )
        assert client.get("/api/v1/chat/drafts?before=" + foreign_id).status_code == 400
    assert p.a.get("/api/v1/chat/drafts").json()["items"] == []
    assert p.a.get("/api/v1/chat/devices").json()["items"] == []
    assert len(p.s.get("/api/v1/chat/drafts").json()["items"]) == 1
    management = p.a.get("/api/v1/admin/chat/users").json()
    assert management["user_id"] == p.admin.pk
    assert {item["username"] for item in management["items"]} == {
        "chat-admin",
        "chat-first",
        "chat-second",
    }
    assert "测试私有草稿" not in json.dumps(management, ensure_ascii=False)
    row = next(item for item in management["items"] if item["id"] == p.first.pk)
    assert row["device_count"] == 1 and row["last_seen_at"]


def test_disable_reenable_revoke_and_inactive_account(actors):
    p = actors
    info = device(p, p.first, p.f)
    token = info["token"]
    assert upload(token).status_code == 200
    assert (
        call(
            p.a, f"admin/chat/users/{p.first.pk}", {"enabled": False}, "patch"
        ).status_code
        == 200
    )
    assert upload(token, packet("blocked")).status_code == 403
    assert p.f.get("/api/v1/chat/drafts").status_code == 403
    assert p.f.get("/api/v1/chat/me").json()["enabled"] is False
    enable(p, p.first)
    assert upload(token, packet("reenabled")).status_code == 200
    assert (
        call(p.f, "chat/devices/" + info["device"]["id"], method="delete").status_code
        == 200
    )
    assert upload(token).status_code == 401
    assert p.f.get("/api/v1/chat/devices").json()["items"][0]["revoked_at"]
    replacement = device(p, p.first, p.f)
    p.first.is_active = False
    p.first.save(update_fields=["is_active"])
    assert upload(replacement["token"]).status_code == 403


def test_idempotency_conflict_and_deleted_payload_does_not_return(actors):
    info = device(actors, actors.first, actors.f)
    token = info["token"]
    first = upload(token)
    assert first.json() == {"ok": True, "id": "batch_1", "duplicate": False}
    assert upload(token).json()["duplicate"] is True
    changed = packet()
    changed["drafts"][0]["text"] = "不同内容"
    assert upload(token, changed).status_code == 409
    assert ChatDraftBatch.objects.count() == 1
    row = ChatDraftBatch.objects.get()
    assert call(actors.f, f"chat/drafts/{row.id}", method="delete").status_code == 200
    row.refresh_from_db()
    assert row.payload == {} and row.deleted_at is not None
    assert upload(token).json()["duplicate"] is True
    assert upload(token, changed).status_code == 409
    assert actors.f.get("/api/v1/chat/drafts").json()["items"] == []
    audit = json.dumps(
        list(PlatformAudit.objects.values("action", "detail")), ensure_ascii=False
    )
    assert token not in audit and "测试私有草稿内容" not in audit


def test_device_token_cannot_change_owner_or_bind_extra_fields(actors):
    info = device(actors, actors.first, actors.f)
    injected = packet()
    injected["userId"] = actors.second.pk
    assert upload(info["token"], injected).status_code == 422
    assert (
        call(
            actors.f, "chat/devices", {"name": "Mac", "owner": actors.second.pk}
        ).status_code
        == 422
    )
    assert ChatDraftBatch.objects.count() == 0


@pytest.mark.parametrize(
    "path,value",
    [
        (("id",), "bad/id"),
        (("conversationKey",), "bad\nkey"),
        (("conversationName",), "x" * 81),
        (("basedOnMessageId",), ""),
        (("createdAt",), "2026-02-30T00:00:00Z"),
        (("createdAt",), "2026-10-11T00:00:00"),
        (("createdAt",), "2026-10-11T00:00:00+01:99"),
        (("provider",), "other"),
        (("provider",), []),
        (("profileVersion",), "x" * 33),
        (("drafts",), []),
        (("drafts",), [dict(text="a", label="b", reason="c")] * 4),
        (("drafts", 0, "text"), "x" * 501),
        (("drafts", 0, "label"), "x" * 41),
        (("drafts", 0, "reason"), "x" * 301),
        (("drafts", 0, "text"), " \n"),
        (("drafts", 0, "text"), "bad\x00data"),
        (("drafts", 0, "reason"), "\ud800"),
        (("drafts", 0, "text"), "🙂" * 251),
    ],
)
def test_strict_sync_payload_validation(actors, path, value):
    info = device(actors, actors.first, actors.f)
    body = packet()
    pointer = body
    for element in path[:-1]:
        pointer = pointer[element]
    pointer[path[-1]] = value
    assert upload(info["token"], body).status_code == 422
    assert not ChatDraftBatch.objects.exists()


def test_payload_size_malformed_json_header_and_unknown_nested_field(actors):
    info = device(actors, actors.first, actors.f)
    token = info["token"]
    body = packet()
    body["drafts"][0]["unknown"] = "value"
    assert upload(token, body).status_code == 422
    body = packet()
    del body["profileVersion"]
    assert upload(token, body).status_code == 422
    assert upload(token, key="wrong").status_code == 400
    response = Client().post(
        "/api/v1/chat/ingest",
        data=b"x" * (32768 + 1),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + token,
    )
    assert response.status_code == 413
    response = Client().post(
        "/api/v1/chat/ingest",
        data=b"not-json",
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + token,
    )
    assert response.status_code == 400
    response = Client().post(
        "/api/v1/chat/ingest",
        data=json.dumps(packet()),
        content_type="text/plain",
        HTTP_AUTHORIZATION="Bearer " + token,
    )
    assert response.status_code == 400
    assert Client().get("/api/v1/chat/ingest").status_code == 405


def test_session_routes_keep_csrf_and_ingress_is_only_exemption(actors):
    p = actors
    info = device(p, p.first, p.f)
    strict = Client(enforce_csrf_checks=True)
    strict.force_login(p.first)
    csrf = strict.get("/api/v1/auth/me").json()["csrf_token"]
    assert call(strict, "chat/devices", {"name": "Mac"}).status_code == 403
    assert (
        call(
            strict, "chat/devices/" + info["device"]["id"], method="delete"
        ).status_code
        == 403
    )
    assert (
        call(strict, "chat/devices", {"name": "Mac"}, HTTP_X_CSRFTOKEN=csrf).status_code
        == 200
    )
    strict.force_login(p.admin)
    csrf = strict.get("/api/v1/auth/me").json()["csrf_token"]
    assert (
        call(
            strict, f"admin/chat/users/{p.first.pk}", {"enabled": False}, "patch"
        ).status_code
        == 403
    )
    assert (
        call(
            strict,
            f"admin/chat/users/{p.first.pk}",
            {"enabled": False},
            "patch",
            HTTP_X_CSRFTOKEN=csrf,
        ).status_code
        == 200
    )
    assert call(strict, "auth/logout").status_code == 403


def test_device_limit_and_pagination(actors):
    p = actors
    info = device(p, p.first, p.f)
    for n in range(9):
        assert call(p.f, "chat/devices", {"name": f"Mac {n}"}).status_code == 200
    assert call(p.f, "chat/devices", {"name": "too-many"}).status_code == 409
    assert (
        call(p.f, "chat/devices/" + info["device"]["id"], method="delete").status_code
        == 200
    )
    replacement = call(p.f, "chat/devices", {"name": "replacement"}).json()
    for n in range(3):
        assert upload(replacement["token"], packet(f"batch_{n}")).status_code == 200
    first = p.f.get("/api/v1/chat/drafts?limit=2").json()
    second = p.f.get(
        "/api/v1/chat/drafts?limit=2&before=" + first["next_cursor"]
    ).json()
    assert (
        len(first["items"]) == 2
        and len(second["items"]) == 1
        and second["next_cursor"] is None
    )
    assert len({row["id"] for row in first["items"] + second["items"]}) == 3
    for invalid in ("0", "101", "abc", "-1"):
        assert p.f.get("/api/v1/chat/drafts?limit=" + invalid).status_code == 400
    users = p.a.get("/api/v1/admin/chat/users?limit=2").json()
    more = p.a.get("/api/v1/admin/chat/users?after=" + str(users["next_cursor"])).json()
    assert len(users["items"]) == 2 and len(more["items"]) == 1
    assert (
        p.a.get("/api/v1/admin/chat/users?q=second").json()["items"][0]["username"]
        == "chat-second"
    )


def test_user_deletion_cleans_chat_data_without_changing_other_owners(actors):
    p = actors
    first = device(p, p.first, p.f)
    second = device(p, p.second, p.s)
    assert upload(first["token"]).status_code == 200
    assert upload(second["token"]).status_code == 200
    response = call(
        p.a,
        f"admin/users/{p.first.pk}",
        {"version": 0, "confirm_username": p.first.username},
        "delete",
        HTTP_IDEMPOTENCY_KEY="delete-chat-owner",
    )
    assert response.status_code == 200, response.content
    assert not User.objects.filter(pk=p.first.pk).exists()
    assert not ChatAccess.objects.filter(user_id=p.first.pk).exists()
    assert not ChatDevice.objects.filter(owner_id=p.first.pk).exists()
    assert not ChatDraftBatch.objects.filter(owner_id=p.first.pk).exists()
    assert ChatDraftBatch.objects.filter(owner=p.second).count() == 1
    assert upload(first["token"]).status_code == 401


def test_identity_header_prevents_cross_tab_account_switch_writes(actors):
    p = actors
    info = device(p, p.first, p.f)
    enable(p, p.second)
    assert (
        call(
            p.f, "chat/devices", {"name": "missing identity"}, HTTP_X_CHAT_USER_ID=""
        ).status_code
        == 403
    )
    switched = Client()
    switched.force_login(p.second)
    response = call(
        switched,
        "chat/devices",
        {"name": "stale first tab"},
        HTTP_X_CHAT_USER_ID=str(p.first.pk),
    )
    assert (
        response.status_code == 403
        and response.json()["code"] == "chat_identity_mismatch"
    )
    assert not ChatDevice.objects.filter(owner=p.second).exists()
    response = call(
        p.a,
        f"admin/chat/users/{p.first.pk}",
        {"enabled": False},
        "patch",
        HTTP_X_CHAT_USER_ID=str(p.second.pk),
    )
    assert response.status_code == 403
    assert ChatAccess.objects.get(user=p.first).enabled is True
    assert upload(info["token"]).status_code == 200
