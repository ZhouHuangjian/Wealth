"""Session-owned inbox and independently authenticated, draft-only device ingress."""

import hashlib
import json
import re
import secrets
import uuid
from contextlib import contextmanager
from datetime import datetime

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count, F, Max, Q
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from .chat_models import ChatAccess, ChatDevice, ChatDraftBatch
from .chat_credentials import encrypt_device_token, read_device_token
from .common import DomainError, digest
from .platform_admin import is_platform_admin, log_admin, require_admin

User = get_user_model()
MAX_BATCH_BYTES = 32 * 1024
MAX_ACTIVE_DEVICES = 10
TOKEN_PATTERN = re.compile(r"wchat_[A-Za-z0-9_-]{43}\Z")
DATE_PATTERN = re.compile(
    r"\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)\Z"
)
BATCH_FIELDS = {
    "id",
    "conversationKey",
    "conversationName",
    "basedOnMessageId",
    "createdAt",
    "provider",
    "profileVersion",
    "drafts",
}


def enabled(user):
    return (
        user.is_active and ChatAccess.objects.filter(user=user, enabled=True).exists()
    )


def require_enabled(user):
    if not user.is_active:
        raise DomainError("账号已停用", "forbidden", 403)
    if not enabled(user):
        raise DomainError("聊天功能尚未开启，请联系管理员", "chat_disabled", 403)


def text_field(value, maximum, *, identifier=False):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise DomainError("聊天字段为空或超过长度限制", "invalid_chat_payload", 422)
    if "\x00" in value or any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise DomainError("聊天字段包含无效字符", "invalid_chat_payload", 422)
    if len(value.encode("utf-16-le")) // 2 > maximum:
        raise DomainError("聊天字段超过长度限制", "invalid_chat_payload", 422)
    if identifier and re.search(r"[\x00-\x1f\x7f]", value):
        raise DomainError("标识不能包含控制字符", "invalid_chat_payload", 422)
    return value


def exact_fields(body, fields):
    if not isinstance(body, dict) or set(body) != set(fields):
        raise DomainError("请求字段缺失或包含不支持的字段", "invalid_chat_payload", 422)


def validate_batch(body):
    exact_fields(body, BATCH_FIELDS)
    batch_id = text_field(body["id"], 300, identifier=True)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", batch_id):
        raise DomainError("草稿批次标识格式不正确", "invalid_chat_payload", 422)
    text_field(body["conversationKey"], 300, identifier=True)
    text_field(body["conversationName"], 80)
    text_field(body["basedOnMessageId"], 300, identifier=True)
    created = body["createdAt"]
    if (
        not isinstance(created, str)
        or len(created) > 100
        or not DATE_PATTERN.fullmatch(created)
    ):
        raise DomainError(
            "草稿时间须为带时区的 ISO 日期时间", "invalid_chat_payload", 422
        )
    try:
        parsed = datetime.fromisoformat(created.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            raise ValueError()
    except ValueError:
        raise DomainError("草稿时间无效", "invalid_chat_payload", 422)
    if not isinstance(body["provider"], str) or body["provider"] not in {
        "demo",
        "ollama",
        "compatible",
        "codex",
    }:
        raise DomainError("草稿模型来源无效", "invalid_chat_payload", 422)
    if body["profileVersion"] is not None:
        text_field(body["profileVersion"], 32)
    drafts = body["drafts"]
    if not isinstance(drafts, list) or not 1 <= len(drafts) <= 3:
        raise DomainError("每批须包含一至三条草稿", "invalid_chat_payload", 422)
    for draft in drafts:
        exact_fields(draft, {"text", "label", "reason"})
        for field, maximum in (("text", 500), ("label", 40), ("reason", 300)):
            text_field(draft[field], maximum)
    return body


def bounded_limit(request):
    raw = request.GET.get("limit", "50")
    if not re.fullmatch(r"[0-9]{1,3}", raw) or not 1 <= int(raw) <= 100:
        raise DomainError("limit 须为 1–100", "invalid_pagination", 400)
    return int(raw)


def uuid_value(value):
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise DomainError("记录不存在", "not_found", 404)


def device_record(device):
    return {
        "id": device.id,
        "name": device.name,
        "created_at": device.created_at,
        "last_seen_at": device.last_seen_at,
        "revoked_at": device.revoked_at,
        "config_available": read_device_token(device) is not None,
        "draft_count": device.batches.count(),
        "connection_state": "revoked"
        if device.revoked_at
        else "connected"
        if device.last_seen_at
        else "awaiting_connection",
    }


def device_binding(device, token):
    return {
        "device": device_record(device),
        "token": token,
        "upload_path": "/api/v1/chat/ingest",
    }


def restorable_payload(batch):
    try:
        body = validate_batch(batch.payload)
        return body["id"] == batch.batch_id and digest(body) == batch.payload_digest
    except DomainError:
        return False


def batch_record(batch):
    body = batch.payload if restorable_payload(batch) else {}
    return {
        "id": batch.id,
        "device_id": batch.device_id,
        "device_name": batch.device.name,
        "batch_id": batch.batch_id,
        "conversation_key": body.get("conversationKey", ""),
        "conversation_name": body.get("conversationName", "内容已清除的旧草稿"),
        "based_on_message_id": body.get("basedOnMessageId", ""),
        "created_at": body.get("createdAt"),
        "received_at": batch.received_at,
        "provider": body.get("provider", ""),
        "profile_version": body.get("profileVersion"),
        "drafts": body.get("drafts", []),
        "deleted_at": batch.deleted_at,
        "can_restore": batch.deleted_at is not None and bool(body),
    }


def dispatch_chat(request, path, body):
    user = request.user
    if path == "chat/me" and request.method == "GET":
        return {"enabled": enabled(user), "is_admin": is_platform_admin(user)}
    require_enabled(user)
    if path == "chat/devices" and request.method == "GET":
        devices = ChatDevice.objects.filter(owner=user).order_by(
            F("revoked_at").asc(nulls_first=True), "-created_at", "-id"
        )[:100]
        return {"items": [device_record(device) for device in devices]}
    if path == "chat/devices" and request.method == "POST":
        exact_fields(body, {"name"})
        name = text_field(body["name"], 80).strip()
        with transaction.atomic():
            owner = User.objects.select_for_update().get(pk=user.pk)
            require_enabled(owner)
            if (
                ChatDevice.objects.filter(owner=owner, revoked_at__isnull=True).count()
                >= MAX_ACTIVE_DEVICES
            ):
                raise DomainError(
                    "最多绑定十个有效设备，请先撤销旧设备", "device_limit", 409
                )
            token = "wchat_" + secrets.token_urlsafe(32)
            device = ChatDevice(
                owner=owner,
                name=name,
                token_hash=hashlib.sha256(token.encode()).hexdigest(),
            )
            device.token_ciphertext = encrypt_device_token(device, token)
            device.save()
            log_admin(owner, "chat.device.created", device.pk)
        return device_binding(device, token)
    if path.startswith("chat/devices/") and request.method == "POST":
        parts = path.split("/")
        if len(parts) != 4 or parts[3] not in {"config", "rotate"}:
            raise DomainError("接口不存在", "not_found", 404)
        ident = uuid_value(parts[2])
        exact_fields(body, set())
        with transaction.atomic():
            owner = User.objects.select_for_update().get(pk=user.pk)
            require_enabled(owner)
            device = ChatDevice.objects.filter(owner=owner, pk=ident).first()
            if not device:
                raise DomainError("设备不存在", "not_found", 404)
            if device.revoked_at:
                raise DomainError("设备已撤销，请添加新设备", "device_revoked", 409)
            if parts[3] == "config":
                token = read_device_token(device)
                if token is None:
                    raise DomainError(
                        "此设备配置无法再次查看，请重新生成配置",
                        "device_config_unavailable",
                        409,
                    )
                log_admin(owner, "chat.device.config.viewed", device.pk)
            else:
                token = "wchat_" + secrets.token_urlsafe(32)
                device.token_hash = hashlib.sha256(token.encode()).hexdigest()
                device.token_ciphertext = encrypt_device_token(device, token)
                device.last_seen_at = None
                device.save(
                    update_fields=["token_hash", "token_ciphertext", "last_seen_at"]
                )
                log_admin(owner, "chat.device.rotated", device.pk)
        return device_binding(device, token)
    if path.startswith("chat/devices/") and request.method == "DELETE":
        parts = path.split("/")
        if len(parts) not in {3, 4} or (len(parts) == 4 and parts[3] != "permanent"):
            raise DomainError("接口不存在", "not_found", 404)
        ident = uuid_value(parts[2])
        permanent = len(parts) == 4
        with transaction.atomic():
            owner = User.objects.select_for_update().get(pk=user.pk)
            require_enabled(owner)
            device = ChatDevice.objects.filter(owner=owner, pk=ident).first()
            if not device:
                raise DomainError("设备不存在", "not_found", 404)
            if permanent:
                device.delete()
                log_admin(owner, "chat.device.permanently_deleted", ident)
            elif device.revoked_at is None:
                device.revoked_at = timezone.now()
                device.token_ciphertext = ""
                device.save(update_fields=["revoked_at", "token_ciphertext"])
                log_admin(owner, "chat.device.revoked", device.pk)
        return {"ok": True}
    if path == "chat/drafts" and request.method == "GET":
        limit = bounded_limit(request)
        deleted = request.GET.get("deleted", "false")
        if deleted not in {"true", "false"}:
            raise DomainError("deleted 须为 true 或 false", "invalid", 400)
        query = ChatDraftBatch.objects.filter(
            owner=user, deleted_at__isnull=deleted != "true"
        )
        before = request.GET.get("before")
        if before:
            anchor = ChatDraftBatch.objects.filter(
                owner=user, pk=uuid_value(before)
            ).first()
            if not anchor:
                raise DomainError("分页位置不存在", "invalid_pagination", 400)
            query = query.filter(
                Q(received_at__lt=anchor.received_at)
                | Q(received_at=anchor.received_at, id__lt=anchor.id)
            )
        batches = list(
            query.select_related("device").order_by("-received_at", "-id")[: limit + 1]
        )
        return {
            "items": [batch_record(batch) for batch in batches[:limit]],
            "next_cursor": batches[limit - 1].id if len(batches) > limit else None,
        }
    if path.startswith("chat/drafts/") and request.method in {"DELETE", "POST"}:
        parts = path.split("/")
        action = parts[3] if len(parts) == 4 else "trash" if len(parts) == 3 else ""
        if not (
            (request.method == "DELETE" and action in {"trash", "permanent"})
            or (request.method == "POST" and action == "restore")
        ):
            raise DomainError("接口不存在", "not_found", 404)
        ident = uuid_value(parts[2])
        exact_fields(body, set())
        with transaction.atomic():
            owner = User.objects.select_for_update().get(pk=user.pk)
            require_enabled(owner)
            batch = ChatDraftBatch.objects.filter(owner=owner, pk=ident).first()
            if not batch:
                raise DomainError("草稿不存在", "not_found", 404)
            if action == "permanent":
                batch.delete()
                log_admin(owner, "chat.draft.permanently_deleted", ident)
            elif action == "restore":
                if batch.deleted_at is None:
                    raise DomainError("草稿不在回收站", "draft_not_deleted", 409)
                if not restorable_payload(batch):
                    raise DomainError(
                        "旧草稿内容已清除，无法恢复", "draft_unrecoverable", 409
                    )
                batch.deleted_at = None
                batch.save(update_fields=["deleted_at"])
                log_admin(owner, "chat.draft.restored", ident)
            elif batch.deleted_at is None:
                batch.deleted_at = timezone.now()
                batch.save(update_fields=["deleted_at"])
                log_admin(owner, "chat.draft.deleted", ident)
        return {"ok": True}
    if path in {"chat/me", "chat/devices", "chat/drafts"}:
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    raise DomainError("接口不存在", "not_found", 404)


def admin_user_record(user):
    return {
        "id": user.pk,
        "username": user.username,
        "is_active": user.is_active,
        "is_platform_admin": user.is_superuser,
        "enabled": bool(
            getattr(user, "chat_access", None) and user.chat_access.enabled
        ),
        "device_count": user.device_count,
        "last_seen_at": user.last_seen_at,
    }


def dispatch_admin_chat(request, path, body):
    require_admin(request.user)
    if path == "admin/chat/users" and request.method == "GET":
        limit = bounded_limit(request)
        query = (
            User.objects.select_related("chat_access")
            .annotate(
                device_count=Count(
                    "chat_devices", filter=Q(chat_devices__revoked_at__isnull=True)
                ),
                last_seen_at=Max("chat_devices__last_seen_at"),
            )
            .order_by("pk")
        )
        search = request.GET.get("q", "")
        if len(search) > 100:
            raise DomainError("搜索词过长", "invalid", 400)
        if search:
            query = query.filter(username__icontains=search)
        after = request.GET.get("after")
        if after:
            if not re.fullmatch(r"[0-9]{1,18}", after):
                raise DomainError("分页位置无效", "invalid_pagination", 400)
            query = query.filter(pk__gt=int(after))
        users = list(query[: limit + 1])
        return {
            "items": [admin_user_record(user) for user in users[:limit]],
            "next_cursor": users[limit - 1].pk if len(users) > limit else None,
        }
    if path.startswith("admin/chat/users/") and request.method == "PATCH":
        exact_fields(body, {"enabled"})
        if not isinstance(body["enabled"], bool):
            raise DomainError("enabled 须为布尔值", "invalid", 422)
        ident = path.removeprefix("admin/chat/users/")
        if not re.fullmatch(r"[0-9]{1,18}", ident):
            raise DomainError("用户不存在", "not_found", 404)
        with transaction.atomic():
            # Use the same platform lock as administrator/account changes before row locks.
            from django.db import connection

            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_xact_lock(812339402)")
            actor = User.objects.get(pk=request.user.pk)
            require_admin(actor)
            target = User.objects.select_for_update().filter(pk=int(ident)).first()
            if not target:
                raise DomainError("用户不存在", "not_found", 404)
            access, _ = ChatAccess.objects.get_or_create(user=target)
            if access.enabled != body["enabled"]:
                access.enabled = body["enabled"]
                access.save(update_fields=["enabled", "updated_at"])
                log_admin(
                    actor, "chat.access.changed", target.pk, {"enabled": access.enabled}
                )
        return {"id": target.pk, "enabled": access.enabled}
    raise DomainError("接口或方法不存在", "not_found", 404)


def error_response(error):
    return JsonResponse(
        {
            "code": error.code,
            "message": error.message,
            "fields": error.fields,
            "request_id": str(uuid.uuid4()),
        },
        status=error.status,
    )


def bearer_candidate(request):
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ") if auth.startswith("Bearer ") else ""
    if not TOKEN_PATTERN.fullmatch(token):
        raise DomainError("设备凭据无效或已撤销", "invalid_device_token", 401)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    candidate = (
        ChatDevice.objects.filter(token_hash=token_hash, revoked_at__isnull=True)
        .values("id", "owner_id")
        .first()
    )
    if not candidate:
        raise DomainError("设备凭据无效或已撤销", "invalid_device_token", 401)
    return candidate, token_hash


@contextmanager
def locked_device(candidate, token_hash):
    with transaction.atomic():
        owner = (
            User.objects.select_for_update().filter(pk=candidate["owner_id"]).first()
        )
        if not owner:
            raise DomainError("设备凭据无效或已撤销", "invalid_device_token", 401)
        require_enabled(owner)
        device = ChatDevice.objects.filter(
            pk=candidate["id"],
            owner=owner,
            token_hash=token_hash,
            revoked_at__isnull=True,
        ).first()
        if not device:
            raise DomainError("设备凭据无效或已撤销", "invalid_device_token", 401)
        yield device


def read_device_json(request, maximum):
    raw = request.read(maximum + 1)
    if len(raw) > maximum:
        raise DomainError("请求内容超过大小限制", "payload_too_large", 413)
    if request.content_type != "application/json":
        raise DomainError("请求须使用 application/json", "invalid_json", 400)
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise DomainError("请求必须为有效 JSON 对象", "invalid_json", 400)


@csrf_exempt
def device_check(request):
    """Device authentication probe; never accepts a session as authentication."""
    try:
        if request.method != "POST":
            raise DomainError("不支持此方法", "method_not_allowed", 405)
        candidate, token_hash = bearer_candidate(request)
        exact_fields(read_device_json(request, 1024), set())
        with locked_device(candidate, token_hash) as device:
            device.last_seen_at = timezone.now()
            device.save(update_fields=["last_seen_at"])
            result = {
                "ok": True,
                "device": {"id": str(device.pk), "name": device.name},
                "checkedAt": device.last_seen_at.isoformat(),
            }
        response = JsonResponse(result)
        response["Cache-Control"] = "no-store"
        return response
    except DomainError as error:
        return error_response(error)


@csrf_exempt
def ingest(request):
    """Upload by device credential; session cookies grant no access."""
    try:
        if request.method != "POST":
            raise DomainError("不支持此方法", "method_not_allowed", 405)
        candidate, token_hash = bearer_candidate(request)
        body = validate_batch(read_device_json(request, MAX_BATCH_BYTES))
        if request.headers.get("Idempotency-Key") != body["id"]:
            raise DomainError(
                "Idempotency-Key 须与草稿批次 id 一致", "idempotency_required", 400
            )
        with locked_device(candidate, token_hash) as device:
            signature = digest(body)
            previous = ChatDraftBatch.objects.filter(
                device=device, batch_id=body["id"]
            ).first()
            if previous and previous.payload_digest != signature:
                raise DomainError(
                    "同一批次标识已用于不同内容", "idempotency_conflict", 409
                )
            if not previous:
                ChatDraftBatch.objects.create(
                    owner_id=device.owner_id,
                    device=device,
                    batch_id=body["id"],
                    payload=body,
                    payload_digest=signature,
                )
            device.last_seen_at = timezone.now()
            device.save(update_fields=["last_seen_at"])
        response = JsonResponse(
            {"ok": True, "id": body["id"], "duplicate": previous is not None}
        )
        response["Cache-Control"] = "no-store"
        return response
    except DomainError as error:
        return error_response(error)
