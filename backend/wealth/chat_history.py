"""Ordered, account-owned chat archives, independent of the current-view cache."""

import uuid
from datetime import datetime

from django.core import signing
from django.db.models import Count, Max, Q
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from .chat import (
    bearer_candidate,
    bounded_limit,
    error_response,
    locked_device,
    read_device_json,
    require_enabled,
    uuid_value,
)
from .chat_models import (
    ChatDevice,
    ChatHistoryBatch,
    ChatHistoryConversation,
    ChatHistoryMessage,
    ChatHistoryStream,
)
from .chat_remote import (
    boolean,
    fields,
    integer,
    safe_text,
    timestamp,
    validate_current_message,
)
from .common import DomainError, digest

MAX_HISTORY_BYTES = 1024 * 1024
MAX_EVENTS = 100
MAX_SEQUENCE = 2**53 - 1
CURSOR_SALT = "wealth.chat.history.v1"


def invalid():
    raise DomainError(
        "聊天历史字段缺失、无效或包含不支持的内容", "invalid_history_payload", 422
    )


def opaque_id(value):
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        invalid()
    if str(parsed) != value:
        invalid()
    return parsed


def history_text(value, maximum, *, blank=True):
    safe_text(value, maximum, blank=blank)
    # Binding credentials are not API model keys, and also must never enter history.
    if "wchat_" in value:
        invalid()


def validate_message(message):
    if not isinstance(message, dict) or "text" not in message:
        invalid()
    history_text(message["text"], MAX_HISTORY_BYTES)
    # Preserve full derived descriptions too; preview limits do not define the archive.
    preview = {**message, "text": ""}
    if "mediaSummary" in message:
        history_text(message["mediaSummary"], MAX_HISTORY_BYTES)
        preview["mediaSummary"] = ""
    if isinstance(message.get("analysis"), dict) and "stale" in message["analysis"]:
        boolean(message["analysis"]["stale"])
        preview["analysis"] = {
            key: value for key, value in message["analysis"].items() if key != "stale"
        }
    # Reuse the strict metadata contract; stale results remain explicitly distinguished.
    validate_current_message(preview)
    opaque_id(message["id"])
    if message.get("truncated") is True:
        invalid()


def validate_history_progress(value):
    fields(
        value,
        {"status", "scanned", "added", "lastCheckedAt", "detail"},
        {"status", "scanned", "added", "lastCheckedAt", "detail"},
    )
    if value["status"] not in ("pending", "running", "complete", "error"):
        invalid()
    integer(value["scanned"], 0, MAX_SEQUENCE)
    integer(value["added"], 0, MAX_SEQUENCE)
    if value["lastCheckedAt"] is not None:
        timestamp(value["lastCheckedAt"])
    history_text(value["detail"], 300)


def validate_packet(body):
    fields(
        body,
        {"version", "streamId", "batchId", "baseSeq", "events", "progress"},
        {"version", "streamId", "batchId", "baseSeq", "events"},
    )
    integer(body["version"], 1, 1)
    opaque_id(body["streamId"])
    opaque_id(body["batchId"])
    integer(body["baseSeq"], 0, MAX_SEQUENCE)
    events = body["events"]
    if not isinstance(events, list) or not 1 <= len(events) <= MAX_EVENTS:
        invalid()
    for offset, event in enumerate(events, 1):
        if not isinstance(event, dict):
            invalid()
        kind = event.get("type")
        keys = {
            "conversation.upsert": {"seq", "type", "conversation"},
            "conversation.delete": {"seq", "type", "conversationId"},
            "message.upsert": {"seq", "type", "conversationId", "message"},
            "message.delete": {"seq", "type", "conversationId", "messageId"},
        }
        if not isinstance(kind, str) or kind not in keys or set(event) != keys[kind]:
            invalid()
        integer(event["seq"], 1, MAX_SEQUENCE)
        if event["seq"] != body["baseSeq"] + offset:
            invalid()
        if kind == "conversation.upsert":
            contact = event["conversation"]
            fields(
                contact,
                {
                    "id",
                    "name",
                    "note",
                    "history",
                    "enabled",
                    "autoReplyEnabled",
                    "processing",
                },
                {"id", "name"},
            )
            opaque_id(contact["id"])
            history_text(contact["name"], 80, blank=False)
            if "note" in contact:
                history_text(contact["note"], 2000)
            if "history" in contact:
                validate_history_progress(contact["history"])
            for flag in ("enabled", "autoReplyEnabled"):
                if flag in contact:
                    boolean(contact[flag])
            if "processing" in contact:
                fields(contact["processing"], {"intentEnabled", "affinityEnabled"})
                for value in contact["processing"].values():
                    boolean(value)
        else:
            opaque_id(event["conversationId"])
            if kind == "message.upsert":
                validate_message(event["message"])
            elif kind == "message.delete":
                opaque_id(event["messageId"])
    if "progress" in body:
        progress = body["progress"]
        fields(
            progress,
            {"phase", "totalConversations", "totalMessages"},
            {"phase", "totalConversations", "totalMessages"},
        )
        if progress["phase"] not in ("backfill", "live"):
            invalid()
        integer(progress["totalConversations"], 0, MAX_SEQUENCE)
        integer(progress["totalMessages"], 0, MAX_SEQUENCE)
    return body


def require_available(device):
    if device.revoked_at or not device.remote_snapshot.get("remoteEnabled"):
        raise DomainError("设备远程管理已暂停或撤销", "history_unavailable", 409)


def contact_for_event(stream, event):
    contact = ChatHistoryConversation.objects.filter(
        stream=stream, conversation_id=event["conversationId"]
    ).first()
    if not contact or contact.deleted_at:
        raise DomainError(
            "请先同步此联系人的目录记录", "history_conversation_required", 409
        )
    return contact


def apply_event(stream, event, now):
    kind, sequence = event["type"], event["seq"]
    if kind == "conversation.upsert":
        value = event["conversation"]
        ChatHistoryConversation.objects.update_or_create(
            stream=stream,
            conversation_id=value["id"],
            defaults={
                "name": value["name"],
                "note": value.get("note", ""),
                "history_progress": value.get("history", {}),
                "display_settings": {
                    key: value[key]
                    for key in ("enabled", "autoReplyEnabled", "processing")
                    if key in value
                },
                "last_event_seq": sequence,
                "deleted_at": None,
            },
        )
    elif kind == "conversation.delete":
        contact, _ = ChatHistoryConversation.objects.update_or_create(
            stream=stream,
            conversation_id=event["conversationId"],
            defaults={
                "name": "",
                "note": "",
                "history_progress": {},
                "display_settings": {},
                "last_event_seq": sequence,
                "deleted_at": now,
            },
        )
        # Retain identifiers/order tombstones only; no deleted text in receipt payloads.
        changed = contact.messages.filter(deleted_at__isnull=True).exists()
        contact.messages.update(
            payload={}, deleted_at=now, last_event_seq=sequence, updated_at=now
        )
        return changed
    else:
        contact = contact_for_event(stream, event)
        message_id = (
            event["message"]["id"] if kind == "message.upsert" else event["messageId"]
        )
        message = ChatHistoryMessage.objects.filter(
            stream=stream, message_id=message_id
        ).first()
        if message and message.conversation_id != contact.pk:
            raise DomainError(
                "消息不能移到另一会话", "history_message_scope_conflict", 409
            )
        if kind == "message.upsert":
            value = event["message"]
            changed = (
                message is None
                or message.deleted_at is not None
                or message.sequence != value["sequence"]
            )
            values = {
                "conversation": contact,
                "sequence": value["sequence"],
                "sent_at": datetime.fromisoformat(
                    value["sentAt"].replace("Z", "+00:00")
                )
                if value["sentAt"]
                else None,
                "payload": value,
                "last_event_seq": sequence,
                "deleted_at": None,
            }
        else:
            changed = message is not None and message.deleted_at is None
            values = {
                "conversation": contact,
                "payload": {},
                "last_event_seq": sequence,
                "deleted_at": now,
            }
        ChatHistoryMessage.objects.update_or_create(
            stream=stream, message_id=message_id, defaults=values
        )
        return changed
    return False


@csrf_exempt
def device_history(request):
    """An atomic, exactly ordered archive batch; browser sessions never authenticate it."""
    try:
        if request.method != "POST":
            raise DomainError("不支持此方法", "method_not_allowed", 405)
        candidate, token_hash = bearer_candidate(request)
        body = validate_packet(read_device_json(request, MAX_HISTORY_BYTES))
        if request.headers.get("Idempotency-Key") != body["batchId"]:
            raise DomainError(
                "Idempotency-Key 须与 batchId 一致", "idempotency_required", 400
            )
        with locked_device(candidate, token_hash) as device:
            require_available(device)
            stream = ChatHistoryStream.objects.filter(device=device).first()
            if stream and str(stream.stream_id) != body["streamId"]:
                raise DomainError(
                    "绑定的微信来源已变化，请重新绑定设备",
                    "history_stream_conflict",
                    409,
                )
            signature = digest(body)
            previous = (
                stream.batches.filter(batch_id=body["batchId"]).first()
                if stream
                else None
            )
            if previous and previous.payload_digest != signature:
                raise DomainError("此批次已用于其他内容", "idempotency_conflict", 409)
            if not previous:
                if body["baseSeq"] != (stream.ack_seq if stream else 0):
                    raise DomainError(
                        "同步顺序已变化，请从已确认的位置继续",
                        "history_sequence_conflict",
                        409,
                    )
                if stream is None:
                    stream = ChatHistoryStream.objects.create(
                        device=device, stream_id=body["streamId"]
                    )
                now = timezone.now()
                changed = False
                for event in body["events"]:
                    changed = apply_event(stream, event, now) or changed
                stream.ack_seq = body["events"][-1]["seq"]
                if changed:
                    stream.history_revision = stream.ack_seq
                stream.last_synced_at = now
                if "progress" in body:
                    stream.phase = body["progress"]["phase"]
                    stream.expected_conversations = body["progress"][
                        "totalConversations"
                    ]
                    stream.expected_messages = body["progress"]["totalMessages"]
                stream.save()
                receipt = ChatHistoryBatch.objects.create(
                    stream=stream,
                    batch_id=body["batchId"],
                    payload_digest=signature,
                    ack_seq=stream.ack_seq,
                )
                device.last_seen_at = now
                device.save(update_fields=["last_seen_at"])
            else:
                receipt = previous
            result = {
                "ok": True,
                "version": 1,
                "streamId": str(stream.stream_id),
                "batchId": body["batchId"],
                "ackSeq": receipt.ack_seq,
                "lastSyncedAt": receipt.received_at,
                "duplicate": previous is not None,
            }
        response = JsonResponse(result)
        response["Cache-Control"] = "no-store"
        return response
    except DomainError as error:
        return error_response(error)


def progress_record(stream):
    return {
        "streamId": str(stream.stream_id) if stream else None,
        "ackSeq": stream.ack_seq if stream else 0,
        "phase": stream.phase if stream else "unknown",
        "totalConversations": stream.conversations.filter(
            deleted_at__isnull=True
        ).count()
        if stream
        else 0,
        "totalMessages": stream.messages.filter(
            deleted_at__isnull=True, conversation__deleted_at__isnull=True
        ).count()
        if stream
        else 0,
        "expectedConversations": stream.expected_conversations if stream else None,
        "expectedMessages": stream.expected_messages if stream else None,
        "lastSyncedAt": stream.last_synced_at if stream else None,
    }


def encode_cursor(device, stream, kind, key):
    return signing.dumps(
        {
            "v": 1,
            "device": str(device.pk),
            "stream": str(stream.stream_id),
            "kind": kind,
            "revision": stream.history_revision if kind.startswith("messages:") else 0,
            "key": key,
        },
        salt=CURSOR_SALT,
        compress=True,
    )


def decode_cursor(raw, device, stream, kind):
    try:
        if not isinstance(raw, str) or len(raw) > 2000:
            raise ValueError()
        value = signing.loads(raw, salt=CURSOR_SALT)
        if (
            not isinstance(value, dict)
            or set(value) != {"v", "device", "stream", "kind", "revision", "key"}
            or value["v"] != 1
            or value["device"] != str(device.pk)
            or value["stream"] != str(stream.stream_id)
            or value["kind"] != kind
            or not isinstance(value["key"], list)
            or len(value["key"]) != 2
        ):
            raise ValueError()
        opaque_id(value["key"][1])
        if (
            kind.startswith("messages:")
            and value["revision"] != stream.history_revision
        ):
            raise DomainError(
                "聊天顺序已更新，请重新加载最近消息", "history_page_stale", 409
            )
        return value["key"]
    except DomainError as error:
        if error.code == "history_page_stale":
            raise
        raise DomainError("分页位置无效或不属于此会话", "invalid_pagination", 400)
    except (signing.BadSignature, TypeError, ValueError):
        raise DomainError("分页位置无效或不属于此会话", "invalid_pagination", 400)


def read_history(request, device_id):
    if request.method != "GET":
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    require_enabled(request.user)
    device = ChatDevice.objects.filter(
        owner=request.user, pk=uuid_value(device_id)
    ).first()
    if not device:
        raise DomainError("设备不存在", "not_found", 404)
    require_available(device)
    if set(request.GET) - {"conversationId", "before", "limit"}:
        raise DomainError("分页参数无效", "invalid_pagination", 400)
    limit = bounded_limit(request)
    stream = ChatHistoryStream.objects.filter(device=device).first()
    conversation_id = request.GET.get("conversationId")
    if conversation_id is not None:
        opaque_id(conversation_id)
    result = {
        "version": 1,
        "device_id": str(device.pk),
        "conversationId": conversation_id,
        "historyRevision": stream.history_revision if stream else 0,
        "items": [],
        "next_cursor": None,
        "total": 0,
        "progress": progress_record(stream),
    }
    if not stream:
        if request.GET.get("before"):
            raise DomainError("分页位置无效", "invalid_pagination", 400)
        return result
    before = request.GET.get("before")
    if conversation_id is not None:
        contact = stream.conversations.filter(
            conversation_id=conversation_id, deleted_at__isnull=True
        ).first()
        if not contact:
            raise DomainError("会话不存在", "not_found", 404)
        query = contact.messages.filter(deleted_at__isnull=True)
        result["total"] = query.count()
        kind = "messages:" + conversation_id
        if before:
            position, ident = decode_cursor(before, device, stream, kind)
            if type(position) is not int or not 1 <= position <= MAX_SEQUENCE:
                raise DomainError("分页位置无效", "invalid_pagination", 400)
            query = query.filter(
                Q(sequence__lt=position) | Q(sequence=position, message_id__lt=ident)
            )
        rows = list(query.order_by("-sequence", "-message_id")[: limit + 1])
        selected = rows[:limit]
        result["items"] = [item.payload for item in reversed(selected)]
        if len(rows) > limit:
            anchor = selected[-1]
            result["next_cursor"] = encode_cursor(
                device, stream, kind, [anchor.sequence, str(anchor.message_id)]
            )
    else:
        query = stream.conversations.filter(deleted_at__isnull=True)
        result["total"] = query.count()
        if before:
            position, ident = decode_cursor(before, device, stream, "contacts")
            try:
                position = datetime.fromisoformat(position)
                if position.utcoffset() is None:
                    raise ValueError()
            except (TypeError, ValueError):
                raise DomainError("分页位置无效", "invalid_pagination", 400)
            query = query.filter(
                Q(created_at__lt=position) | Q(created_at=position, id__lt=ident)
            )
        query = query.annotate(
            message_count=Count(
                "messages", filter=Q(messages__deleted_at__isnull=True)
            ),
            last_sequence=Max(
                "messages__sequence", filter=Q(messages__deleted_at__isnull=True)
            ),
            last_message_at=Max(
                "messages__sent_at", filter=Q(messages__deleted_at__isnull=True)
            ),
        )
        rows = list(query.order_by("-created_at", "-id")[: limit + 1])
        selected = rows[:limit]
        result["items"] = [
            {
                "id": str(item.conversation_id),
                "name": item.name,
                "note": item.note,
                "messageCount": item.message_count,
                "lastMessageAt": item.last_message_at,
                "lastSequence": item.last_sequence,
                "updatedAt": item.updated_at,
                **({"history": item.history_progress} if item.history_progress else {}),
                **item.display_settings,
            }
            for item in selected
        ]
        if len(rows) > limit:
            anchor = selected[-1]
            result["next_cursor"] = encode_cursor(
                device,
                stream,
                "contacts",
                [anchor.created_at.isoformat(), str(anchor.pk)],
            )
    return result
