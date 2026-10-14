"""The richer remote protocol is opt-in and still cannot carry chats or secrets."""

from copy import deepcopy

import pytest

from test_chat_assistant import actors, enable  # noqa: F401
from test_chat_remote import poll, queue, ready, receipt, snapshot
from wealth.chat_models import ChatDevice, ChatDeviceCommand
from wealth.chat_remote import ALL_COMMAND_TYPES, V2_COMMAND_TYPES

pytestmark = pytest.mark.django_db
REVISION = "a" * 64
AT = "2026-10-14T02:00:00.000Z"


def model():
    return {"provider": "qwen", "modelName": "qwen-synthetic", "thinkingEnabled": False}


def conversation():
    return {
        "id": "local_synthetic",
        "externalId": "wxid_synthetic",
        "name": "测试联系人",
        "note": "",
        "autoReplyEnabled": False,
        "enabled": True,
        "revision": REVISION,
        "processing": {
            "intentEnabled": True,
            "affinityEnabled": False,
            "memoryEnabled": True,
            "autoAnalyzeMessages": False,
            "autoCompressMemory": False,
            "autoRecognizeImages": True,
            "autoTranscribeVoice": False,
            "replyModels": None,
            "analysisModel": None,
            "memoryModel": None,
        },
        "affinity": 52,
        "affinityUpdatedAt": AT,
        "basisCount": 1,
        "memoryCount": 1,
    }


def snapshot_v2():
    body = snapshot()
    body["version"] = 2
    body["settings"].update(
        revision=REVISION,
        modelPreset="qwen",
        replyModels=[],
        vision=model(),
        audio={"provider": "qwen", "modelName": "qwen-audio"},
        analysis=model(),
        memory=model(),
    )
    body["capabilities"]["commandTypes"] = sorted(ALL_COMMAND_TYPES)
    body["conversations"] = [conversation()]
    return body


def profile():
    return {
        "id": "local_synthetic",
        "revision": REVISION,
        "basisFacts": [
            {
                "id": "basis_synthetic",
                "category": "interest",
                "content": "喜欢登山",
                "sourceNote": "用户补充",
                "origin": "manual",
                "createdAt": AT,
                "updatedAt": AT,
            }
        ],
        "memory": {
            "summary": "下周再讨论路线。",
            "openTopics": ["登山路线"],
            "entries": [
                {
                    "id": "memory_synthetic",
                    "kind": "openTopic",
                    "text": "周五确认出发时间",
                    "status": "approved",
                    "origin": "manual",
                    "createdAt": AT,
                    "updatedAt": AT,
                }
            ],
            "provider": "manual",
            "modelName": "",
            "updatedAt": AT,
            "summaryOrigin": "manual",
            "openTopicsOrigin": "manual",
        },
    }


def ready_v2(actors):
    info, ident = ready(actors)
    assert poll(info["token"], snapshot_v2()).status_code == 200
    return info, ident


def payload_for(kind):
    value = {"id": "local_synthetic"}
    if kind not in {
        "conversation.profile.get",
        "conversation.basis.generate",
        "conversation.memory.compress",
    }:
        value["expectedRevision"] = REVISION
    if kind.startswith("conversation.basis."):
        if kind.endswith("add"):
            value.update(category="interest", content="喜欢骑行", sourceNote="用户补充")
        elif kind.endswith("patch"):
            value.update(factId="basis_synthetic", content="喜欢登山")
        elif kind.endswith("delete"):
            value["factId"] = "basis_synthetic"
    if kind == "conversation.memory.patch":
        value.update(summary="下周再讨论。", openTopics=["路线"])
    elif kind.startswith("conversation.memory.entry."):
        if kind.endswith("add"):
            value.update(kind="fact", text="已确认出发日期")
        elif kind.endswith("patch"):
            value.update(entryId="memory_synthetic", text="周五确认", status="approved")
        elif kind.endswith("delete"):
            value["entryId"] = "memory_synthetic"
    return value


def test_v2_snapshot_projects_controls_without_profile_or_raw_evidence(actors):
    _, ident = ready_v2(actors)
    body = actors.f.get(f"/api/v1/chat/devices/{ident}/remote").json()
    assert body["snapshot"] == snapshot_v2()
    assert body["snapshot"]["conversations"][0]["affinity"] == 52
    assert "basisFacts" not in body["snapshot"]["conversations"][0]
    assert "memory" not in body["snapshot"]["conversations"][0]


@pytest.mark.parametrize("kind", sorted(V2_COMMAND_TYPES))
def test_profile_commands_are_negotiated_scoped_and_receipts_projected(actors, kind):
    info, ident = ready_v2(actors)
    command = queue(actors.f, ident, kind, payload_for(kind)).json()["command"]
    delivered = poll(info["token"], snapshot_v2())
    assert delivered.status_code == 200
    assert delivered.json()["commands"][0]["id"] == command["id"]
    result = {"profile": profile()}
    ack = receipt(command, result=result)
    assert poll(info["token"], snapshot_v2(), [ack]).status_code == 200
    assert poll(info["token"], snapshot_v2(), [ack]).status_code == 200
    saved = ChatDeviceCommand.objects.get(pk=command["id"])
    assert saved.status == "succeeded" and saved.result == result
    enable(actors, actors.second)
    enable(actors, actors.admin)
    assert actors.s.get(f"/api/v1/chat/devices/{ident}/remote").status_code == 404
    assert actors.a.get(f"/api/v1/chat/devices/{ident}/remote").status_code == 404


def test_v1_and_missing_capability_cannot_queue_new_commands_or_fields(actors):
    info, ident = ready(actors)
    for kind, body in [
        ("conversation.profile.get", {"id": "local_synthetic"}),
        (
            "conversation.patch",
            {
                "id": "local_synthetic",
                "processing": {"intentEnabled": True},
                "expectedRevision": REVISION,
            },
        ),
        ("settings.patch", {"analysis": model(), "expectedRevision": REVISION}),
    ]:
        assert (
            queue(actors.f, ident, kind, body).json()["code"]
            == "remote_capability_required"
        )
    state = snapshot_v2()
    state["capabilities"]["commandTypes"].remove("conversation.profile.get")
    assert poll(info["token"], state).status_code == 200
    assert (
        queue(
            actors.f, ident, "conversation.profile.get", {"id": "local_synthetic"}
        ).status_code
        == 409
    )
    assert (
        queue(actors.f, ident, "settings.patch", {"replyDelaySeconds": 5}).status_code
        == 200
    )


def test_capability_downgrade_cancels_new_requests_before_delivery_but_keeps_v1(actors):
    info, ident = ready_v2(actors)
    new = queue(
        actors.f, ident, "conversation.profile.get", {"id": "local_synthetic"}
    ).json()["command"]
    old = queue(actors.f, ident).json()["command"]
    body = poll(info["token"], snapshot()).json()
    assert [item["id"] for item in body["commands"]] == [old["id"]]
    assert ChatDeviceCommand.objects.get(pk=new["id"]).status == "cancelled"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: s["settings"].update(apiKey="private"),
        lambda s: s["settings"]["vision"].update(modelUrl="https://example.org"),
        lambda s: s["settings"]["analysis"].update(useReplyApiKey=True),
        lambda s: s["settings"]["memory"].update(allowRemoteModel=True),
        lambda s: s["settings"]["memory"].update(
            modelName="sk-SYNTHETIC_KEY_NEVER_STORE"
        ),
        lambda s: s["conversations"][0].update(messages=["private"]),
        lambda s: s["conversations"][0].update(basisFacts=[]),
        lambda s: s["conversations"][0]["processing"].update(
            analysisModel={
                "id": "x",
                "provider": "compatible",
                "modelName": "qwen",
                "apiKey": "secret",
            }
        ),
        lambda s: s["capabilities"].update(commandTypes=["shell.exec"]),
        lambda s: s["conversations"][0].update(affinity=True),
        lambda s: s["conversations"][0].update(revision="invalid"),
    ],
)
def test_v2_snapshot_rejection_is_atomic_and_secrets_stay_out(actors, mutate):
    info, ident = ready_v2(actors)
    previous = ChatDevice.objects.get(pk=ident).last_poll_at
    state = snapshot_v2()
    mutate(state)
    assert poll(info["token"], state).status_code == 422
    device = ChatDevice.objects.get(pk=ident)
    assert device.last_poll_at == previous and device.remote_snapshot == snapshot_v2()


@pytest.mark.parametrize(
    "kind,body",
    [
        ("settings.patch", {"analysis": model()}),
        ("settings.patch", {"expectedRevision": REVISION}),
        (
            "settings.patch",
            {
                "audio": {"provider": "codex", "modelName": "x"},
                "expectedRevision": REVISION,
            },
        ),
        (
            "settings.patch",
            {
                "vision": {"provider": "qwen", "modelName": "x", "apiKey": "secret"},
                "expectedRevision": REVISION,
            },
        ),
        (
            "settings.patch",
            {
                "replyModels": [
                    {
                        "id": "x",
                        "provider": "compatible",
                        "modelName": "x",
                        "modelUrl": "https://example.org",
                    }
                ],
                "expectedRevision": REVISION,
            },
        ),
        (
            "conversation.patch",
            {"id": "local_synthetic", "processing": {"intentEnabled": True}},
        ),
        (
            "conversation.patch",
            {"id": "local_synthetic", "processing": {}, "expectedRevision": REVISION},
        ),
        (
            "conversation.patch",
            {
                "id": "local_synthetic",
                "processing": {"memoryEnabled": "yes"},
                "expectedRevision": REVISION,
            },
        ),
        (
            "conversation.patch",
            {
                "id": "local_synthetic",
                "processing": {
                    "analysisModel": {"id": "x", "provider": "demo", "modelName": "x"}
                },
                "expectedRevision": REVISION,
            },
        ),
        (
            "conversation.basis.add",
            {"id": "local_synthetic", "category": "interest", "content": "new"},
        ),
        (
            "conversation.basis.add",
            {
                "id": "local_synthetic",
                "category": "interest",
                "content": "Bearer SYNTHETIC_PRIVATE_KEY",
                "expectedRevision": REVISION,
            },
        ),
        (
            "conversation.memory.patch",
            {
                "id": "local_synthetic",
                "summary": "new",
                "sourceMessageIds": ["private"],
                "expectedRevision": REVISION,
            },
        ),
        (
            "conversation.memory.entry.patch",
            {
                "id": "local_synthetic",
                "entryId": "entry",
                "status": "other",
                "expectedRevision": REVISION,
            },
        ),
        (
            "conversation.profile.get",
            {"id": "local_synthetic", "messages": ["private"]},
        ),
        ("conversation.memory.clear", {"id": "local_synthetic"}),
    ],
)
def test_v2_payloads_disallow_secrets_raw_evidence_and_missing_revision(
    actors, kind, body
):
    _, ident = ready_v2(actors)
    assert queue(actors.f, ident, kind, body).status_code == 422
    assert not ChatDeviceCommand.objects.exists()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(id="other_contact"),
        lambda p: p.update(messages=["raw chat"]),
        lambda p: p["basisFacts"][0].update(sourceMessageIds=["private"]),
        lambda p: p["memory"]["entries"][0].update(
            sourceMessageHashes={"private": "hash"}
        ),
        lambda p: p["memory"].update(usage={"totalTokens": 10}),
        lambda p: p["memory"].update(summary="sk-SYNTHETIC_SECRET_NEVER_STORE"),
        lambda p: p["memory"].update(summary="data:image/png;base64,aaaa"),
        lambda p: p["basisFacts"].append(deepcopy(p["basisFacts"][0])),
        lambda p: p["memory"]["entries"].append(deepcopy(p["memory"]["entries"][0])),
        lambda p: p["memory"]["entries"][0].update(createdAt="2026-10-14"),
        lambda p: p["memory"]["entries"][0].update(status="rejected"),
    ],
)
def test_profile_receipt_rejects_sensitive_unrequested_or_duplicate_data_atomically(
    actors, mutate
):
    info, ident = ready_v2(actors)
    command = queue(
        actors.f, ident, "conversation.profile.get", {"id": "local_synthetic"}
    ).json()["command"]
    assert poll(info["token"], snapshot_v2()).status_code == 200
    previous = ChatDevice.objects.get(pk=ident).last_poll_at
    value = profile()
    mutate(value)
    assert (
        poll(
            info["token"], snapshot_v2(), [receipt(command, result={"profile": value})]
        ).status_code
        == 422
    )
    row = ChatDeviceCommand.objects.get(pk=command["id"])
    assert row.status == "delivered" and row.result == {}
    assert ChatDevice.objects.get(pk=ident).last_poll_at == previous


def test_v2_controls_receipt_allows_conversation_projection_and_reset_to_inherited_models(
    actors,
):
    info, ident = ready_v2(actors)
    value = {
        "id": "local_synthetic",
        "expectedRevision": REVISION,
        "processing": {
            "replyModels": None,
            "analysisModel": None,
            "memoryModel": None,
            "autoRecognizeImages": False,
        },
    }
    command = queue(actors.f, ident, "conversation.patch", value).json()["command"]
    assert poll(info["token"], snapshot_v2()).status_code == 200
    assert (
        poll(
            info["token"],
            snapshot_v2(),
            [receipt(command, result={"conversation": conversation()})],
        ).status_code
        == 200
    )


def test_profile_receipt_rechecks_binding_after_auth_lookup_before_persisting(
    actors, monkeypatch
):
    from wealth import chat_remote
    from test_chat_assistant import call

    info, ident = ready_v2(actors)
    command = queue(
        actors.f, ident, "conversation.profile.get", {"id": "local_synthetic"}
    ).json()["command"]
    assert poll(info["token"], snapshot_v2()).status_code == 200
    original = chat_remote.read_device_json

    def read_then_revoke(request, maximum):
        body = original(request, maximum)
        assert (
            call(actors.f, f"chat/devices/{ident}", method="delete").status_code == 200
        )
        return body

    monkeypatch.setattr(chat_remote, "read_device_json", read_then_revoke)
    assert (
        poll(
            info["token"],
            snapshot_v2(),
            [receipt(command, result={"profile": profile()})],
        ).status_code
        == 401
    )
    row = ChatDeviceCommand.objects.get(pk=command["id"])
    assert row.status == "cancelled" and row.result == {}


def test_profile_receipt_batch_rolls_back_if_later_ack_is_not_this_device(actors):
    import uuid

    info, ident = ready_v2(actors)
    command = queue(
        actors.f, ident, "conversation.profile.get", {"id": "local_synthetic"}
    ).json()["command"]
    assert poll(info["token"], snapshot_v2()).status_code == 200
    previous = ChatDevice.objects.get(pk=ident).last_poll_at
    response = poll(
        info["token"],
        snapshot_v2(),
        [
            receipt(command, result={"profile": profile()}),
            receipt({"id": str(uuid.uuid4())}),
        ],
    )
    assert response.status_code == 409
    row = ChatDeviceCommand.objects.get(pk=command["id"])
    assert row.status == "delivered" and row.result == {}
    assert ChatDevice.objects.get(pk=ident).last_poll_at == previous


def test_rich_memory_patch_accepts_full_text_bounds_but_not_unbounded_request_body(
    actors,
):
    import json
    import uuid

    _, ident = ready_v2(actors)
    body = {
        "id": "local_synthetic",
        "expectedRevision": REVISION,
        "summary": "记" * 1600,
        "openTopics": ["事" * 200 for _ in range(10)],
    }
    serialized = json.dumps(
        {"type": "conversation.memory.patch", "payload": body}, ensure_ascii=False
    )
    headers = {
        "HTTP_IDEMPOTENCY_KEY": str(uuid.uuid4()),
        "HTTP_X_CHAT_USER_ID": str(actors.first.pk),
    }
    assert (
        actors.f.post(
            f"/api/v1/chat/devices/{ident}/commands",
            data=serialized,
            content_type="application/json",
            **headers,
        ).status_code
        == 200
    )
    response = actors.f.post(
        f"/api/v1/chat/devices/{ident}/commands",
        data=serialized + " " * (32 * 1024),
        content_type="application/json",
        **headers,
    )
    assert response.status_code == 413


def test_profile_receipts_preserve_132_visible_memories_and_reject_count_overflow(
    actors,
):
    info, ident = ready_v2(actors)
    command = queue(
        actors.f, ident, "conversation.profile.get", {"id": "local_synthetic"}
    ).json()["command"]
    assert poll(info["token"], snapshot_v2()).status_code == 200
    value = profile()
    value["memory"]["entries"] = [
        {**value["memory"]["entries"][0], "id": f"entry_{index}", "text": "忆" * 600}
        for index in range(132)
    ]
    oversized = deepcopy(value)
    oversized["memory"]["entries"].append(
        {**value["memory"]["entries"][0], "id": "entry_overflow"}
    )
    assert (
        poll(
            info["token"],
            snapshot_v2(),
            [receipt(command, result={"profile": oversized})],
        ).status_code
        == 422
    )
    assert (
        poll(
            info["token"], snapshot_v2(), [receipt(command, result={"profile": value})]
        ).status_code
        == 200
    )
    assert (
        len(
            ChatDeviceCommand.objects.get(pk=command["id"]).result["profile"]["memory"][
                "entries"
            ]
        )
        == 132
    )


def test_profile_utf8_budget_is_checked_before_receipt_can_persist(actors):
    import json

    info, ident = ready_v2(actors)
    command = queue(
        actors.f, ident, "conversation.profile.get", {"id": "local_synthetic"}
    ).json()["command"]
    assert poll(info["token"], snapshot_v2()).status_code == 200
    value = profile()
    value["basisFacts"] = [
        {
            **value["basisFacts"][0],
            "id": "基" * 297 + f"{index:03}",
            "content": "记" * 1000,
            "sourceNote": "注" * 500,
        }
        for index in range(100)
    ]
    value["memory"]["entries"] = [
        {
            **value["memory"]["entries"][0],
            "id": "条" * 297 + f"{index:03}",
            "text": "忆" * 600,
        }
        for index in range(132)
    ]
    previous = ChatDevice.objects.get(pk=ident).last_poll_at
    body = json.dumps(
        {
            "snapshot": snapshot_v2(),
            "completed": [receipt(command, result={"profile": value})],
        },
        ensure_ascii=False,
    )
    assert 768 * 1024 < len(body.encode()) < 1024 * 1024
    response = actors.f.post(
        "/api/v1/chat/device/poll",
        data=body,
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + info["token"],
    )
    assert response.status_code == 422
    assert ChatDeviceCommand.objects.get(pk=command["id"]).result == {}
    assert ChatDevice.objects.get(pk=ident).last_poll_at == previous


def test_codex_model_catalog_snapshot_is_explicit_and_versioned(actors):
    info, ident = ready_v2(actors)
    state = snapshot_v2()
    state["capabilities"]["codexModels"] = [
        {"id": "codex-test", "label": "测试模型", "inputModalities": ["text", "image"]}
    ]
    assert poll(info["token"], state).status_code == 200
    assert ChatDevice.objects.get(pk=ident).remote_snapshot == state
    old = snapshot()
    old["capabilities"]["codexModels"] = state["capabilities"]["codexModels"]
    assert poll(info["token"], old).status_code == 422


@pytest.mark.parametrize(
    "model",
    [
        {"id": "test", "label": "test", "inputModalities": ["video"]},
        {
            "id": "test",
            "label": "test",
            "inputModalities": ["text"],
            "apiKey": "private",
        },
        {
            "id": "test",
            "label": "test",
            "inputModalities": ["text"],
            "modelUrl": "https://private.invalid",
        },
        {
            "id": "sk-synthetic-private-secret",
            "label": "test",
            "inputModalities": ["text"],
        },
        {"id": "test", "label": "Bearer private_secret", "inputModalities": ["text"]},
        {"id": "test", "label": "test", "inputModalities": ["text", "text"]},
    ],
)
def test_codex_model_catalog_cannot_carry_private_metadata_or_unknown_modalities(
    actors, model
):
    info, ident = ready_v2(actors)
    previous = ChatDevice.objects.get(pk=ident).last_poll_at
    state = snapshot_v2()
    state["capabilities"]["codexModels"] = [model]
    assert poll(info["token"], state).status_code == 422
    assert ChatDevice.objects.get(pk=ident).last_poll_at == previous
