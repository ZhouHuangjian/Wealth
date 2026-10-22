"""Durable chat archives are ordered, resumable, full length, and owner scoped."""

from copy import deepcopy
import importlib
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import Client

from test_chat_assistant import actors, call, device, enable  # noqa: F401
from test_chat_remote import poll, queue, ready, receipt, snapshot
from test_chat_remote_current import current_conversation
from test_chat_remote_v2 import ready_v2, snapshot_v2
from wealth.chat_history import MAX_HISTORY_BYTES
from wealth.chat_remote import CURRENT_COMMAND_TYPES
from wealth.chat_models import (
    ChatDevice,
    ChatHistoryBatch,
    ChatHistoryConversation,
    ChatHistoryMessage,
    ChatHistoryStream,
)

pytestmark = pytest.mark.django_db
CID = "b7e79e07-eac8-458a-a213-2d4df73ee4bc"
CID2 = "d10df686-6250-434e-8e42-ac0edf9dd0a9"
STREAM = "e396e3ce-c3e6-4309-ab04-c778402fe4b2"
AT = "2026-10-15T16:00:00.000Z"


def message(sequence=1, ident=None, text="仅用于合成的完整聊天内容"):
    return {
        "id": ident or str(uuid.uuid4()),
        "revision": "a" * 64,
        "role": "peer",
        "text": text,
        "kind": "text",
        "sentAt": AT,
        "sequence": sequence,
    }


def contact(cid=CID):
    return {
        "type": "conversation.upsert",
        "conversation": {"id": cid, "name": "合成联系人", "note": "合成备注"},
    }


def upsert(value=None, cid=CID):
    return {
        "type": "message.upsert",
        "conversationId": cid,
        "message": value or message(),
    }


def packet(events=None, base=0, stream=STREAM, progress=None):
    values = deepcopy(events if events is not None else [contact(), upsert()])
    for offset, event in enumerate(values, 1):
        event["seq"] = base + offset
    body = {
        "version": 1,
        "streamId": stream,
        "batchId": str(uuid.uuid4()),
        "baseSeq": base,
        "events": values,
    }
    if progress is not None:
        body["progress"] = progress
    return body


def upload(info, body, client=None, **headers):
    return call(
        client or Client(enforce_csrf_checks=True),
        "chat/device/history",
        body,
        HTTP_AUTHORIZATION="Bearer " + info["token"],
        HTTP_IDEMPOTENCY_KEY=body["batchId"],
        **headers,
    )


def read(client, ident, cid=None, **query):
    return client.get(
        f"/api/v1/chat/devices/{ident}/history",
        {**({"conversationId": cid} if cid else {}), **query},
    )


def good(response):
    assert response.status_code == 200, response.content
    return response.json()


def test_full_text_and_derived_results_are_persisted_outside_snapshot(actors):
    info, ident = ready(actors)
    value = message(text="这是完整正文🙂" * 1800)
    value.update(
        mediaSummary="内置拥抱表情说明",
        recognition={
            "provider": "local",
            "modelName": "微信表情解析",
            "recognizedAt": AT,
        },
        analysis={
            "intents": [
                {"label": "关心", "percentage": 80},
                {"label": "询问", "percentage": 20},
            ],
            "affinity": {"score": 55, "confidence": 30},
            "provider": "codex",
            "modelName": "synthetic-text-model",
            "analyzedAt": AT,
        },
    )
    body = packet(
        [contact(), upsert(value)],
        progress={"phase": "live", "totalConversations": 1, "totalMessages": 1},
    )
    ack = good(upload(info, body))
    assert ack["ackSeq"] == 2 and ack["duplicate"] is False
    page = good(read(actors.f, ident, CID))
    assert page["items"] == [value] and len(page["items"][0]["text"]) > 2000
    assert page["total"] == 1 and page["historyRevision"] == 2
    assert (
        page["progress"]["totalMessages"] == 1
        and page["progress"]["expectedMessages"] == 1
    )
    assert page["progress"]["phase"] == "live" and page["progress"]["ackSeq"] == 2
    assert ChatDevice.objects.get(pk=ident).remote_snapshot == snapshot()
    assert ChatHistoryBatch.objects.count() == 1
    assert read(actors.f, ident, CID)["Cache-Control"] == "no-store"
    assert upload(info, body)["Cache-Control"] == "no-store"


def test_identical_batch_retry_is_idempotent_even_after_later_batches(actors):
    info, ident = ready(actors)
    first = packet()
    original = good(upload(info, first))
    next_body = packet([upsert(message(2))], base=2)
    good(upload(info, next_body))
    repeated = good(upload(info, first))
    assert repeated["ackSeq"] == 2 and repeated["duplicate"] is True
    assert repeated["lastSyncedAt"] == original["lastSyncedAt"]
    assert good(read(actors.f, ident, CID))["progress"]["ackSeq"] == 3
    assert (
        ChatHistoryMessage.objects.count() == 2
        and ChatHistoryBatch.objects.count() == 2
    )
    changed = deepcopy(first)
    changed["events"][0]["conversation"]["name"] = "不同合成名称"
    assert upload(info, changed).json()["code"] == "idempotency_conflict"


@pytest.mark.parametrize("stale", [True, False])
def test_full_media_summary_and_stale_analysis_are_retained_explicitly(actors, stale):
    info, ident = ready(actors)
    value = message()
    value.update(
        kind="image",
        mediaSummary="这是识别得到的完整图片说明🙂" * 1200,
        analysis={
            "intents": [{"label": "关心", "percentage": 100}],
            "affinity": None,
            "provider": "codex",
            "modelName": "synthetic-text-model",
            "analyzedAt": AT,
            "stale": stale,
        },
    )
    good(upload(info, packet([contact(), upsert(value)])))
    result = good(read(actors.f, ident, CID))["items"][0]
    assert result == value and len(result["mediaSummary"]) > 2000


@pytest.mark.parametrize("base", [1, 4, 100])
def test_new_batches_must_start_at_exact_ack_sequence(actors, base):
    info, ident = ready(actors)
    good(upload(info, packet()))
    response = upload(info, packet([upsert(message(2))], base=base))
    assert (
        response.status_code == 409
        and response.json()["code"] == "history_sequence_conflict"
    )
    assert good(read(actors.f, ident, CID))["total"] == 1


def test_batch_transaction_rolls_back_earlier_contact_and_stream_on_failure(actors):
    info, _ = ready(actors)
    response = upload(info, packet([contact(), upsert(cid=CID2)]))
    assert (
        response.status_code == 409
        and response.json()["code"] == "history_conversation_required"
    )
    assert not ChatHistoryStream.objects.exists()
    assert (
        not ChatHistoryConversation.objects.exists()
        and not ChatHistoryBatch.objects.exists()
    )


def test_source_stream_cannot_change_inside_existing_binding(actors):
    info, ident = ready(actors)
    good(upload(info, packet()))
    response = upload(info, packet(stream=str(uuid.uuid4())))
    assert (
        response.status_code == 409
        and response.json()["code"] == "history_stream_conflict"
    )
    assert good(read(actors.f, ident, CID))["total"] == 1


def test_message_scope_cannot_move_to_another_contact(actors):
    info, ident = ready(actors)
    value = message()
    good(upload(info, packet([contact(), contact(CID2), upsert(value)])))
    response = upload(info, packet([upsert(value, CID2)], base=3))
    assert (
        response.status_code == 409
        and response.json()["code"] == "history_message_scope_conflict"
    )
    assert good(read(actors.f, ident, CID))["items"] == [value]
    assert good(read(actors.f, ident, CID2))["items"] == []


def test_updates_and_deletes_leave_only_empty_tombstones_and_resume_safely(actors):
    info, ident = ready(actors)
    value = message()
    good(upload(info, packet([contact(), upsert(value)])))
    changed = {**value, "text": "更新后的合成内容", "revision": "b" * 64}
    good(upload(info, packet([upsert(changed)], base=2)))
    assert good(read(actors.f, ident, CID))["items"] == [changed]
    deletion = packet(
        [{"type": "message.delete", "conversationId": CID, "messageId": value["id"]}],
        base=3,
    )
    good(upload(info, deletion))
    good(upload(info, deletion))
    assert good(read(actors.f, ident, CID))["items"] == []
    row = ChatHistoryMessage.objects.get()
    assert row.payload == {} and row.deleted_at is not None
    assert all(not hasattr(item, "payload") for item in ChatHistoryBatch.objects.all())
    good(upload(info, packet([upsert(changed)], base=4)))
    assert good(read(actors.f, ident, CID))["items"] == [changed]
    good(
        upload(
            info,
            packet([{"type": "conversation.delete", "conversationId": CID}], base=5),
        )
    )
    contact_row = ChatHistoryConversation.objects.get()
    row.refresh_from_db()
    assert (
        contact_row.name,
        contact_row.note,
        contact_row.history_progress,
        row.payload,
    ) == ("", "", {}, {})
    assert (
        good(read(actors.f, ident))["items"] == []
        and read(actors.f, ident, CID).status_code == 404
    )
    assert (
        upload(info, packet([upsert(changed)], base=6)).json()["code"]
        == "history_conversation_required"
    )


def test_unknown_delete_creates_small_tombstone_without_visible_message(actors):
    info, ident = ready(actors)
    value = message()
    good(
        upload(
            info,
            packet(
                [
                    contact(),
                    {
                        "type": "message.delete",
                        "conversationId": CID,
                        "messageId": value["id"],
                    },
                ]
            ),
        )
    )
    row = ChatHistoryMessage.objects.get()
    assert row.sequence is None and row.payload == {}
    assert good(read(actors.f, ident, CID))["total"] == 0
    good(upload(info, packet([upsert(value)], base=2)))
    assert good(read(actors.f, ident, CID))["items"] == [value]


def test_directory_has_no_eight_contact_cap_and_progress_never_claims_wechat_total(
    actors,
):
    info, ident = ready(actors)
    ids = [str(uuid.uuid4()) for _ in range(11)]
    events = [contact(cid) for cid in ids]
    events[0]["conversation"]["history"] = {
        "status": "running",
        "scanned": 200,
        "added": 180,
        "lastCheckedAt": AT,
        "detail": "正在分批读取完整历史",
    }
    events[0]["conversation"].update(
        enabled=True,
        autoReplyEnabled=False,
        processing={"intentEnabled": True, "affinityEnabled": False},
    )
    good(
        upload(
            info,
            packet(
                events,
                progress={
                    "phase": "backfill",
                    "totalConversations": 11,
                    "totalMessages": 800,
                },
            ),
        )
    )
    all_rows = []
    before = None
    for _ in range(3):
        page = good(
            read(actors.f, ident, limit=4, **({"before": before} if before else {}))
        )
        assert page["total"] == 11 and page["progress"]["totalConversations"] == 11
        assert (
            page["progress"]["totalMessages"] == 0
            and page["progress"]["expectedMessages"] == 800
        )
        all_rows.extend(page["items"])
        before = page["next_cursor"]
    assert before is None and {item["id"] for item in all_rows} == set(ids)
    entry = next(item for item in all_rows if item["id"] == ids[0])
    assert entry["history"] == events[0]["conversation"]["history"]
    assert entry["enabled"] is True and entry["autoReplyEnabled"] is False
    assert entry["processing"] == {"intentEnabled": True, "affinityEnabled": False}


def test_paginated_full_history_is_complete_and_not_limited_to_thirty_messages(actors):
    info, ident = ready(actors)
    good(upload(info, packet([contact()])))
    all_values = [message(index) for index in range(1, 236)]
    base = 1
    for start in range(0, len(all_values), 100):
        values = all_values[start : start + 100]
        good(upload(info, packet([upsert(value) for value in values], base=base)))
        base += len(values)
    all_rows = []
    before = None
    for _ in range(5):
        page = good(
            read(actors.f, ident, CID, **({"before": before} if before else {}))
        )
        assert page["total"] == 235
        assert [item["sequence"] for item in page["items"]] == sorted(
            item["sequence"] for item in page["items"]
        )
        all_rows = page["items"] + all_rows
        before = page["next_cursor"]
    assert before is None and all_rows == all_values


def test_backfill_reordering_invalidates_cursor_but_content_only_updates_do_not(actors):
    info, ident = ready(actors)
    values = [message(1), message(2), message(3)]
    good(upload(info, packet([contact(), *[upsert(value) for value in values]])))
    first = good(read(actors.f, ident, CID, limit=1))
    cursor = first["next_cursor"]
    changed = {**values[0], "text": "仅变更正文", "revision": "b" * 64}
    good(upload(info, packet([upsert(changed)], base=4)))
    assert read(actors.f, ident, CID, before=cursor).status_code == 200
    moved = {**changed, "sequence": 5}
    good(upload(info, packet([upsert(moved)], base=5)))
    response = read(actors.f, ident, CID, before=cursor)
    assert (
        response.status_code == 409 and response.json()["code"] == "history_page_stale"
    )
    latest = good(read(actors.f, ident, CID))
    assert latest["historyRevision"] == 6 and latest["items"][-1] == moved


def test_new_and_deleted_messages_invalidate_existing_message_page(actors):
    info, ident = ready(actors)
    values = [message(1), message(2)]
    good(upload(info, packet([contact(), *[upsert(value) for value in values]])))
    cursor = good(read(actors.f, ident, CID, limit=1))["next_cursor"]
    good(
        upload(
            info,
            packet(
                [
                    {
                        "type": "message.delete",
                        "conversationId": CID,
                        "messageId": values[1]["id"],
                    }
                ],
                base=3,
            ),
        )
    )
    assert (
        read(actors.f, ident, CID, before=cursor).json()["code"] == "history_page_stale"
    )


def test_tied_message_sequences_have_deterministic_cursor_order(actors):
    info, ident = ready(actors)
    values = [message(10) for _ in range(4)]
    good(upload(info, packet([contact(), *[upsert(value) for value in values]])))
    first = good(read(actors.f, ident, CID, limit=2))
    second = good(read(actors.f, ident, CID, before=first["next_cursor"], limit=2))
    assert second["next_cursor"] is None
    assert [item["id"] for item in second["items"] + first["items"]] == sorted(
        item["id"] for item in values
    )


def test_cursor_is_bound_to_device_stream_and_conversation(actors):
    info, ident = ready(actors)
    good(
        upload(
            info,
            packet([contact(), contact(CID2), upsert(message(1)), upsert(message(2))]),
        )
    )
    cursor = good(read(actors.f, ident, CID, limit=1))["next_cursor"]
    for cid in (CID2, None):
        assert read(actors.f, ident, cid, before=cursor).status_code == 400
    assert read(actors.f, ident, CID, before=cursor[:-5] + "xxxxx").status_code == 400
    other = device(actors, actors.first, actors.f, "另一合成设备")
    good(poll(other["token"]))
    good(upload(other, packet()))
    assert read(actors.f, other["device"]["id"], CID, before=cursor).status_code == 400


@pytest.mark.parametrize(
    "query",
    [
        {"limit": "0"},
        {"limit": "101"},
        {"limit": "-1"},
        {"limit": "1.5"},
        {"cursor": "internal-offset"},
        {"before": "broken"},
    ],
)
def test_invalid_pagination_is_rejected(actors, query):
    info, ident = ready(actors)
    good(upload(info, packet()))
    assert read(actors.f, ident, CID, **query).status_code == 400


def test_session_and_bearer_scopes_are_separate_and_admin_cannot_read_other_owner(
    actors,
):
    info, ident = ready(actors)
    good(upload(info, packet()))
    enable(actors, actors.admin)
    enable(actors, actors.second)
    assert (
        read(actors.a, ident).status_code == 404
        and read(actors.s, ident).status_code == 404
    )
    assert (
        Client()
        .get(
            f"/api/v1/chat/devices/{ident}/history",
            HTTP_AUTHORIZATION="Bearer " + info["token"],
        )
        .status_code
        == 401
    )
    assert call(actors.f, "chat/device/history", packet()).status_code == 401
    assert Client().get("/api/v1/chat/device/history").status_code == 405
    assert call(actors.f, f"chat/devices/{ident}/history").status_code == 405


def test_same_opaque_source_ids_in_other_owner_are_independently_scoped(actors):
    info, ident = ready(actors)
    first_value = message(ident=str(uuid.uuid4()))
    good(upload(info, packet([contact(), upsert(first_value)])))
    other = device(actors, actors.second, actors.s)
    good(poll(other["token"]))
    other_value = {**first_value, "text": "另一个账号的合成正文"}
    good(upload(other, packet([contact(), upsert(other_value)])))
    assert good(read(actors.f, ident, CID))["items"] == [first_value]
    assert good(read(actors.s, other["device"]["id"], CID))["items"] == [other_value]


def test_pause_revoke_and_owner_disable_gate_ingestion_and_read_without_erasing_archive(
    actors,
):
    info, ident = ready(actors)
    good(upload(info, packet()))
    paused = snapshot()
    paused["remoteEnabled"] = False
    good(poll(info["token"], paused))
    assert read(actors.f, ident).json()["code"] == "history_unavailable"
    assert upload(info, packet([upsert(message(2))], base=2)).status_code == 409
    good(poll(info["token"]))
    assert good(read(actors.f, ident, CID))["total"] == 1
    good(
        call(
            actors.a, f"admin/chat/users/{actors.first.pk}", {"enabled": False}, "patch"
        )
    )
    assert (
        read(actors.f, ident).status_code == 403
        and upload(info, packet()).status_code == 403
    )
    enable(actors, actors.first)
    good(call(actors.f, f"chat/devices/{ident}", method="delete"))
    assert (
        read(actors.f, ident).status_code == 409
        and upload(info, packet()).status_code == 401
    )
    assert ChatHistoryMessage.objects.count() == 1


def test_deactivated_account_cannot_upload_even_with_valid_token(actors):
    info, _ = ready(actors)
    get_user_model().objects.filter(pk=actors.first.pk).update(is_active=False)
    assert upload(info, packet()).status_code == 403


def test_legacy_binding_without_remote_enable_is_not_granted_history_implicitly(actors):
    info = device(actors, actors.first, actors.f)
    assert upload(info, packet()).status_code == 409
    assert not ChatHistoryStream.objects.exists()
    good(poll(info["token"]))
    empty = good(read(actors.f, info["device"]["id"]))
    assert empty["items"] == [] and empty["progress"]["phase"] == "unknown"


def test_device_permanent_delete_cascades_history_only_for_that_binding(actors):
    info, ident = ready(actors)
    good(upload(info, packet()))
    other = device(actors, actors.second, actors.s)
    good(poll(other["token"]))
    good(upload(other, packet()))
    good(call(actors.f, f"chat/devices/{ident}/permanent", method="delete"))
    assert (
        ChatHistoryStream.objects.count()
        == ChatHistoryConversation.objects.count()
        == ChatHistoryMessage.objects.count()
        == ChatHistoryBatch.objects.count()
        == 1
    )
    assert good(read(actors.s, other["device"]["id"], CID))["total"] == 1


def test_platform_user_permanent_delete_cleans_new_child_tables_and_other_owner_survives(
    actors,
):
    info, _ = ready(actors)
    good(upload(info, packet()))
    other = device(actors, actors.second, actors.s)
    good(poll(other["token"]))
    good(upload(other, packet()))
    response = call(
        actors.a,
        f"admin/users/{actors.first.pk}",
        {"version": 0, "confirm_username": actors.first.username},
        "delete",
        HTTP_IDEMPOTENCY_KEY="delete-history-owner",
    )
    good(response)
    assert (
        ChatHistoryStream.objects.count()
        == ChatHistoryConversation.objects.count()
        == ChatHistoryMessage.objects.count()
        == ChatHistoryBatch.objects.count()
        == 1
    )
    assert good(read(actors.s, other["device"]["id"], CID))["total"] == 1


def test_cleanup_migration_is_narrow_and_exactly_reversible_without_other_sql_changes():
    migration = importlib.import_module("wealth.migrations.0016_chat_history")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_get_functiondef('public.wealth_delete_platform_user(bigint,bigint,bigint,text)'::regprocedure)"
        )
        definition = cursor.fetchone()[0]
    assert definition.count(migration.HISTORY_CLEANUP + migration.CLEANUP_ANCHOR) == 1
    baseline = definition.replace(migration.HISTORY_CLEANUP, "", 1)
    assert definition == baseline.replace(
        migration.CLEANUP_ANCHOR,
        migration.HISTORY_CLEANUP + migration.CLEANUP_ANCHOR,
        1,
    )
    assert "wealth_purge_workspace" not in migration.HISTORY_CLEANUP


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(version=True),
        lambda p: p.update(streamId="wxid_original"),
        lambda p: p.update(baseSeq=True),
        lambda p: p.update(events=[]),
        lambda p: p["events"][0].update(seq=9),
        lambda p: p["events"][0]["conversation"].update(externalId="wxid_private"),
        lambda p: p["events"][0]["conversation"].update(
            processing={"modelUrl": "https://private.invalid"}
        ),
        lambda p: p["events"][0]["conversation"].update(enabled="true"),
        lambda p: p["events"][1]["message"].update(sourceMessageId="wechat-original"),
        lambda p: p["events"][1]["message"].update(id="wechat-message-raw-id"),
        lambda p: p["events"][1]["message"].update(
            text="sk-synthetic-forbidden-key-123456"
        ),
        lambda p: p["events"][1]["message"].update(
            text="Bearer synthetic-private-value"
        ),
        lambda p: p["events"][1]["message"].update(
            text="wchat_synthetic-private-binding"
        ),
        lambda p: p["events"][1]["message"].update(
            text="data:image/png;base64,private"
        ),
        lambda p: p["events"][1]["message"].update(text="invalid\ud800"),
        lambda p: p["events"][1]["message"].update(
            mediaSummary="Bearer synthetic-private-value"
        ),
        lambda p: p["events"][1]["message"].update(analysis={"stale": "true"}),
        lambda p: p["events"][1]["message"].update(truncated=True),
        lambda p: p["events"][1]["message"].update(sequence=False),
        lambda p: p["events"][1]["message"].update(sentAt="2026-10-15T12:00:00"),
        lambda p: p.update(
            progress={
                "phase": "live",
                "totalConversations": 1,
                "totalMessages": 1,
                "cursor": "private",
            }
        ),
    ],
)
def test_malformed_sensitive_or_truncated_history_is_rejected_atomically(
    actors, mutate
):
    info, _ = ready(actors)
    body = packet()
    mutate(body)
    response = upload(info, body)
    assert response.status_code == 422, response.content
    assert (
        not ChatHistoryStream.objects.exists()
        and not ChatHistoryMessage.objects.exists()
    )
    assert "synthetic-private" not in response.content.decode()


def test_size_event_count_and_idempotency_header_limits(actors):
    info, _ = ready(actors)
    body = packet([contact(), upsert(message(text="x" * MAX_HISTORY_BYTES))])
    assert upload(info, body).status_code == 413
    assert upload(info, packet([contact() for _ in range(101)])).status_code == 422
    valid = packet()
    response = call(
        Client(enforce_csrf_checks=True),
        "chat/device/history",
        valid,
        HTTP_AUTHORIZATION="Bearer " + info["token"],
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert (
        response.status_code == 400
        and response.json()["code"] == "idempotency_required"
    )
    assert not ChatHistoryStream.objects.exists()


@pytest.mark.parametrize("kind", sorted(CURRENT_COMMAND_TYPES))
def test_current_actions_accept_archived_contacts_beyond_current_snapshot(actors, kind):
    info, ident = ready_v2(actors)
    value = message()
    good(upload(info, packet([contact(), upsert(value)])))
    assert CID not in {item["id"] for item in snapshot_v2()["conversations"]}
    payload = {"id": CID}
    if kind != "conversation.refresh":
        payload.update(messageId=value["id"], expectedMessageRevision=value["revision"])
    queued = good(queue(actors.f, ident, kind, payload))["command"]
    delivered = good(poll(info["token"], snapshot_v2()))["commands"][0]
    assert delivered["id"] == queued["id"]
    view = current_conversation()
    view.update(conversationId=CID, messages=[value], drafts=[])
    view["profile"]["id"] = CID
    good(
        poll(
            info["token"],
            snapshot_v2(),
            [receipt(queued, result={"currentView": view})],
        )
    )
    records = actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()["commands"]
    assert records[0]["result"] == {"currentView": view}


def test_archived_contact_does_not_grant_another_device_scope_and_tombstone_wins(
    actors,
):
    info, ident = ready_v2(actors)
    good(upload(info, packet([contact()])))
    other = device(actors, actors.first, actors.f, "其他合成Mac")
    good(poll(other["token"], snapshot_v2()))
    response = queue(
        actors.f, other["device"]["id"], "conversation.refresh", {"id": CID}
    )
    assert (
        response.status_code == 409
        and response.json()["code"] == "remote_conversation_unavailable"
    )
    cached = snapshot_v2()
    cached["conversations"][0]["id"] = CID
    good(poll(info["token"], cached))
    good(
        upload(
            info,
            packet([{"type": "conversation.delete", "conversationId": CID}], base=1),
        )
    )
    response = queue(actors.f, ident, "conversation.refresh", {"id": CID})
    assert (
        response.status_code == 409
        and response.json()["code"] == "remote_conversation_unavailable"
    )
