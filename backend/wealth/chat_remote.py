"""Allowlisted device controls and bounded current views, authenticated per owner."""

import json
import re
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from .chat import (
    bearer_candidate,
    error_response,
    exact_fields,
    locked_device,
    read_device_json,
    require_enabled,
    text_field,
    uuid_value,
)
from .chat_models import ChatDevice, ChatDeviceCommand, ChatHistoryConversation
from .common import DomainError, digest
from .platform_admin import log_admin

SETTINGS_FIELDS = {
    "provider",
    "modelName",
    "autoReplyEnabled",
    "syncDraftsEnabled",
    "replyDelaySeconds",
    "cooldownSeconds",
    "dailyLimit",
    "quietHoursEnabled",
    "quietStart",
    "quietEnd",
}
SETTINGS_V2_FIELDS = SETTINGS_FIELDS | {
    "replyModels",
    "modelPreset",
    "vision",
    "audio",
    "analysis",
    "memory",
}
PROCESSING_FIELDS = {
    "replyModels",
    "autoRecognizeImages",
    "autoTranscribeVoice",
    "intentEnabled",
    "affinityEnabled",
    "memoryEnabled",
    "autoAnalyzeMessages",
    "autoCompressMemory",
    "analysisModel",
    "memoryModel",
}
CONVERSATION_FIELDS = {
    "id",
    "externalId",
    "name",
    "note",
    "autoReplyEnabled",
    "enabled",
}
COMMAND_TYPES = {
    "settings.patch",
    "contacts.search",
    "conversation.add",
    "conversation.patch",
}
V2_COMMAND_TYPES = {
    "conversation.profile.get",
    "conversation.basis.add",
    "conversation.basis.patch",
    "conversation.basis.delete",
    "conversation.basis.generate",
    "conversation.memory.patch",
    "conversation.memory.entry.add",
    "conversation.memory.entry.patch",
    "conversation.memory.entry.delete",
    "conversation.memory.compress",
}
CURRENT_COMMAND_TYPES = {
    "conversation.refresh",
    "conversation.message.analyze",
    "conversation.message.recognize",
    "conversation.drafts.generate",
}
ALL_COMMAND_TYPES = COMMAND_TYPES | V2_COMMAND_TYPES | CURRENT_COMMAND_TYPES
INTENT_LABELS = {"关心", "质问", "询问", "分享", "邀请", "玩笑", "表达不满", "其他"}
MESSAGE_KINDS = {
    "text",
    "image",
    "voice",
    "emoji",
    "video",
    "file",
    "link",
    "system",
    "unknown",
}
BASIS_CATEGORIES = {
    "current_status",
    "interest",
    "preference",
    "fact",
    "boundary",
    "plan",
}
MEMORY_KINDS = {"fact", "event", "preference", "openTopic"}
ACTIVE_STATUSES = {"pending", "delivered"}
MAX_POLL_BYTES = 1024 * 1024
MAX_COMMAND_BYTES = 8 * 1024
MAX_COMMAND_V2_BYTES = 32 * 1024
MAX_PROFILE_BYTES = 768 * 1024
MAX_CURRENT_VIEW_BYTES = 200 * 1024
MAX_QUEUED_COMMANDS = 50
COMMAND_TTL = timedelta(minutes=15)
FAILURE_MESSAGE = "本地执行失败，请在 Mac 查看详情。"


def invalid():
    raise DomainError(
        "远程配置字段缺失、无效或包含不支持的内容", "invalid_remote_payload", 422
    )


def json_bytes(value):
    try:
        return len(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
    except (TypeError, ValueError, UnicodeEncodeError):
        invalid()


def fields(body, allowed, required=()):
    if (
        not isinstance(body, dict)
        or not set(body) <= set(allowed)
        or not set(required) <= set(body)
    ):
        invalid()


def boolean(value):
    if not isinstance(value, bool):
        invalid()


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        invalid()


def optional_text(value, maximum):
    if not isinstance(value, str) or len(value) > maximum:
        invalid()
    if "\x00" in value or any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        invalid()
    if len(value.encode("utf-16-le")) // 2 > maximum:
        invalid()
    return value


def safe_text(value, maximum, *, blank=True):
    """Profile metadata never carries recognizable credentials or media payloads."""
    optional_text(value, maximum)
    if not blank and not value.strip():
        invalid()
    if re.search(
        r"(?:\bsk-[A-Za-z0-9._-]{10,}|\bBearer\s+\S+|data:(?:image|audio)/)",
        value,
        re.I,
    ):
        invalid()
    return value


def choice(body, *, contact=False):
    fields(
        body,
        {"id", "provider", "modelName", "modelPreset", "label"},
        {"id", "provider", "modelName"},
    )
    if not isinstance(body["id"], str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:-]{0,99}", body["id"]
    ):
        invalid()
    providers = (
        {"compatible", "codex"}
        if contact
        else {"demo", "ollama", "compatible", "codex"}
    )
    if not isinstance(body["provider"], str) or body["provider"] not in providers:
        invalid()
    safe_text(body["modelName"], 200)
    if "modelPreset" in body:
        if not isinstance(body["modelPreset"], str) or body["modelPreset"] not in {
            "custom",
            "qwen",
        }:
            invalid()
    if "label" in body:
        safe_text(body["label"], 80)


def model_choices(value):
    if not isinstance(value, list) or len(value) > 4:
        invalid()
    for item in value:
        choice(item)
    if len({item["id"] for item in value}) != len(value):
        invalid()


def model_selection(value, *, audio=False):
    fields(
        value, {"provider", "modelName", "thinkingEnabled"}, {"provider", "modelName"}
    )
    providers = {"qwen", "compatible", "disabled"} | (set() if audio else {"codex"})
    if not isinstance(value["provider"], str) or value["provider"] not in providers:
        invalid()
    safe_text(value["modelName"], 200)
    if "thinkingEnabled" in value:
        boolean(value["thinkingEnabled"])


def validate_processing(body, *, patch=False):
    fields(body, PROCESSING_FIELDS)
    if patch and not body:
        invalid()
    for key, value in body.items():
        if key == "replyModels":
            if value is not None:
                model_choices(value)
        elif key in {"analysisModel", "memoryModel"}:
            if value is not None:
                choice(value, contact=True)
        else:
            boolean(value)
    return body


def validate_settings(body, *, full=False, version=1):
    allowed = SETTINGS_V2_FIELDS if version == 2 else SETTINGS_FIELDS
    required = SETTINGS_FIELDS if full else set()
    if version == 2:
        allowed = allowed | ({"revision"} if full else {"expectedRevision"})
        if full:
            required = required | {"revision"}
    fields(body, allowed, required)
    if not body:
        invalid()
    for key, value in body.items():
        if key in {
            "autoReplyEnabled",
            "syncDraftsEnabled",
            "quietHoursEnabled",
            "autoRecognizeImages",
            "autoTranscribeVoice",
        }:
            boolean(value)
        elif key == "replyModels":
            model_choices(value)
        elif key in {"vision", "audio", "analysis", "memory"}:
            model_selection(value, audio=key == "audio")
        elif key in {"revision", "expectedRevision"}:
            revision(value)
        elif key == "modelPreset":
            if not isinstance(value, str) or value not in {"custom", "qwen"}:
                invalid()
        elif key == "provider":
            if not isinstance(value, str) or value not in {
                "demo",
                "codex",
                "ollama",
                "compatible",
            }:
                invalid()
        elif key == "modelName":
            (safe_text if version == 2 else optional_text)(value, 200)
        elif key == "replyDelaySeconds":
            integer(value, 1, 300)
        elif key == "cooldownSeconds":
            integer(value, 0, 3600)
        elif key == "dailyLimit":
            integer(value, 1, 200)
        elif not isinstance(value, str) or not re.fullmatch(
            r"(?:[01]\d|2[0-3]):[0-5]\d", value
        ):
            invalid()
    if not full and (
        set(body) <= {"expectedRevision"}
        or (
            set(body) - SETTINGS_FIELDS - {"expectedRevision"}
            and "expectedRevision" not in body
        )
    ):
        invalid()
    return body


def validate_conversation(body, *, version=1):
    extra = (
        {
            "processing",
            "revision",
            "affinity",
            "affinityUpdatedAt",
            "basisCount",
            "memoryCount",
        }
        if version == 2
        else set()
    )
    fields(
        body,
        CONVERSATION_FIELDS | extra,
        CONVERSATION_FIELDS | ({"revision"} if version == 2 else set()),
    )
    for key in ("id", "externalId"):
        text_field(body[key], 300, identifier=True)
    text_field(body["name"], 80)
    optional_text(body["note"], 2000)
    boolean(body["autoReplyEnabled"])
    boolean(body["enabled"])
    if "processing" in body:
        validate_processing(body["processing"])
    if "affinity" in body and body["affinity"] is not None:
        integer(body["affinity"], 0, 100)
    if "revision" in body:
        revision(body["revision"])
    if "affinityUpdatedAt" in body and body["affinityUpdatedAt"] is not None:
        timestamp(body["affinityUpdatedAt"])
    for key in {"basisCount", "memoryCount"} & set(body):
        integer(body[key], 0, 132 if key == "memoryCount" else 100)
    return body


def validate_snapshot(body):
    required = {"version", "remoteEnabled", "settings", "conversations", "capabilities"}
    fields(body, required | {"currentView"}, required)
    integer(body["version"], 1, 2)
    version = body["version"]
    if version == 1 and "currentView" in body:
        invalid()
    boolean(body["remoteEnabled"])
    validate_settings(body["settings"], full=True, version=version)
    capability_fields = {"wechatAvailable", "codexAvailable"} | (
        {"commandTypes"} if version == 2 else set()
    )
    fields(
        body["capabilities"],
        capability_fields | ({"codexModels"} if version == 2 else set()),
        capability_fields,
    )
    for key in ("wechatAvailable", "codexAvailable"):
        boolean(body["capabilities"][key])
    if version == 2:
        types = body["capabilities"]["commandTypes"]
        if (
            not isinstance(types, list)
            or len(types) > len(ALL_COMMAND_TYPES)
            or any(
                not isinstance(item, str) or item not in ALL_COMMAND_TYPES
                for item in types
            )
        ):
            invalid()
        if len(set(types)) != len(types):
            invalid()
        if "codexModels" in body["capabilities"]:
            models = body["capabilities"]["codexModels"]
            if not isinstance(models, list) or len(models) > 100:
                invalid()
            for model in models:
                exact_fields(model, {"id", "label", "inputModalities"})
                safe_text(model["id"], 200, blank=False)
                safe_text(model["label"], 200, blank=False)
                modalities = model["inputModalities"]
                if (
                    not isinstance(modalities, list)
                    or not 1 <= len(modalities) <= 2
                    or any(item not in ("text", "image") for item in modalities)
                    or len(set(modalities)) != len(modalities)
                ):
                    invalid()
            if len({model["id"] for model in models}) != len(models):
                invalid()
    conversations = body["conversations"]
    if not isinstance(conversations, list) or len(conversations) > 100:
        invalid()
    for item in conversations:
        validate_conversation(item, version=version)
    if len({item["id"] for item in conversations}) != len(conversations):
        invalid()
    if len({item["externalId"] for item in conversations}) != len(conversations):
        invalid()
    if "currentView" in body:
        validate_current_view(body["currentView"], conversations=conversations)
        if not body["remoteEnabled"] and body["currentView"]["conversations"]:
            invalid()
    return body


def validate_payload(kind, body, *, version=2):
    if not isinstance(kind, str) or kind not in (
        ALL_COMMAND_TYPES if version == 2 else COMMAND_TYPES
    ):
        invalid()
    if kind == "settings.patch":
        return validate_settings(body, version=version)
    if kind == "contacts.search":
        fields(body, {"query", "limit"}, {"query"})
        text_field(body["query"], 100)
        integer(body.get("limit", 20), 1, 30)
    elif kind == "conversation.add":
        exact_fields(body, {"externalId", "name"})
        text_field(body["externalId"], 300, identifier=True)
        text_field(body["name"], 80)
    elif kind == "conversation.patch":
        fields(
            body,
            {"id", "name", "note", "autoReplyEnabled", "enabled"}
            | ({"processing", "expectedRevision"} if version == 2 else set()),
            {"id"},
        )
        if not set(body) - {"id", "expectedRevision"}:
            invalid()
        text_field(body["id"], 300, identifier=True)
        if "name" in body:
            text_field(body["name"], 80)
        if "note" in body:
            optional_text(body["note"], 2000)
        for key in ("autoReplyEnabled", "enabled"):
            if key in body:
                boolean(body[key])
        if "processing" in body:
            validate_processing(body["processing"], patch=True)
            if "expectedRevision" not in body:
                invalid()
        if "expectedRevision" in body:
            revision(body["expectedRevision"])
    elif kind in CURRENT_COMMAND_TYPES:
        validate_current_payload(kind, body)
    else:
        validate_profile_payload(kind, body)
    return body


def identifier(value):
    text_field(value, 300, identifier=True)


def revision(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        invalid()


def timestamp(value):
    from datetime import datetime

    if not isinstance(value, str) or len(value) > 50:
        invalid()
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            invalid()
    except ValueError:
        invalid()


def basis_values(body, *, patch=False):
    fields(
        body,
        {"category", "content", "sourceNote"},
        () if patch else {"category", "content"},
    )
    if not body:
        invalid()
    if "category" in body and (
        not isinstance(body["category"], str)
        or body["category"] not in BASIS_CATEGORIES
    ):
        invalid()
    if "content" in body:
        safe_text(body["content"], 1000, blank=False)
    if "sourceNote" in body:
        safe_text(body["sourceNote"], 500)


def memory_values(body):
    fields(body, {"summary", "openTopics"})
    if not body:
        invalid()
    if "summary" in body:
        safe_text(body["summary"], 1600)
    if "openTopics" in body:
        topics = body["openTopics"]
        if not isinstance(topics, list) or len(topics) > 10:
            invalid()
        for item in topics:
            safe_text(item, 200, blank=False)


def memory_entry_values(body, *, patch=False):
    fields(
        body,
        {"kind", "text"} | ({"status"} if patch else set()),
        () if patch else {"kind", "text"},
    )
    if not body:
        invalid()
    if "kind" in body and (
        not isinstance(body["kind"], str) or body["kind"] not in MEMORY_KINDS
    ):
        invalid()
    if "text" in body:
        safe_text(body["text"], 600, blank=False)
    if "status" in body and (
        not isinstance(body["status"], str)
        or body["status"] not in {"pending", "approved", "rejected"}
    ):
        invalid()


def validate_profile_payload(kind, body):
    id_only = {
        "conversation.profile.get",
        "conversation.basis.generate",
        "conversation.memory.compress",
    }
    allowed = {"id"}
    required = {"id"}
    values = None
    if kind in {"conversation.basis.add", "conversation.basis.patch"}:
        allowed |= {"category", "content", "sourceNote"}
        values = basis_values
        if kind.endswith("patch"):
            allowed.add("factId")
            required.add("factId")
    elif kind == "conversation.basis.delete":
        allowed.add("factId")
        required.add("factId")
    elif kind == "conversation.memory.patch":
        allowed |= {"summary", "openTopics"}
        values = memory_values
    elif kind in {"conversation.memory.entry.add", "conversation.memory.entry.patch"}:
        allowed |= {"kind", "text"}
        values = memory_entry_values
        if kind.endswith("patch"):
            allowed |= {"entryId", "status"}
            required.add("entryId")
    elif kind == "conversation.memory.entry.delete":
        allowed.add("entryId")
        required.add("entryId")
    elif kind not in id_only:
        invalid()
    if kind not in id_only:
        allowed.add("expectedRevision")
        required.add("expectedRevision")
    fields(body, allowed, required)
    for key in {"id", "factId", "entryId"} & set(body):
        identifier(body[key])
    if "expectedRevision" in body:
        revision(body["expectedRevision"])
    if values:
        attributes = {
            key: value
            for key, value in body.items()
            if key not in {"id", "factId", "entryId", "expectedRevision"}
        }
        if values in {basis_values, memory_entry_values}:
            values(attributes, patch=kind.endswith("patch"))
        else:
            values(attributes)


def requires_v2(kind, body):
    return (
        kind in V2_COMMAND_TYPES | CURRENT_COMMAND_TYPES
        or (kind == "settings.patch" and bool(set(body) - SETTINGS_FIELDS))
        or (
            kind == "conversation.patch"
            and bool(set(body) - {"id", "name", "note", "autoReplyEnabled", "enabled"})
        )
    )


def supports_command(snapshot, kind, body):
    if not requires_v2(kind, body):
        return True
    return snapshot.get("version") == 2 and kind in snapshot.get(
        "capabilities", {}
    ).get("commandTypes", [])


def validate_profile(body):
    if json_bytes(body) > MAX_PROFILE_BYTES:
        invalid()
    exact_fields(body, {"id", "revision", "basisFacts", "memory"})
    identifier(body["id"])
    revision(body["revision"])
    facts = body["basisFacts"]
    if not isinstance(facts, list) or len(facts) > 100:
        invalid()
    for fact in facts:
        exact_fields(
            fact,
            {
                "id",
                "category",
                "content",
                "sourceNote",
                "origin",
                "createdAt",
                "updatedAt",
            },
        )
        identifier(fact["id"])
        basis_values({key: fact[key] for key in {"category", "content", "sourceNote"}})
        if fact["origin"] not in ("manual", "model"):
            invalid()
        timestamp(fact["createdAt"])
        timestamp(fact["updatedAt"])
    if len({fact["id"] for fact in facts}) != len(facts):
        invalid()
    memory = body["memory"]
    if memory is None:
        return body
    fields(
        memory,
        {
            "summary",
            "openTopics",
            "entries",
            "provider",
            "modelName",
            "updatedAt",
            "summaryOrigin",
            "openTopicsOrigin",
        },
        {"summary", "openTopics", "entries", "provider", "modelName", "updatedAt"},
    )
    memory_values({"summary": memory["summary"], "openTopics": memory["openTopics"]})
    if not isinstance(memory["provider"], str) or memory["provider"] not in {
        "qwen",
        "compatible",
        "codex",
        "manual",
    }:
        invalid()
    safe_text(memory["modelName"], 200)
    timestamp(memory["updatedAt"])
    for key in {"summaryOrigin", "openTopicsOrigin"} & set(memory):
        if memory[key] not in ("manual", "model"):
            invalid()
    entries = memory["entries"]
    if not isinstance(entries, list) or len(entries) > 132:
        invalid()
    for entry in entries:
        fields(
            entry,
            {"id", "kind", "text", "status", "origin", "createdAt", "updatedAt"},
            {"id", "kind", "text", "status", "origin", "createdAt"},
        )
        identifier(entry["id"])
        memory_entry_values(
            {key: entry[key] for key in {"kind", "text", "status"}}, patch=True
        )
        if entry["status"] == "rejected":
            invalid()
        if entry["origin"] not in ("manual", "model"):
            invalid()
        timestamp(entry["createdAt"])
        if "updatedAt" in entry:
            timestamp(entry["updatedAt"])
    if len({entry["id"] for entry in entries}) != len(entries):
        invalid()
    return body


def validate_current_payload(kind, body):
    required = {"id"}
    allowed = set(required)
    if kind != "conversation.refresh":
        required |= {"messageId", "expectedMessageRevision"}
        allowed |= required
    if kind == "conversation.drafts.generate":
        allowed.add("intent")
    fields(body, allowed, required)
    identifier(body["id"])
    if "messageId" in body:
        identifier(body["messageId"])
        revision(body["expectedMessageRevision"])
    if "intent" in body:
        safe_text(body["intent"], 300)


def validate_current_analysis(body):
    exact_fields(body, {"intents", "affinity", "provider", "modelName", "analyzedAt"})
    intents = body["intents"]
    if not isinstance(intents, list) or len(intents) > 6:
        invalid()
    for item in intents:
        exact_fields(item, {"label", "percentage"})
        if not isinstance(item["label"], str) or item["label"] not in INTENT_LABELS:
            invalid()
        integer(item["percentage"], 1, 100)
    if len({item["label"] for item in intents}) != len(intents) or (
        intents and sum(item["percentage"] for item in intents) != 100
    ):
        invalid()
    if body["affinity"] is not None:
        exact_fields(body["affinity"], {"score", "confidence"})
        if body["affinity"]["score"] is not None:
            integer(body["affinity"]["score"], 0, 100)
        integer(body["affinity"]["confidence"], 0, 100)
    if not isinstance(body["provider"], str) or body["provider"] not in {
        "qwen",
        "compatible",
        "codex",
    }:
        invalid()
    safe_text(body["modelName"], 200)
    timestamp(body["analyzedAt"])


def validate_current_message(body):
    required = {"id", "revision", "role", "text", "kind", "sentAt", "sequence"}
    fields(
        body,
        required | {"mediaSummary", "recognition", "analysis", "truncated"},
        required,
    )
    identifier(body["id"])
    revision(body["revision"])
    if not isinstance(body["role"], str) or body["role"] not in {
        "self",
        "peer",
        "system",
    }:
        invalid()
    safe_text(body["text"], 2000)
    if not isinstance(body["kind"], str) or body["kind"] not in MESSAGE_KINDS:
        invalid()
    if body["sentAt"] is not None:
        timestamp(body["sentAt"])
    integer(body["sequence"], 1, 2**53 - 1)
    if "mediaSummary" in body:
        safe_text(body["mediaSummary"], 2000)
    if "recognition" in body:
        exact_fields(body["recognition"], {"provider", "modelName", "recognizedAt"})
        item = body["recognition"]
        if not isinstance(item["provider"], str) or item["provider"] not in {
            "local",
            "qwen",
            "compatible",
            "codex",
        }:
            invalid()
        safe_text(item["modelName"], 200)
        timestamp(item["recognizedAt"])
    if "analysis" in body:
        if body["role"] == "system":
            invalid()
        validate_current_analysis(body["analysis"])
    if "truncated" in body:
        boolean(body["truncated"])
    return body


def validate_current_draft(body):
    required = {
        "id",
        "basedOnMessageId",
        "text",
        "label",
        "reason",
        "createdAt",
        "provider",
    }
    fields(body, required | {"modelName", "modelChoiceId", "profileVersion"}, required)
    identifier(body["id"])
    identifier(body["basedOnMessageId"])
    safe_text(body["text"], 2000, blank=False)
    safe_text(body["label"], 80)
    safe_text(body["reason"], 600)
    timestamp(body["createdAt"])
    if not isinstance(body["provider"], str) or body["provider"] not in {
        "demo",
        "ollama",
        "compatible",
        "codex",
    }:
        invalid()
    if "modelName" in body:
        safe_text(body["modelName"], 200)
    if "modelChoiceId" in body:
        identifier(body["modelChoiceId"])
    if "profileVersion" in body and body["profileVersion"] is not None:
        safe_text(body["profileVersion"], 100)
    return body


def validate_current_conversation(body):
    required = {"conversationId", "revision", "syncedAt", "messages", "drafts"}
    fields(
        body,
        required | {"profile", "profileTruncated", "wechat", "truncated"},
        required,
    )
    identifier(body["conversationId"])
    revision(body["revision"])
    timestamp(body["syncedAt"])
    messages, drafts = body["messages"], body["drafts"]
    if not isinstance(messages, list) or len(messages) > 30:
        invalid()
    for item in messages:
        validate_current_message(item)
    message_ids = {item["id"] for item in messages}
    if len(message_ids) != len(messages):
        invalid()
    if not isinstance(drafts, list) or len(drafts) > 12:
        invalid()
    for item in drafts:
        validate_current_draft(item)
        if item["basedOnMessageId"] not in message_ids:
            invalid()
    if len({item["id"] for item in drafts}) != len(drafts):
        invalid()
    if "profile" in body:
        validate_profile(body["profile"])
        if body["profile"]["id"] != body["conversationId"]:
            invalid()
    if "profileTruncated" in body:
        boolean(body["profileTruncated"])
    if "truncated" in body:
        boolean(body["truncated"])
    if "wechat" in body:
        exact_fields(body["wechat"], {"enabled", "status", "lastCheckedAt", "detail"})
        item = body["wechat"]
        boolean(item["enabled"])
        if not isinstance(item["status"], str) or item["status"] not in {
            "paused",
            "reading",
            "ready",
            "error",
        }:
            invalid()
        if item["lastCheckedAt"] is not None:
            timestamp(item["lastCheckedAt"])
        safe_text(item["detail"], 300)
    return body


def validate_current_view(body, *, conversations):
    if json_bytes(body) > MAX_CURRENT_VIEW_BYTES:
        invalid()
    exact_fields(body, {"syncedAt", "conversations"})
    timestamp(body["syncedAt"])
    views = body["conversations"]
    if not isinstance(views, list) or len(views) > 8:
        invalid()
    configured_ids = {item["id"] for item in conversations}
    ids = set()
    message_ids = set()
    draft_ids = set()
    for item in views:
        validate_current_conversation(item)
        if (
            item["conversationId"] not in configured_ids
            or item["conversationId"] in ids
        ):
            invalid()
        ids.add(item["conversationId"])
        local_messages = {message["id"] for message in item["messages"]}
        local_drafts = {draft["id"] for draft in item["drafts"]}
        if local_messages & message_ids or local_drafts & draft_ids:
            invalid()
        message_ids |= local_messages
        draft_ids |= local_drafts
    return body


def command_record(command):
    return {
        "id": str(command.pk),
        "type": command.type,
        "payload": command.payload,
        "status": command.status,
        "created_at": command.created_at,
        "expires_at": command.expires_at,
        "delivered_at": command.delivered_at,
        "completed_at": command.completed_at,
        "result": command.result,
        "error": command.error,
    }


def synced_conversation_ids(device, snapshot):
    """History can outgrow the current-view window; tombstones override old snapshots."""
    ids = {
        item.get("id")
        for item in (snapshot or {}).get("conversations", [])
        if isinstance(item, dict)
    }
    archived = ChatHistoryConversation.objects.filter(
        stream__device=device
    ).values_list("conversation_id", "deleted_at")
    for ident, deleted_at in archived:
        if deleted_at is None:
            ids.add(str(ident))
        else:
            ids.discard(str(ident))
    return ids


def remote_command_records(device, snapshot):
    """Keep status history while exposing only a bounded latest current view."""
    records = []
    current_ids = set()
    remaining = MAX_CURRENT_VIEW_BYTES
    configured_ids = synced_conversation_ids(device, snapshot)
    current_available = bool(snapshot and snapshot.get("remoteEnabled"))
    for command in device.commands.order_by("-created_at", "-id")[:100]:
        record = command_record(command)
        if device.revoked_at:
            record["result"] = {}
        elif command.type in CURRENT_COMMAND_TYPES:
            record["result"] = {}
            if command.status == "succeeded" and current_available:
                try:
                    exact_fields(command.result, {"currentView"})
                    view = validate_current_conversation(command.result["currentView"])
                except DomainError:
                    view = None
                if (
                    view
                    and view["conversationId"] in configured_ids
                    and view["conversationId"] not in current_ids
                ):
                    current_ids.add(view["conversationId"])
                    size = json_bytes(command.result)
                    if len(current_ids) <= 8 and size <= remaining:
                        record["result"] = command.result
                        remaining -= size
        records.append(record)
    return records


def cancel_commands(device):
    device.commands.filter(status__in=ACTIVE_STATUSES).update(
        status="cancelled",
        completed_at=timezone.now(),
        error="设备配置已变更，此请求已取消。",
    )


def expire_commands(device, now):
    device.commands.filter(status__in=ACTIVE_STATUSES, expires_at__lte=now).update(
        status="expired", completed_at=now, error="请求已过期，请重新操作。"
    )


def dispatch_remote(request, device_id, action, body):
    if (action, request.method) not in {("remote", "GET"), ("commands", "POST")}:
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    ident = uuid_value(device_id)
    if action == "commands":
        if len(request.body) > MAX_COMMAND_V2_BYTES:
            raise DomainError("请求内容超过大小限制", "payload_too_large", 413)
        exact_fields(body, {"type", "payload"})
        validate_payload(body["type"], body["payload"])
        if (
            not requires_v2(body["type"], body["payload"])
            and len(request.body) > MAX_COMMAND_BYTES
        ):
            raise DomainError("请求内容超过大小限制", "payload_too_large", 413)
        try:
            request_id = uuid.UUID(request.headers.get("Idempotency-Key", ""))
        except (ValueError, TypeError, AttributeError):
            raise DomainError("Idempotency-Key 须为 UUID", "idempotency_required", 400)
    with transaction.atomic():
        owner = get_user_model().objects.select_for_update().get(pk=request.user.pk)
        require_enabled(owner)
        device = ChatDevice.objects.filter(owner=owner, pk=ident).first()
        if not device:
            raise DomainError("设备不存在", "not_found", 404)
        now = timezone.now()
        expire_commands(device, now)
        if action == "remote":
            snapshot = device.remote_snapshot or None
            if device.revoked_at:
                snapshot = None
            elif (
                snapshot
                and not snapshot.get("remoteEnabled")
                and "currentView" in snapshot
            ):
                snapshot = {
                    key: value
                    for key, value in snapshot.items()
                    if key != "currentView"
                }
            return {
                "device_id": str(device.pk),
                "snapshot": snapshot,
                "last_poll_at": device.last_poll_at,
                "commands": remote_command_records(device, snapshot),
            }
        if device.revoked_at:
            raise DomainError("设备已撤销", "device_revoked", 409)
        previous = device.commands.filter(request_id=request_id).first()
        signature = digest(body)
        if previous:
            if previous.payload_digest != signature:
                raise DomainError(
                    "同一请求标识已用于不同内容", "idempotency_conflict", 409
                )
            return {"command": command_record(previous), "duplicate": True}
        if not device.remote_snapshot.get("remoteEnabled"):
            raise DomainError(
                "请先在 Mac 开启远程管理并等待连接", "remote_unavailable", 409
            )
        if not supports_command(device.remote_snapshot, body["type"], body["payload"]):
            raise DomainError(
                "请先更新并连接 Mac，当前版本不支持此配置。",
                "remote_capability_required",
                409,
            )
        if body["type"] in CURRENT_COMMAND_TYPES and body["payload"][
            "id"
        ] not in synced_conversation_ids(device, device.remote_snapshot):
            raise DomainError(
                "该联系人尚未同步，请先刷新 Mac 连接。",
                "remote_conversation_unavailable",
                409,
            )
        if (
            device.commands.filter(status__in=ACTIVE_STATUSES).count()
            >= MAX_QUEUED_COMMANDS
        ):
            raise DomainError("待执行请求过多，请稍后再试", "remote_queue_full", 409)
        command = ChatDeviceCommand.objects.create(
            device=device,
            request_id=request_id,
            type=body["type"],
            payload=body["payload"],
            payload_digest=signature,
            expires_at=now + COMMAND_TTL,
        )
        # Audit only identifiers/type, never configuration values or contact queries.
        log_admin(
            owner, "chat.device.command.created", command.pk, {"type": command.type}
        )
        return {"command": command_record(command), "duplicate": False}


def validate_receipt(body):
    exact_fields(body, {"id", "status", "result", "error"})
    try:
        ident = uuid.UUID(body["id"])
    except (ValueError, TypeError, AttributeError):
        invalid()
    if body["status"] not in ("succeeded", "failed"):
        invalid()
    if (
        not isinstance(body["result"], dict)
        or not isinstance(body["error"], str)
        or len(body["error"]) > 300
    ):
        invalid()
    if body["status"] == "succeeded" and body["error"]:
        invalid()
    if body["status"] == "failed" and body["result"]:
        invalid()
    return ident


def receipt_result(command, body):
    result = body["result"]
    if body["status"] == "failed":
        return {}, FAILURE_MESSAGE
    if command.type == "contacts.search":
        exact_fields(result, {"contacts", "hasMore"})
        contacts = result["contacts"]
        if not isinstance(contacts, list) or len(contacts) > command.payload.get(
            "limit", 20
        ):
            invalid()
        boolean(result["hasMore"])
        for item in contacts:
            exact_fields(item, {"externalId", "name"})
            text_field(item["externalId"], 300, identifier=True)
            text_field(item["name"], 80)
        if len({item["externalId"] for item in contacts}) != len(contacts):
            invalid()
    elif command.type in {"conversation.add", "conversation.patch"}:
        exact_fields(result, {"conversation"})
        validate_conversation(
            result["conversation"],
            version=2
            if isinstance(result["conversation"], dict)
            and "revision" in result["conversation"]
            else 1,
        )
        key = "externalId" if command.type == "conversation.add" else "id"
        if result["conversation"][key] != command.payload[key]:
            invalid()
    elif command.type in V2_COMMAND_TYPES:
        exact_fields(result, {"profile"})
        validate_profile(result["profile"])
        if result["profile"]["id"] != command.payload["id"]:
            invalid()
    elif command.type in CURRENT_COMMAND_TYPES:
        exact_fields(result, {"currentView"})
        view = result["currentView"]
        if json_bytes(view) > MAX_CURRENT_VIEW_BYTES:
            invalid()
        validate_current_conversation(view)
        if view["conversationId"] != command.payload["id"]:
            invalid()
        if command.type != "conversation.refresh" and command.payload[
            "messageId"
        ] not in {message["id"] for message in view["messages"]}:
            invalid()
    else:
        exact_fields(result, set())
    return result, ""


@csrf_exempt
def device_poll(request):
    """A bearer token may only poll its own queue; browser sessions never suffice."""
    try:
        if request.method != "POST":
            raise DomainError("不支持此方法", "method_not_allowed", 405)
        candidate, token_hash = bearer_candidate(request)
        body = read_device_json(request, MAX_POLL_BYTES)
        exact_fields(body, {"snapshot", "completed"})
        snapshot = validate_snapshot(body["snapshot"])
        receipts = body["completed"]
        if not isinstance(receipts, list) or len(receipts) > 20:
            invalid()
        receipt_ids = [validate_receipt(item) for item in receipts]
        if len(set(receipt_ids)) != len(receipt_ids):
            invalid()
        with locked_device(candidate, token_hash) as device:
            now = timezone.now()
            expire_commands(device, now)
            for ident, receipt in zip(receipt_ids, receipts):
                command = device.commands.filter(pk=ident).first()
                if not command or not command.delivered_at:
                    raise DomainError(
                        "请求回执不存在或尚未下发", "invalid_command_receipt", 409
                    )
                result, error = receipt_result(command, receipt)
                if command.status in {"succeeded", "failed"}:
                    if (command.status, command.result, command.error) != (
                        receipt["status"],
                        result,
                        error,
                    ):
                        raise DomainError(
                            "请求回执与已确认结果冲突", "receipt_conflict", 409
                        )
                    continue
                if command.status == "cancelled":
                    continue
                # A late acknowledgement may confirm a previously delivered request,
                # but expiry never causes the request to be delivered again.
                command.status = receipt["status"]
                command.result, command.error, command.completed_at = result, error, now
                command.save(
                    update_fields=["status", "result", "error", "completed_at"]
                )
            device.remote_snapshot, device.last_poll_at, device.last_seen_at = (
                snapshot,
                now,
                now,
            )
            device.save(
                update_fields=["remote_snapshot", "last_poll_at", "last_seen_at"]
            )
            if not snapshot["remoteEnabled"]:
                cancel_commands(device)
            else:
                # A downgraded/reconfigured client must not receive requests that
                # were queued while it advertised additional capabilities.
                for queued in device.commands.filter(status__in=ACTIVE_STATUSES):
                    if not supports_command(snapshot, queued.type, queued.payload):
                        queued.status, queued.completed_at = "cancelled", now
                        queued.error = "Mac 版本或功能已变化，此请求已取消。"
                        queued.save(update_fields=["status", "completed_at", "error"])
            command = (
                device.commands.filter(status__in=ACTIVE_STATUSES)
                .order_by("created_at", "id")
                .first()
            )
            if command and snapshot["remoteEnabled"]:
                if command.status == "pending":
                    command.status, command.delivered_at = "delivered", now
                    command.save(update_fields=["status", "delivered_at"])
                commands = [command_record(command)]
            else:
                commands = []
            # Keep a bounded retention period for contact-search metadata and receipts.
            device.commands.filter(completed_at__lt=now - timedelta(days=30)).delete()
        response = JsonResponse({"ok": True, "commands": commands, "server_time": now})
        response["Cache-Control"] = "no-store"
        return response
    except DomainError as error:
        return error_response(error)
