import json
import uuid
from copy import deepcopy
from datetime import timedelta

import pytest
from django.test import Client
from django.utils import timezone

from test_chat_assistant import actors, call, device, enable, upload  # noqa: F401
from wealth.chat_models import ChatDevice, ChatDeviceCommand, ChatDraftBatch
from wealth.chat_remote import FAILURE_MESSAGE, MAX_QUEUED_COMMANDS
from wealth.platform_models import PlatformAudit

pytestmark = pytest.mark.django_db


def snapshot():
    return {
        "version": 1,
        "remoteEnabled": True,
        "settings": {
            "provider": "codex",
            "modelName": "",
            "autoReplyEnabled": False,
            "syncDraftsEnabled": True,
            "replyDelaySeconds": 3,
            "cooldownSeconds": 0,
            "dailyLimit": 100,
            "quietHoursEnabled": False,
            "quietStart": "23:00",
            "quietEnd": "08:00",
        },
        "conversations": [],
        "capabilities": {"wechatAvailable": True, "codexAvailable": True},
    }


def poll(token, state=None, completed=None, client=None):
    return call(
        client or Client(enforce_csrf_checks=True),
        "chat/device/poll",
        {
            "snapshot": snapshot() if state is None else state,
            "completed": completed or [],
        },
        HTTP_AUTHORIZATION="Bearer " + token,
    )


def queue(client, ident, kind="settings.patch", payload=None, key=None, **headers):
    return call(
        client,
        f"chat/devices/{ident}/commands",
        {
            "type": kind,
            "payload": {"replyDelaySeconds": 5} if payload is None else payload,
        },
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()) if key is None else key,
        **headers,
    )


def ready(actors):
    info = device(actors, actors.first, actors.f)
    response = poll(info["token"])
    assert response.status_code == 200, response.content
    return info, info["device"]["id"]


def receipt(command, status="succeeded", result=None, error=""):
    return {
        "id": command["id"],
        "status": status,
        "result": result or {},
        "error": error,
    }


def test_device_poll_requires_bearer_and_does_not_expose_private_data_in_device_list(
    actors,
):
    info, ident = ready(actors)
    assert (
        call(
            actors.f, "chat/device/poll", {"snapshot": snapshot(), "completed": []}
        ).status_code
        == 401
    )
    assert Client().get("/api/v1/chat/device/poll").status_code == 405
    response = actors.f.get(f"/api/v1/chat/devices/{ident}/remote")
    assert response.status_code == 200
    assert response["Cache-Control"] == "no-store"
    assert response.json()["snapshot"] == snapshot()
    assert response.json()["user_id"] == actors.first.pk
    assert response.json()["last_poll_at"]
    listing = actors.f.get("/api/v1/chat/devices").json()["items"][0]
    assert "snapshot" not in listing and "remote_snapshot" not in listing
    assert not ChatDraftBatch.objects.exists()


def test_owner_isolation_including_admin_csrf_and_stale_identity(actors):
    info, ident = ready(actors)
    enable(actors, actors.second)
    enable(actors, actors.admin)
    for client in (actors.s, actors.a):
        assert client.get(f"/api/v1/chat/devices/{ident}/remote").status_code == 404
        assert queue(client, ident).status_code == 404
    assert (
        Client()
        .get(
            f"/api/v1/chat/devices/{ident}/remote",
            HTTP_AUTHORIZATION="Bearer " + info["token"],
        )
        .status_code
        == 401
    )
    assert (
        queue(actors.f, ident, HTTP_X_CHAT_USER_ID=str(actors.second.pk)).status_code
        == 403
    )
    strict = Client(enforce_csrf_checks=True)
    strict.force_login(actors.first)
    csrf = strict.get("/api/v1/auth/me").json()["csrf_token"]
    assert queue(strict, ident).status_code == 403
    assert queue(strict, ident, HTTP_X_CSRFTOKEN=csrf).status_code == 200


def test_fifo_delivery_replay_receipt_idempotency_and_conflicts(actors):
    info, ident = ready(actors)
    key = str(uuid.uuid4())
    one = queue(actors.f, ident, key=key).json()["command"]
    duplicate = queue(actors.f, ident, key=key)
    assert duplicate.status_code == 200 and duplicate.json()["duplicate"]
    assert duplicate.json()["command"]["id"] == one["id"]
    assert (
        queue(actors.f, ident, key=key, payload={"dailyLimit": 50}).status_code == 409
    )
    assert queue(actors.f, ident, key="invalid").status_code == 400
    two = queue(actors.f, ident, payload={"dailyLimit": 50}).json()["command"]
    first_poll = poll(info["token"]).json()
    assert len(first_poll["commands"]) == 1
    assert first_poll["commands"][0]["id"] == one["id"]
    assert first_poll["commands"][0]["status"] == "delivered"
    assert poll(info["token"]).json()["commands"][0]["id"] == one["id"]
    ack = receipt(one)
    next_poll = poll(info["token"], completed=[ack])
    assert next_poll.status_code == 200
    assert next_poll.json()["commands"][0]["id"] == two["id"]
    assert poll(info["token"], completed=[ack]).status_code == 200
    assert (
        poll(
            info["token"],
            completed=[receipt(one, "failed", error="secret=should-not-store")],
        ).status_code
        == 409
    )
    assert ChatDeviceCommand.objects.get(pk=one["id"]).status == "succeeded"


def test_unknown_cross_device_and_undelivered_receipts_cannot_complete_commands(actors):
    info, ident = ready(actors)
    command = queue(actors.f, ident).json()["command"]
    assert poll(info["token"], completed=[receipt(command)]).status_code == 409
    assert (
        poll(info["token"], completed=[receipt({"id": str(uuid.uuid4())})]).status_code
        == 409
    )
    other = device(actors, actors.first, actors.f, "另一个测试设备")
    poll(info["token"])
    assert poll(other["token"], completed=[receipt(command)]).status_code == 409
    assert ChatDeviceCommand.objects.get(pk=command["id"]).status == "delivered"


def test_queue_requires_snapshot_expires_after_fifteen_minutes_and_has_cap(actors):
    info = device(actors, actors.first, actors.f)
    ident = info["device"]["id"]
    assert queue(actors.f, ident).status_code == 409
    assert poll(info["token"]).status_code == 200
    one = queue(actors.f, ident).json()["command"]
    row = ChatDeviceCommand.objects.get(pk=one["id"])
    assert 899 < (row.expires_at - row.created_at).total_seconds() <= 900
    ChatDeviceCommand.objects.filter(pk=row.pk).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    assert poll(info["token"]).json()["commands"] == []
    assert ChatDeviceCommand.objects.get(pk=row.pk).status == "expired"
    now = timezone.now()
    ChatDeviceCommand.objects.bulk_create(
        [
            ChatDeviceCommand(
                device_id=ident,
                request_id=uuid.uuid4(),
                type="settings.patch",
                payload={},
                payload_digest="",
                expires_at=now + timedelta(minutes=15),
            )
            for _ in range(MAX_QUEUED_COMMANDS)
        ]
    )
    assert queue(actors.f, ident).json()["code"] == "remote_queue_full"


def test_late_ack_confirms_delivered_command_without_replaying_expired_requests(actors):
    info, ident = ready(actors)
    command = queue(actors.f, ident).json()["command"]
    poll(info["token"])
    ChatDeviceCommand.objects.filter(pk=command["id"]).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    assert poll(info["token"]).json()["commands"] == []
    response = poll(info["token"], completed=[receipt(command)])
    assert response.status_code == 200 and response.json()["commands"] == []
    assert ChatDeviceCommand.objects.get(pk=command["id"]).status == "succeeded"


@pytest.mark.parametrize(
    "kind,payload",
    [
        ("shell.exec", {"cmd": "echo synthetic"}),
        ("message.send", {"text": "synthetic"}),
        ("settings.patch", {}),
        ("settings.patch", {"apiKey": "synthetic-key"}),
        ("settings.patch", {"modelUrl": "https://example.org"}),
        ("settings.patch", {"autoReplyMode": "send"}),
        ("settings.patch", {"allowRemoteModel": True}),
        ("settings.patch", {"replyDelaySeconds": True}),
        ("settings.patch", {"dailyLimit": 0}),
        ("settings.patch", {"quietStart": "24:00"}),
        ("settings.patch", {"provider": []}),
        ("conversation.add", {"externalId": "id", "name": "x" * 81}),
        ("conversation.add", {"externalId": "id\n", "name": "test"}),
        ("conversation.patch", {"id": "id"}),
        ("conversation.patch", {"id": "id", "relationship": "friend"}),
        ("conversation.patch", {"id": "id", "enabled": 1}),
        ("contacts.search", {"query": ""}),
        ("contacts.search", {"query": "test", "limit": 31}),
    ],
)
def test_remote_command_schema_is_strict_and_draft_only(actors, kind, payload):
    _, ident = ready(actors)
    assert queue(actors.f, ident, kind=kind, payload=payload).status_code == 422
    assert not ChatDeviceCommand.objects.exists()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: s.update(messages=[{"text": "private"}]),
        lambda s: s["settings"].update(apiKey="secret"),
        lambda s: s["settings"].update(autoReplyMode="send"),
        lambda s: s["capabilities"].update(extra="unsupported"),
        lambda s: s.update(remoteEnabled=1),
        lambda s: s.update(version=True),
        lambda s: s.update(conversations=[{}]),
    ],
)
def test_snapshot_rejects_credentials_messages_and_invalid_shapes_atomically(
    actors, mutate
):
    info, ident = ready(actors)
    before = ChatDevice.objects.get(pk=ident).last_poll_at
    state = snapshot()
    mutate(state)
    assert poll(info["token"], state).status_code == 422
    row = ChatDevice.objects.get(pk=ident)
    assert row.last_poll_at == before and row.remote_snapshot == snapshot()


def test_contact_search_result_and_conversation_result_strictly_projected(actors):
    info, ident = ready(actors)
    search = queue(
        actors.f, ident, "contacts.search", {"query": "测试", "limit": 5}
    ).json()["command"]
    poll(info["token"])
    result = {
        "contacts": [{"externalId": "wxid_synthetic", "name": "测试"}],
        "hasMore": False,
    }
    unsafe = deepcopy(result)
    unsafe["contacts"][0]["messages"] = ["private"]
    assert (
        poll(info["token"], completed=[receipt(search, result=unsafe)]).status_code
        == 422
    )
    assert (
        poll(info["token"], completed=[receipt(search, result=result)]).status_code
        == 200
    )
    add = queue(actors.f, ident, "conversation.add", result["contacts"][0]).json()[
        "command"
    ]
    poll(info["token"])
    conversation = {
        "id": "local_synthetic",
        "externalId": "wxid_synthetic",
        "name": "测试",
        "note": "备注",
        "autoReplyEnabled": False,
        "enabled": True,
    }
    assert (
        poll(
            info["token"],
            completed=[receipt(add, result={"conversation": conversation})],
        ).status_code
        == 200
    )
    state = snapshot()
    state["conversations"] = [conversation]
    assert poll(info["token"], state).status_code == 200
    assert actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()["snapshot"][
        "conversations"
    ] == [conversation]
    audit = json.dumps(
        list(
            PlatformAudit.objects.filter(action="chat.device.command.created").values()
        ),
        default=str,
    )
    assert "wxid_synthetic" not in audit and "备注" not in audit


@pytest.mark.parametrize("note", ["", "   ", "\n\t"])
def test_optional_conversation_notes_allow_blank_text_in_snapshot_patch_and_receipt(
    actors, note
):
    info, ident = ready(actors)
    conversation = {
        "id": "local_blank_note",
        "externalId": "wxid_blank_note",
        "name": "测试空备注",
        "note": note,
        "autoReplyEnabled": False,
        "enabled": False,
    }
    state = snapshot()
    state["conversations"] = [conversation]
    assert poll(info["token"], state).status_code == 200
    queued = queue(
        actors.f, ident, "conversation.patch", {"id": conversation["id"], "note": note}
    )
    assert queued.status_code == 200, queued.content
    command = queued.json()["command"]
    assert poll(info["token"], state).json()["commands"][0]["id"] == command["id"]
    assert (
        poll(
            info["token"],
            state,
            [receipt(command, result={"conversation": conversation})],
        ).status_code
        == 200
    )
    assert (
        ChatDevice.objects.get(pk=ident).remote_snapshot["conversations"][0]["note"]
        == note
    )


@pytest.mark.parametrize("value", [None, False, "\x00", "\ud800", "😀" * 1001])
def test_optional_text_still_rejects_invalid_characters_types_and_utf16_overflow(value):
    from wealth.chat_remote import optional_text
    from wealth.common import DomainError

    with pytest.raises(DomainError):
        optional_text(value, 2000)


def test_failure_receipt_discards_raw_error_and_disabled_snapshot_cancels_queue(actors):
    info, ident = ready(actors)
    one = queue(actors.f, ident).json()["command"]
    two = queue(actors.f, ident).json()["command"]
    poll(info["token"])
    state = snapshot()
    state["remoteEnabled"] = False
    response = poll(
        info["token"],
        state,
        [receipt(one, "failed", error="SECRET_SYNTHETIC_KEY_IN_EXCEPTION")],
    )
    assert response.status_code == 200 and response.json()["commands"] == []
    assert ChatDeviceCommand.objects.get(pk=one["id"]).error == FAILURE_MESSAGE
    assert ChatDeviceCommand.objects.get(pk=two["id"]).status == "cancelled"
    assert queue(actors.f, ident).status_code == 409
    assert (
        "SECRET_SYNTHETIC"
        not in actors.f.get(f"/api/v1/chat/devices/{ident}/remote").content.decode()
    )


def test_rotation_and_revocation_invalidate_queue_and_reset_binding_snapshot(actors):
    info, ident = ready(actors)
    command = queue(actors.f, ident).json()["command"]
    poll(info["token"])
    rotated = call(actors.f, f"chat/devices/{ident}/rotate").json()
    assert poll(info["token"]).status_code == 401
    row = ChatDevice.objects.get(pk=ident)
    assert row.last_poll_at is None and row.remote_snapshot == {}
    assert ChatDeviceCommand.objects.get(pk=command["id"]).status == "cancelled"
    assert poll(rotated["token"]).json()["commands"] == []
    command = queue(actors.f, ident).json()["command"]
    assert call(actors.f, f"chat/devices/{ident}", method="delete").status_code == 200
    assert poll(rotated["token"]).status_code == 401
    assert queue(actors.f, ident).status_code == 409
    assert ChatDeviceCommand.objects.get(pk=command["id"]).status == "cancelled"


def test_disabled_and_inactive_account_cannot_poll_or_change_remote_settings(actors):
    info, ident = ready(actors)
    call(actors.a, f"admin/chat/users/{actors.first.pk}", {"enabled": False}, "patch")
    assert poll(info["token"]).status_code == 403
    assert queue(actors.f, ident).status_code == 403
    assert actors.f.get(f"/api/v1/chat/devices/{ident}/remote").status_code == 403
    enable(actors, actors.first)
    actors.first.is_active = False
    actors.first.save(update_fields=["is_active"])
    assert poll(info["token"]).status_code == 403


def test_permanent_device_delete_cascades_commands_snapshot_and_drafts_only(actors):
    info, ident = ready(actors)
    queue(actors.f, ident)
    upload(info["token"])
    other = device(actors, actors.first, actors.f, "保留设备")
    poll(other["token"])
    queue(actors.f, other["device"]["id"])
    assert (
        call(actors.f, f"chat/devices/{ident}/permanent", method="delete").status_code
        == 200
    )
    assert not ChatDevice.objects.filter(pk=ident).exists()
    assert not ChatDeviceCommand.objects.filter(device_id=ident).exists()
    assert not ChatDraftBatch.objects.filter(device_id=ident).exists()
    assert ChatDeviceCommand.objects.count() == 1
    assert poll(info["token"]).status_code == 401
    assert poll(other["token"]).status_code == 200


def test_permanent_account_cleanup_function_also_removes_command_rows(actors):
    info, ident = ready(actors)
    queue(actors.f, ident)
    upload(info["token"])
    other = device(actors, actors.second, actors.s)
    poll(other["token"])
    queue(actors.s, other["device"]["id"])
    response = call(
        actors.a,
        f"admin/users/{actors.first.pk}",
        {"version": 0, "confirm_username": actors.first.username},
        "delete",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 200, response.content
    assert not ChatDevice.objects.filter(pk=ident).exists()
    assert not ChatDeviceCommand.objects.filter(device_id=ident).exists()
    assert ChatDeviceCommand.objects.count() == 1


def test_poll_limits_and_receipt_validation_do_not_update_heartbeat(actors):
    info, ident = ready(actors)
    for data, content_type, expected in [
        (b"x" * (1024 * 1024 + 1), "application/json", 413),
        (b"not-json", "application/json", 400),
        (b"{}", "text/plain", 400),
    ]:
        response = Client().post(
            "/api/v1/chat/device/poll",
            data=data,
            content_type=content_type,
            HTTP_AUTHORIZATION="Bearer " + info["token"],
        )
        assert response.status_code == expected
    assert (
        poll(
            info["token"],
            completed=[
                {
                    "id": str(uuid.uuid4()),
                    "status": "succeeded",
                    "result": {},
                    "error": "not-empty",
                }
            ],
        ).status_code
        == 422
    )
    command = queue(actors.f, ident).json()["command"]
    poll(info["token"])
    before = ChatDevice.objects.get(pk=ident).last_poll_at
    assert (
        poll(info["token"], completed=[receipt(command), receipt(command)]).status_code
        == 422
    )
    assert ChatDevice.objects.get(pk=ident).last_poll_at == before
    assert (
        poll(info["token"], completed=[receipt(command) for _ in range(21)]).status_code
        == 422
    )


@pytest.mark.parametrize(
    "change,expected",
    [("revoke", 401), ("rotate", 401), ("delete", 401), ("disable", 403)],
)
def test_auth_is_rechecked_after_candidate_lookup_before_poll_mutations(
    actors, monkeypatch, change, expected
):
    from wealth import chat_remote

    info, ident = ready(actors)
    command = queue(actors.f, ident).json()["command"]
    original = chat_remote.read_device_json

    def read_then_change_binding(request, maximum):
        body = original(request, maximum)
        if change == "revoke":
            response = call(actors.f, f"chat/devices/{ident}", method="delete")
        elif change == "rotate":
            response = call(actors.f, f"chat/devices/{ident}/rotate")
        elif change == "delete":
            response = call(
                actors.f, f"chat/devices/{ident}/permanent", method="delete"
            )
        else:
            response = call(
                actors.a,
                f"admin/chat/users/{actors.first.pk}",
                {"enabled": False},
                "patch",
            )
        assert response.status_code == 200
        return body

    monkeypatch.setattr(chat_remote, "read_device_json", read_then_change_binding)
    assert poll(info["token"]).status_code == expected
    assert not ChatDeviceCommand.objects.filter(
        pk=command["id"], status="delivered"
    ).exists()


def test_receipt_batch_failure_rolls_back_earlier_ack_and_snapshot(actors):
    info, ident = ready(actors)
    command = queue(actors.f, ident).json()["command"]
    poll(info["token"])
    before = ChatDevice.objects.get(pk=ident).last_poll_at
    state = snapshot()
    state["settings"]["dailyLimit"] = 50
    response = poll(
        info["token"], state, [receipt(command), receipt({"id": str(uuid.uuid4())})]
    )
    assert response.status_code == 409
    assert ChatDeviceCommand.objects.get(pk=command["id"]).status == "delivered"
    row = ChatDevice.objects.get(pk=ident)
    assert row.last_poll_at == before and row.remote_snapshot == snapshot()


def test_old_terminal_receipts_are_pruned_without_deleting_current_requests(actors):
    info, ident = ready(actors)
    command = queue(actors.f, ident).json()["command"]
    poll(info["token"])
    poll(info["token"], completed=[receipt(command)])
    ChatDeviceCommand.objects.filter(pk=command["id"]).update(
        completed_at=timezone.now() - timedelta(days=31)
    )
    current = queue(actors.f, ident).json()["command"]
    response = poll(info["token"])
    assert (
        response.status_code == 200
        and response.json()["commands"][0]["id"] == current["id"]
    )
    assert not ChatDeviceCommand.objects.filter(pk=command["id"]).exists()
