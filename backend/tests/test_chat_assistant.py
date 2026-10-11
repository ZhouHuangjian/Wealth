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


def test_token_is_not_listed_and_cannot_authenticate_session_routes(actors):
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
    assert row.payload == packet() and row.deleted_at is not None
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


def check_device(token, body=None, client=None):
    return call(
        client or Client(enforce_csrf_checks=True),
        "chat/device/check",
        {} if body is None else body,
        HTTP_AUTHORIZATION="Bearer " + token,
    )


def test_device_configuration_is_encrypted_recoverable_and_not_listed(actors):
    info = device(actors, actors.first, actors.f)
    ident, token = info["device"]["id"], info["token"]
    row = ChatDevice.objects.get(pk=ident)
    assert row.token_ciphertext and token not in row.token_ciphertext
    assert info["device"]["config_available"] is True
    assert info["device"]["connection_state"] == "awaiting_connection"
    for _ in range(2):
        response = call(actors.f, f"chat/devices/{ident}/config")
        assert response.status_code == 200 and response.json()["token"] == token
        assert response["Cache-Control"] == "no-store"
        assert response.json()["user_id"] == actors.first.pk
    listing = actors.f.get("/api/v1/chat/devices").content.decode()
    assert (
        token not in listing
        and row.token_ciphertext not in listing
        and "token_hash" not in listing
    )
    audit = json.dumps(list(PlatformAudit.objects.values("action", "detail")))
    assert token not in audit and row.token_ciphertext not in audit


def test_config_and_rotate_are_owner_only_including_admin(actors):
    p = actors
    info = device(p, p.first, p.f)
    enable(p, p.second)
    enable(p, p.admin)
    for action in ("config", "rotate"):
        path = f"chat/devices/{info['device']['id']}/{action}"
        for client in (p.s, p.a):
            assert call(client, path).status_code == 404
        assert call(Client(), path).status_code == 401
        assert p.f.get("/api/v1/" + path).status_code == 404
        assert call(p.f, path, {"owner_id": p.second.pk}).status_code == 422
    assert check_device(info["token"]).status_code == 200


def test_check_connects_device_without_creating_drafts(actors):
    info = device(actors, actors.first, actors.f)
    response = check_device(info["token"])
    assert response.status_code == 200 and response["Cache-Control"] == "no-store"
    assert response.json()["device"] == {"id": info["device"]["id"], "name": "测试 Mac"}
    assert response.json()["ok"] is True
    from django.utils.dateparse import parse_datetime

    assert parse_datetime(response.json()["checkedAt"]) is not None
    assert not ChatDraftBatch.objects.exists()
    row = actors.f.get("/api/v1/chat/devices").json()["items"][0]
    assert row["last_seen_at"] and row["connection_state"] == "connected"


def test_rotation_invalidates_old_token_but_preserves_device_and_drafts(actors):
    info = device(actors, actors.first, actors.f)
    assert upload(info["token"]).status_code == 200
    draft_id = ChatDraftBatch.objects.get().pk
    response = call(actors.f, f"chat/devices/{info['device']['id']}/rotate")
    assert response.status_code == 200 and response["Cache-Control"] == "no-store"
    newer = response.json()
    assert newer["token"] != info["token"]
    assert newer["device"]["id"] == info["device"]["id"]
    assert newer["device"]["last_seen_at"] is None
    assert newer["device"]["connection_state"] == "awaiting_connection"
    assert ChatDraftBatch.objects.get().pk == draft_id
    assert upload(info["token"]).status_code == 401
    assert check_device(info["token"]).status_code == 401
    assert check_device(newer["token"]).status_code == 200
    assert upload(newer["token"]).json()["duplicate"] is True
    assert (
        call(actors.f, f"chat/devices/{info['device']['id']}/config").json()["token"]
        == newer["token"]
    )


def test_legacy_hash_only_device_remains_usable_and_can_rotate(actors):
    info = device(actors, actors.first, actors.f)
    ident = info["device"]["id"]
    ChatDevice.objects.filter(pk=ident).update(token_ciphertext="")
    listing = actors.f.get("/api/v1/chat/devices").json()["items"][0]
    assert listing["config_available"] is False
    response = call(actors.f, f"chat/devices/{ident}/config")
    assert (
        response.status_code == 409
        and response.json()["code"] == "device_config_unavailable"
    )
    assert check_device(info["token"]).status_code == 200
    assert upload(info["token"]).status_code == 200
    rotated = call(actors.f, f"chat/devices/{ident}/rotate")
    assert (
        rotated.status_code == 200
        and rotated.json()["device"]["config_available"] is True
    )
    assert check_device(info["token"]).status_code == 401


def test_configuration_encryption_is_device_bound_and_supports_explicit_key_fallback(
    actors, settings
):
    from wealth.chat_credentials import read_device_token

    info = device(actors, actors.first, actors.f)
    other = device(actors, actors.first, actors.f, "另一合成设备")
    row = ChatDevice.objects.get(pk=info["device"]["id"])
    copied = ChatDevice.objects.get(pk=other["device"]["id"])
    copied.token_ciphertext = row.token_ciphertext
    copied.save(update_fields=["token_ciphertext"])
    assert read_device_token(copied) is None
    assert (
        call(actors.f, f"chat/devices/{copied.pk}/config").json()["code"]
        == "device_config_unavailable"
    )
    original = settings.SECRET_KEY
    settings.SECRET_KEY = "synthetic-rotated-key-only-for-chat-test"
    assert read_device_token(row) is None
    settings.SECRET_KEY_FALLBACKS = [original]
    assert read_device_token(row) == info["token"]
    row.token_hash = "0" * 64
    assert read_device_token(row) is None


def test_disabled_revoked_and_inactive_devices_cannot_get_config_rotate_or_check(
    actors,
):
    p = actors
    info = device(p, p.first, p.f)
    ident = info["device"]["id"]
    call(p.a, f"admin/chat/users/{p.first.pk}", {"enabled": False}, "patch")
    for action in ("config", "rotate"):
        assert call(p.f, f"chat/devices/{ident}/{action}").status_code == 403
    assert check_device(info["token"]).status_code == 403
    enable(p, p.first)
    assert call(p.f, f"chat/devices/{ident}", method="delete").status_code == 200
    for action in ("config", "rotate"):
        response = call(p.f, f"chat/devices/{ident}/{action}")
        assert (
            response.status_code == 409 and response.json()["code"] == "device_revoked"
        )
    assert check_device(info["token"]).status_code == 401
    listing = p.f.get("/api/v1/chat/devices").json()["items"][0]
    assert (
        listing["connection_state"] == "revoked"
        and listing["config_available"] is False
    )
    assert ChatDevice.objects.get(pk=ident).token_ciphertext == ""
    fresh = device(p, p.first, p.f)
    p.first.is_active = False
    p.first.save(update_fields=["is_active"])
    assert check_device(fresh["token"]).status_code == 403


def test_config_routes_keep_csrf_and_expected_identity_checks(actors):
    p = actors
    info = device(p, p.first, p.f)
    strict = Client(enforce_csrf_checks=True)
    strict.force_login(p.first)
    csrf = strict.get("/api/v1/auth/me").json()["csrf_token"]
    for action in ("config", "rotate"):
        path = f"chat/devices/{info['device']['id']}/{action}"
        assert call(strict, path).status_code == 403
        assert (
            call(
                strict,
                path,
                HTTP_X_CSRFTOKEN=csrf,
                HTTP_X_CHAT_USER_ID=str(p.second.pk),
            ).status_code
            == 403
        )
    assert (
        call(
            strict, f"chat/devices/{info['device']['id']}/config", HTTP_X_CSRFTOKEN=csrf
        ).json()["token"]
        == info["token"]
    )
    # Cookies and X-Chat-User-Id cannot authenticate the CSRF-exempt device probe.
    assert call(strict, "chat/device/check").status_code == 401
    assert check_device(info["token"]).status_code == 200


def test_device_check_accepts_only_small_empty_json_and_valid_bearer(actors):
    info = device(actors, actors.first, actors.f)
    token = info["token"]
    assert check_device("wchat_" + "z" * 43).status_code == 401
    assert check_device(token, {"drafts": []}).status_code == 422
    assert Client().get("/api/v1/chat/device/check").status_code == 405
    response = Client().post(
        "/api/v1/chat/device/check",
        data=b"x" * 1025,
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + token,
    )
    assert response.status_code == 413
    assert ChatDevice.objects.get(pk=info["device"]["id"]).last_seen_at is None


def test_old_application_can_insert_device_without_new_ciphertext_column(actors):
    import uuid
    from django.db import connection
    from django.utils import timezone

    enable(actors, actors.first)
    ident = uuid.uuid4()
    token = "wchat_" + "L" * 43
    # 2.13 creates the older column set. A persistent DB default keeps rollback safe.
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO wealth_chatdevice (id,owner_id,name,token_hash,created_at,last_seen_at,revoked_at) VALUES (%s,%s,%s,%s,%s,NULL,NULL)",
            [
                ident,
                actors.first.pk,
                "旧版本合成设备",
                hashlib.sha256(token.encode()).hexdigest(),
                timezone.now(),
            ],
        )
    row = ChatDevice.objects.get(pk=ident)
    assert row.token_ciphertext == ""
    assert check_device(token).status_code == 200
    assert (
        call(actors.f, f"chat/devices/{ident}/config").json()["code"]
        == "device_config_unavailable"
    )
    assert call(actors.f, f"chat/devices/{ident}/rotate").status_code == 200


def test_trash_keeps_payload_restores_same_batch_and_ignores_upload_retries(actors):
    info = device(actors, actors.first, actors.f)
    assert upload(info["token"]).status_code == 200
    row = ChatDraftBatch.objects.get()
    ident = row.pk
    assert call(actors.f, f"chat/drafts/{ident}", method="delete").status_code == 200
    assert actors.f.get("/api/v1/chat/drafts").json()["items"] == []
    trash = actors.f.get("/api/v1/chat/drafts?deleted=true").json()["items"]
    assert len(trash) == 1 and trash[0]["id"] == str(ident)
    assert trash[0]["can_restore"] is True and trash[0]["deleted_at"]
    assert trash[0]["drafts"] == packet()["drafts"]
    assert upload(info["token"]).json()["duplicate"] is True
    row.refresh_from_db()
    assert row.deleted_at is not None and row.payload == packet()
    assert call(actors.f, f"chat/drafts/{ident}/restore").status_code == 200
    row.refresh_from_db()
    assert row.pk == ident and row.deleted_at is None and row.payload == packet()
    assert actors.f.get("/api/v1/chat/drafts?deleted=true").json()["items"] == []
    assert (
        actors.f.get("/api/v1/chat/drafts").json()["items"][0]["can_restore"] is False
    )
    assert upload(info["token"]).json()["duplicate"] is True
    assert call(actors.f, f"chat/drafts/{ident}/restore").status_code == 409


def test_legacy_cleared_trash_cannot_restore_but_can_be_permanently_deleted(actors):
    from django.utils import timezone

    info = device(actors, actors.first, actors.f)
    upload(info["token"])
    row = ChatDraftBatch.objects.get()
    row.payload = {}
    row.deleted_at = timezone.now()
    row.save(update_fields=["payload", "deleted_at"])
    trash = actors.f.get("/api/v1/chat/drafts?deleted=true").json()["items"][0]
    assert (
        trash["can_restore"] is False
        and trash["drafts"] == []
        and trash["created_at"] is None
    )
    result = call(actors.f, f"chat/drafts/{row.pk}/restore")
    assert result.status_code == 409 and result.json()["code"] == "draft_unrecoverable"
    assert upload(info["token"]).json()["duplicate"] is True
    row.refresh_from_db()
    assert row.payload == {} and row.deleted_at is not None
    assert (
        call(actors.f, f"chat/drafts/{row.pk}/permanent", method="delete").status_code
        == 200
    )
    assert not ChatDraftBatch.objects.exists()


def test_trash_pagination_owner_isolation_and_admin_cannot_restore_or_erase(actors):
    p = actors
    info = device(p, p.first, p.f)
    enable(p, p.second)
    enable(p, p.admin)
    for number in range(3):
        upload(info["token"], packet(f"trash_{number}"))
    for ident in ChatDraftBatch.objects.values_list("pk", flat=True):
        assert call(p.f, f"chat/drafts/{ident}", method="delete").status_code == 200
    page = p.f.get("/api/v1/chat/drafts?deleted=true&limit=2").json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    more = p.f.get(
        "/api/v1/chat/drafts?deleted=true&limit=2&before=" + page["next_cursor"]
    ).json()
    assert len(more["items"]) == 1 and more["next_cursor"] is None
    ident = page["items"][0]["id"]
    for client in (p.s, p.a):
        assert client.get("/api/v1/chat/drafts?deleted=true").json()["items"] == []
        assert call(client, f"chat/drafts/{ident}/restore").status_code == 404
        assert (
            call(client, f"chat/drafts/{ident}/permanent", method="delete").status_code
            == 404
        )
        assert (
            call(
                client,
                f"chat/devices/{info['device']['id']}/permanent",
                method="delete",
            ).status_code
            == 404
        )
    assert p.f.get("/api/v1/chat/drafts?deleted=invalid").status_code == 400
    assert ChatDraftBatch.objects.count() == 3


@pytest.mark.parametrize("trashed", [False, True])
def test_permanent_draft_delete_removes_receipt_and_explicit_resync_creates_new_batch(
    actors, trashed
):
    info = device(actors, actors.first, actors.f)
    upload(info["token"])
    row = ChatDraftBatch.objects.get()
    ident = row.pk
    if trashed:
        call(actors.f, f"chat/drafts/{ident}", method="delete")
    assert (
        call(actors.f, f"chat/drafts/{ident}/permanent", method="delete").status_code
        == 200
    )
    assert not ChatDraftBatch.objects.filter(pk=ident).exists()
    result = upload(info["token"])
    assert result.status_code == 200 and result.json()["duplicate"] is False
    new_row = ChatDraftBatch.objects.get()
    assert new_row.pk != ident and new_row.deleted_at is None
    assert new_row.payload == packet()


def test_permanent_device_delete_removes_all_its_drafts_and_credentials_only(actors):
    from wealth.chat import bearer_candidate, locked_device
    from wealth.common import DomainError
    from django.test import RequestFactory

    p = actors
    doomed = device(p, p.first, p.f, "待永久删除设备")
    retained = device(p, p.first, p.f, "保留设备")
    foreign = device(p, p.second, p.s, "另一用户的设备")
    for info in (doomed, retained, foreign):
        assert upload(info["token"]).status_code == 200
    assert upload(doomed["token"], packet("to_trash")).status_code == 200
    trashed = ChatDraftBatch.objects.get(
        device_id=doomed["device"]["id"], batch_id="to_trash"
    )
    call(p.f, f"chat/drafts/{trashed.pk}", method="delete")
    listing = p.f.get("/api/v1/chat/devices").json()["items"]
    assert (
        next(item for item in listing if item["id"] == doomed["device"]["id"])[
            "draft_count"
        ]
        == 2
    )
    # Simulate a request that resolved the token before deletion and acquires the lock later.
    candidate, token_hash = bearer_candidate(
        RequestFactory().post("/", HTTP_AUTHORIZATION="Bearer " + doomed["token"])
    )
    assert (
        call(
            p.f, f"chat/devices/{doomed['device']['id']}/permanent", method="delete"
        ).status_code
        == 200
    )
    assert not ChatDevice.objects.filter(pk=doomed["device"]["id"]).exists()
    assert not ChatDraftBatch.objects.filter(device_id=doomed["device"]["id"]).exists()
    assert (
        ChatDraftBatch.objects.filter(device_id=retained["device"]["id"]).count() == 1
    )
    assert ChatDraftBatch.objects.filter(device_id=foreign["device"]["id"]).count() == 1
    assert upload(doomed["token"]).status_code == 401
    assert check_device(doomed["token"]).status_code == 401
    with pytest.raises(DomainError) as error:
        with locked_device(candidate, token_hash):
            pytest.fail("Deleted device must not pass the locked authorization recheck")
    assert error.value.code == "invalid_device_token"
    audit = PlatformAudit.objects.get(
        action="chat.device.permanently_deleted", target=doomed["device"]["id"]
    )
    assert audit.detail == {}
    assert doomed["token"] not in json.dumps(
        list(PlatformAudit.objects.values("action", "detail"))
    )


def test_restore_and_permanent_delete_keep_disabled_csrf_and_identity_guards(actors):
    p = actors
    info = device(p, p.first, p.f)
    upload(info["token"])
    row = ChatDraftBatch.objects.get()
    call(p.f, f"chat/drafts/{row.pk}", method="delete")
    operations = [
        (f"chat/drafts/{row.pk}/restore", "post"),
        (f"chat/drafts/{row.pk}/permanent", "delete"),
        (f"chat/devices/{info['device']['id']}/permanent", "delete"),
    ]
    strict = Client(enforce_csrf_checks=True)
    strict.force_login(p.first)
    csrf = strict.get("/api/v1/auth/me").json()["csrf_token"]
    for path, method in operations:
        assert call(strict, path, method=method).status_code == 403
        assert (
            call(
                strict,
                path,
                method=method,
                HTTP_X_CSRFTOKEN=csrf,
                HTTP_X_CHAT_USER_ID=str(p.second.pk),
            ).status_code
            == 403
        )
    call(p.a, f"admin/chat/users/{p.first.pk}", {"enabled": False}, "patch")
    for path, method in operations:
        assert call(p.f, path, method=method).status_code == 403
    assert ChatDevice.objects.filter(pk=info["device"]["id"]).exists()
    row.refresh_from_db()
    assert row.deleted_at is not None and row.payload == packet()


def test_revoked_device_can_be_permanently_removed_without_restoring_its_token(actors):
    info = device(actors, actors.first, actors.f)
    assert upload(info["token"]).status_code == 200
    path = f"chat/devices/{info['device']['id']}"
    assert call(actors.f, path, method="delete").status_code == 200
    assert call(actors.f, path + "/permanent", method="delete").status_code == 200
    assert ChatDevice.objects.count() == 0 and ChatDraftBatch.objects.count() == 0
    assert check_device(info["token"]).status_code == 401
