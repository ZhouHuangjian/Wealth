"""Allowlisted device configuration, delivered only through authenticated polling."""

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
from .chat_models import ChatDevice, ChatDeviceCommand
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
ACTIVE_STATUSES = {"pending", "delivered"}
MAX_POLL_BYTES = 256 * 1024
MAX_COMMAND_BYTES = 8 * 1024
MAX_QUEUED_COMMANDS = 50
COMMAND_TTL = timedelta(minutes=15)
FAILURE_MESSAGE = "本地执行失败，请在 Mac 查看详情。"


def invalid():
    raise DomainError(
        "远程配置字段缺失、无效或包含不支持的内容", "invalid_remote_payload", 422
    )


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


def validate_settings(body, *, full=False):
    fields(body, SETTINGS_FIELDS, SETTINGS_FIELDS if full else ())
    if not body:
        invalid()
    for key, value in body.items():
        if key in {"autoReplyEnabled", "syncDraftsEnabled", "quietHoursEnabled"}:
            boolean(value)
        elif key == "provider":
            if not isinstance(value, str) or value not in {
                "demo",
                "codex",
                "ollama",
                "compatible",
            }:
                invalid()
        elif key == "modelName":
            optional_text(value, 200)
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
    return body


def validate_conversation(body):
    exact_fields(body, CONVERSATION_FIELDS)
    for key in ("id", "externalId"):
        text_field(body[key], 300, identifier=True)
    text_field(body["name"], 80)
    optional_text(body["note"], 2000)
    boolean(body["autoReplyEnabled"])
    boolean(body["enabled"])
    return body


def validate_snapshot(body):
    exact_fields(
        body, {"version", "remoteEnabled", "settings", "conversations", "capabilities"}
    )
    integer(body["version"], 1, 1)
    boolean(body["remoteEnabled"])
    validate_settings(body["settings"], full=True)
    exact_fields(body["capabilities"], {"wechatAvailable", "codexAvailable"})
    for value in body["capabilities"].values():
        boolean(value)
    conversations = body["conversations"]
    if not isinstance(conversations, list) or len(conversations) > 100:
        invalid()
    for item in conversations:
        validate_conversation(item)
    if len({item["id"] for item in conversations}) != len(conversations):
        invalid()
    if len({item["externalId"] for item in conversations}) != len(conversations):
        invalid()
    return body


def validate_payload(kind, body):
    if not isinstance(kind, str) or kind not in COMMAND_TYPES:
        invalid()
    if kind == "settings.patch":
        return validate_settings(body)
    if kind == "contacts.search":
        fields(body, {"query", "limit"}, {"query"})
        text_field(body["query"], 100)
        integer(body.get("limit", 20), 1, 30)
    elif kind == "conversation.add":
        exact_fields(body, {"externalId", "name"})
        text_field(body["externalId"], 300, identifier=True)
        text_field(body["name"], 80)
    else:
        fields(body, {"id", "name", "note", "autoReplyEnabled", "enabled"}, {"id"})
        if len(body) < 2:
            invalid()
        text_field(body["id"], 300, identifier=True)
        if "name" in body:
            text_field(body["name"], 80)
        if "note" in body:
            optional_text(body["note"], 2000)
        for key in ("autoReplyEnabled", "enabled"):
            if key in body:
                boolean(body[key])
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
        if len(request.body) > MAX_COMMAND_BYTES:
            raise DomainError("请求内容超过大小限制", "payload_too_large", 413)
        exact_fields(body, {"type", "payload"})
        validate_payload(body["type"], body["payload"])
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
            return {
                "device_id": str(device.pk),
                "snapshot": device.remote_snapshot or None,
                "last_poll_at": device.last_poll_at,
                "commands": [
                    command_record(item)
                    for item in device.commands.order_by("-created_at", "-id")[:100]
                ],
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
        validate_conversation(result["conversation"])
        key = "externalId" if command.type == "conversation.add" else "id"
        if result["conversation"][key] != command.payload[key]:
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
