"""Selected current chat views stay bounded, scoped, and independently negotiated."""

import json
from copy import deepcopy

import pytest
from test_chat_assistant import actors, call, enable  # noqa: F401
from test_chat_remote import poll, queue, ready, receipt
from test_chat_remote_v2 import AT, REVISION, profile, ready_v2, snapshot_v2
from wealth.chat_models import ChatDevice, ChatDeviceCommand
from wealth.chat_remote import CURRENT_COMMAND_TYPES, MAX_CURRENT_VIEW_BYTES

pytestmark = pytest.mark.django_db


def message():
    return {
        "id": "message_synthetic",
        "revision": "b" * 64,
        "role": "peer",
        "text": "你今天还好吗[拥抱]",
        "kind": "emoji",
        "sentAt": AT,
        "sequence": 1,
        "mediaSummary": "拥抱表情，可能表达安慰或友好。",
        "recognition": {
            "provider": "local",
            "modelName": "wechat-emoji-map-v1",
            "recognizedAt": AT,
        },
        "analysis": {
            "intents": [
                {"label": "关心", "percentage": 80},
                {"label": "询问", "percentage": 20},
            ],
            "affinity": {"score": 55, "confidence": 20},
            "provider": "codex",
            "modelName": "synthetic-text-model",
            "analyzedAt": AT,
        },
        "truncated": False,
    }


def draft():
    return {
        "id": "draft_synthetic",
        "basedOnMessageId": "message_synthetic",
        "text": "还好啊，你呢",
        "label": "自然",
        "reason": "延续当前话题。",
        "createdAt": AT,
        "provider": "codex",
        "modelName": "synthetic-text-model",
        "modelChoiceId": "choice-synthetic",
        "profileVersion": "v1.8",
    }


def current_conversation():
    return {
        "conversationId": "local_synthetic",
        "revision": REVISION,
        "syncedAt": AT,
        "messages": [message()],
        "drafts": [draft()],
        "profile": profile(),
        "profileTruncated": False,
        "wechat": {
            "enabled": True,
            "status": "ready",
            "lastCheckedAt": AT,
            "detail": "已读取最新消息。",
        },
    }


def current_snapshot():
    body = snapshot_v2()
    body["currentView"] = {"syncedAt": AT, "conversations": [current_conversation()]}
    return body


def current_payload(kind):
    body = {"id": "local_synthetic"}
    if kind != "conversation.refresh":
        body.update(messageId="message_synthetic", expectedMessageRevision="b" * 64)
    if kind == "conversation.drafts.generate":
        body["intent"] = "随口关心近况。"
    return body


def ready_current(actors):
    info, ident = ready_v2(actors)
    assert poll(info["token"], current_snapshot()).status_code == 200
    return info, ident


def test_current_selected_view_persists_and_owner_can_read_when_mac_offline(actors):
    _, ident = ready_current(actors)
    result = actors.f.get(f"/api/v1/chat/devices/{ident}/remote")
    assert result.status_code == 200
    assert result["Cache-Control"] == "no-store"
    assert result.json()["snapshot"] == current_snapshot()
    assert ChatDevice.objects.get(pk=ident).remote_snapshot == current_snapshot()
    enable(actors, actors.second)
    enable(actors, actors.admin)
    for client in (actors.s, actors.a):
        assert client.get(f"/api/v1/chat/devices/{ident}/remote").status_code == 404


@pytest.mark.parametrize("kind", sorted(CURRENT_COMMAND_TYPES))
def test_current_actions_scoped_receipt_replay_and_capability_downgrade(actors, kind):
    info, ident = ready_current(actors)
    command = queue(actors.f, ident, kind, current_payload(kind)).json()["command"]
    assert (
        poll(info["token"], current_snapshot()).json()["commands"][0]["id"]
        == command["id"]
    )
    result = {"currentView": current_conversation()}
    ack = receipt(command, result=result)
    assert poll(info["token"], current_snapshot(), [ack]).status_code == 200
    assert poll(info["token"], current_snapshot(), [ack]).status_code == 200
    saved = ChatDeviceCommand.objects.get(pk=command["id"])
    assert saved.status == "succeeded" and saved.result == result
    state = snapshot_v2()
    state["capabilities"]["commandTypes"].remove(kind)
    assert poll(info["token"], state).status_code == 200
    assert (
        queue(actors.f, ident, kind, current_payload(kind)).json()["code"]
        == "remote_capability_required"
    )


@pytest.mark.parametrize("kind", sorted(CURRENT_COMMAND_TYPES))
def test_current_actions_not_available_on_legacy_device(actors, kind):
    _, ident = ready(actors)
    response = queue(actors.f, ident, kind, current_payload(kind))
    assert response.status_code == 409
    assert response.json()["code"] == "remote_capability_required"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda view: view.update(accountFingerprint="private"),
        lambda view: view.update(conversationId="not-selected"),
        lambda view: view["messages"][0].update(
            imageAttachment={"path": "/private/image"}
        ),
        lambda view: view["messages"][0].update(sourceMessageHashes={"id": "secret"}),
        lambda view: view["messages"][0].update(text="data:image/png;base64,private"),
        lambda view: view["messages"][0].update(
            mediaSummary="Bearer synthetic-private-credential"
        ),
        lambda view: view["messages"][0]["recognition"].update(
            modelUrl="https://example.org"
        ),
        lambda view: view["messages"][0]["recognition"].update(apiKey="private"),
        lambda view: view["messages"][0]["analysis"].update(inputDigest="hash"),
        lambda view: view["messages"][0]["analysis"]["affinity"].update(
            evidence=["quote"]
        ),
        lambda view: view["profile"]["basisFacts"][0].update(
            sourceMessageIds=["raw-source-id"]
        ),
        lambda view: view["profile"]["memory"].update(
            compressedMessageHashes={"id": "hash"}
        ),
        lambda view: view["wechat"].update(cursor="database-cursor"),
        lambda view: view["wechat"].update(detail="sk-SYNTHETIC_PRIVATE_KEY_REJECT"),
        lambda view: view["drafts"][0].update(profileDigest="private-digest"),
        lambda view: view["drafts"][0].update(
            basedOnMessageId="other-conversation-message"
        ),
        lambda view: view["messages"][0].update(revision="missing"),
        lambda view: view["messages"][0].update(text="\ud800"),
        lambda view: view["messages"][0].update(sequence=True),
        lambda view: view["messages"][0].update(role="system"),
        lambda view: view["messages"][0]["analysis"].update(
            intents=[{"label": "关心", "percentage": 80}]
        ),
        lambda view: view["messages"][0]["analysis"].update(
            intents=[{"label": "操控", "percentage": 100}]
        ),
        lambda view: view["messages"][0]["analysis"].update(
            intents=[{"label": "关心", "percentage": True}]
        ),
        lambda view: view["messages"].append(deepcopy(view["messages"][0])),
        lambda view: view["drafts"].append(deepcopy(view["drafts"][0])),
        lambda view: view.update(profileTruncated="yes"),
        lambda view: view.update(truncated="yes"),
    ],
)
def test_current_view_rejects_secrets_provenance_invalid_scores_and_cross_scope_atomically(
    actors, mutate
):
    info, ident = ready_current(actors)
    before = ChatDevice.objects.get(pk=ident).last_poll_at
    state = current_snapshot()
    mutate(state["currentView"]["conversations"][0])
    assert poll(info["token"], state).status_code == 422
    row = ChatDevice.objects.get(pk=ident)
    assert row.last_poll_at == before and row.remote_snapshot == current_snapshot()


def test_current_view_byte_limit_counts_utf8_and_does_not_drop_or_partially_store(
    actors,
):
    info, ident = ready_current(actors)
    state = current_snapshot()
    view = state["currentView"]["conversations"][0]
    view["messages"] = []
    view["drafts"] = []
    for index in range(30):
        entry = message()
        entry.update(
            id=f"message_{index}",
            sequence=index + 1,
            text="图" * 2000,
            mediaSummary="图" * 2000,
        )
        view["messages"].append(entry)
    size = len(
        json.dumps(
            state["currentView"], ensure_ascii=False, separators=(",", ":")
        ).encode()
    )
    assert size > MAX_CURRENT_VIEW_BYTES
    assert poll(info["token"], state).status_code == 422
    assert ChatDevice.objects.get(pk=ident).remote_snapshot == current_snapshot()


def test_current_view_cannot_be_sent_using_v1_or_with_remote_management_disabled(
    actors,
):
    info, ident = ready_current(actors)
    state = current_snapshot()
    state["remoteEnabled"] = False
    assert poll(info["token"], state).status_code == 422
    state = current_snapshot()
    state["version"] = 1
    assert poll(info["token"], state).status_code == 422
    state = snapshot_v2()
    state["remoteEnabled"] = False
    assert poll(info["token"], state).status_code == 200
    assert (
        "currentView"
        not in actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()["snapshot"]
    )


def test_get_hides_revoked_and_legacy_paused_chat_snapshots(actors):
    _, ident = ready_current(actors)
    stored = current_snapshot()
    stored["remoteEnabled"] = False
    ChatDevice.objects.filter(pk=ident).update(remote_snapshot=stored)
    result = actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()
    assert result["snapshot"]["remoteEnabled"] is False
    assert "currentView" not in result["snapshot"]
    call(actors.f, f"chat/devices/{ident}", {}, "delete")
    assert (
        actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()["snapshot"] is None
    )


@pytest.mark.parametrize("kind", sorted(CURRENT_COMMAND_TYPES))
@pytest.mark.parametrize(
    "bad", ["wrong-conversation", "raw-message", "missing-revision", "secret"]
)
def test_current_action_payloads_are_strict(actors, kind, bad):
    _, ident = ready_current(actors)
    value = current_payload(kind)
    if bad == "wrong-conversation":
        value["conversationId"] = "other"
    elif bad == "raw-message":
        value["text"] = "raw conversation upload"
    elif bad == "missing-revision":
        if kind == "conversation.refresh":
            value["expectedMessageRevision"] = REVISION
        else:
            del value["expectedMessageRevision"]
    else:
        value["apiKey"] = "private"
    assert queue(actors.f, ident, kind, value).status_code == 422


def test_current_action_receipt_must_contain_requested_contact_and_message(actors):
    info, ident = ready_current(actors)
    kind = "conversation.message.analyze"
    command = queue(actors.f, ident, kind, current_payload(kind)).json()["command"]
    poll(info["token"], current_snapshot())
    wrong = current_conversation()
    wrong["conversationId"] = "other"
    wrong.pop("profile")
    assert (
        poll(
            info["token"],
            current_snapshot(),
            [receipt(command, result={"currentView": wrong})],
        ).status_code
        == 422
    )
    missing = current_conversation()
    missing["messages"] = []
    missing["drafts"] = []
    assert (
        poll(
            info["token"],
            current_snapshot(),
            [receipt(command, result={"currentView": missing})],
        ).status_code
        == 422
    )
    assert ChatDeviceCommand.objects.get(pk=command["id"]).status == "delivered"


def test_current_action_only_targets_selected_synced_contact(actors):
    _, ident = ready_current(actors)
    response = queue(actors.f, ident, "conversation.refresh", {"id": "not-selected"})
    assert response.status_code == 409
    assert response.json()["code"] == "remote_conversation_unavailable"
    assert not ChatDeviceCommand.objects.filter(device_id=ident).exists()


def test_latest_current_receipt_only_is_exposed_and_paused_or_revoked_hides_results(
    actors,
):
    info, ident = ready_current(actors)
    commands = []
    for index in range(2):
        command = queue(
            actors.f,
            ident,
            "conversation.refresh",
            current_payload("conversation.refresh"),
        ).json()["command"]
        poll(info["token"], current_snapshot())
        view = current_conversation()
        view["messages"][0]["text"] = f"当前测试信息 {index}"
        ack = receipt(command, result={"currentView": view})
        assert poll(info["token"], current_snapshot(), [ack]).status_code == 200
        commands.append(command)
    result = actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()
    records = {item["id"]: item for item in result["commands"]}
    assert records[commands[0]["id"]]["result"] == {}
    assert (
        records[commands[1]["id"]]["result"]["currentView"]["messages"][0]["text"]
        == "当前测试信息 1"
    )
    state = snapshot_v2()
    state["remoteEnabled"] = False
    assert poll(info["token"], state).status_code == 200
    assert all(
        not item["result"]
        for item in actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()[
            "commands"
        ]
    )
    # Projection never alters stored receipt bytes required by duplicate acknowledgements.
    assert (
        ChatDeviceCommand.objects.get(pk=commands[0]["id"]).result["currentView"][
            "messages"
        ][0]["text"]
        == "当前测试信息 0"
    )
    call(actors.f, f"chat/devices/{ident}", {}, "delete")
    result = actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()
    assert result["snapshot"] is None
    assert all(not item["result"] for item in result["commands"])


def test_latest_current_receipt_response_has_total_utf8_budget_across_contacts(actors):
    info, ident = ready_v2(actors)
    state = snapshot_v2()
    second = deepcopy(state["conversations"][0])
    second.update(id="second_synthetic", externalId="wxid_second_synthetic")
    state["conversations"].append(second)
    assert poll(info["token"], state).status_code == 200
    for cid in ("local_synthetic", "second_synthetic"):
        command = queue(actors.f, ident, "conversation.refresh", {"id": cid}).json()[
            "command"
        ]
        poll(info["token"], state)
        view = current_conversation()
        view.update(conversationId=cid, messages=[], drafts=[])
        view.pop("profile")
        for index in range(22):
            entry = message()
            entry.update(
                id=f"{cid}_message_{index}", text="文" * 2000, sequence=index + 1
            )
            view["messages"].append(entry)
        assert (
            poll(
                info["token"], state, [receipt(command, result={"currentView": view})]
            ).status_code
            == 200
        )
    response = actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()
    results = [item["result"] for item in response["commands"] if item["result"]]
    assert len(results) == 1
    assert (
        sum(
            len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode())
            for item in results
        )
        <= MAX_CURRENT_VIEW_BYTES
    )


def test_current_message_utf16_limit_preserves_valid_non_bmp_emoji(actors):
    info, _ = ready_current(actors)
    state = current_snapshot()
    state["currentView"]["conversations"][0]["messages"][0]["text"] = "😀" * 1000
    assert poll(info["token"], state).status_code == 200
    state["currentView"]["conversations"][0]["messages"][0]["text"] += "😀"
    assert poll(info["token"], state).status_code == 422


def test_cross_contact_repeated_message_ids_are_rejected(actors):
    info, _ = ready_current(actors)
    state = current_snapshot()
    config = deepcopy(state["conversations"][0])
    config.update(id="other_synthetic", externalId="wxid_other_synthetic")
    state["conversations"].append(config)
    view = current_conversation()
    view["conversationId"] = "other_synthetic"
    view["profile"]["id"] = "other_synthetic"
    state["currentView"]["conversations"].append(view)
    assert poll(info["token"], state).status_code == 422


def test_current_view_marks_history_and_profile_truncation_without_inventing_entries(
    actors,
):
    info, ident = ready_current(actors)
    state = current_snapshot()
    view = state["currentView"]["conversations"][0]
    view.update(truncated=True, profileTruncated=True)
    view["profile"]["basisFacts"] = []
    assert poll(info["token"], state).status_code == 200
    saved = actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()["snapshot"][
        "currentView"
    ]["conversations"][0]
    assert saved["truncated"] is True and saved["profileTruncated"] is True
    assert saved["profile"]["basisFacts"] == []


def test_current_view_displays_explicit_self_message_analysis(actors):
    info, ident = ready_current(actors)
    state = current_snapshot()
    state["currentView"]["conversations"][0]["messages"][0]["role"] = "self"
    assert poll(info["token"], state).status_code == 200
    saved = actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()["snapshot"][
        "currentView"
    ]["conversations"][0]["messages"][0]
    assert saved["role"] == "self"
    assert saved["analysis"]["intents"] == message()["analysis"]["intents"]
