"""Explicit platform administration, with actor-preserving tenant access and audit."""

import re
import json
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.db import transaction, connection
from django.contrib.sessions.models import Session
from django.utils.crypto import salted_hmac
from django.utils import timezone
from . import models as m
from .common import DomainError, serial, record
from .platform_models import (
    PlatformAudit,
    PlatformCommand,
    PlatformSetting,
    NavigationPreference,
    PlatformUserState,
)

User = get_user_model()
NAV_GROUPS = {
    "main",
    "assets",
    "assets.records",
    "cashbook",
    "planning",
    "planning.goals",
    "planning.cashflow",
    "notebook",
    "notebook.details",
    "analytics",
    "analytics.reports",
    "analytics.allocation",
    "analytics.market",
    "analytics.settlement",
    "investment.trading",
    "settings",
    "admin",
}


def is_platform_admin(user):
    return bool(user.is_authenticated and user.is_active and user.is_superuser)


def require_admin(user):
    if not is_platform_admin(user):
        raise DomainError("仅平台管理员可执行此操作", "forbidden", 403)


def log_admin(actor, action, target="", detail=None):
    return PlatformAudit.objects.create(
        actor=actor,
        actor_label=actor.username,
        actor_reference=actor.pk,
        action=action,
        target=str(target),
        detail=serial(detail or {}),
    )


def expected_version(body, current):
    if "version" not in body:
        raise DomainError("修改需提供记录版本", "version_required", 428)
    if isinstance(body["version"], bool) or str(body["version"]) != str(current):
        raise DomainError("记录已变更，请刷新后重试", "version_conflict", 412)


def platform_command(request, path, body, callback, authorize=None):
    key = request.headers.get("Idempotency-Key", "")
    if not key or len(key) > 160:
        raise DomainError("提交需提供 Idempotency-Key", "idempotency_required", 400)
    with transaction.atomic():
        # Serialize rare platform writes, including competing last-admin changes.
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(812339402)")
        actor = User.objects.select_for_update().get(pk=request.user.pk)
        require_admin(actor)
        if authorize:
            authorize(actor)
        previous = PlatformCommand.objects.filter(
            actor=actor, command=path, key=key
        ).first()
        signature = salted_hmac(
            "wealth.platform.command",
            json.dumps(serial(body), sort_keys=True, separators=(",", ":")),
            algorithm="sha256",
        ).hexdigest()
        if previous:
            if previous.digest != signature:
                raise DomainError(
                    "同一提交标识不能用于不同内容", "idempotency_conflict", 409
                )
            return previous.result
        result = serial(callback(actor))
        PlatformCommand.objects.create(
            actor=actor, command=path, key=key, digest=signature, result=result
        )
        return result


def navigation(request, body):
    if request.method == "GET":
        obj = NavigationPreference.objects.filter(user=request.user).first()
        return {
            "groups": obj.groups if obj else {},
            "version": obj.version if obj else 0,
        }
    if request.method != "PUT":
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    groups = body.get("groups")
    if not isinstance(groups, dict) or any(k not in NAV_GROUPS for k in groups):
        raise DomainError("菜单分组无效")
    cleaned = {}
    for key, value in groups.items():
        if not isinstance(value, dict) or set(value) - {"order", "hidden"}:
            raise DomainError("菜单设置无效")
        cleaned[key] = {}
        for field in ("order", "hidden"):
            items = value.get(field, [])
            if (
                not isinstance(items, list)
                or len(items) > 80
                or any(
                    not isinstance(i, str)
                    or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", i)
                    for i in items
                )
            ):
                raise DomainError("菜单顺序或隐藏列表无效")
            if len(set(items)) != len(items):
                raise DomainError("菜单项不能重复")
            cleaned[key][field] = items
        if key == "main":
            cleaned[key]["hidden"] = [
                i for i in cleaned[key]["hidden"] if i != "settings"
            ]
        if key == "settings":
            cleaned[key]["hidden"] = [
                i for i in cleaned[key]["hidden"] if i != "navigation"
            ]
    with transaction.atomic():
        actor = User.objects.select_for_update().get(pk=request.user.pk)
        if not actor.is_active:
            raise DomainError("账号已停用", "forbidden", 403)
        obj, _ = NavigationPreference.objects.get_or_create(user=request.user)
        expected_version(body, obj.version)
        obj.groups = cleaned
        obj.version += 1
        obj.save()
        return {"groups": obj.groups, "version": obj.version}


def user_record(user):
    state = PlatformUserState.objects.filter(user=user).first()
    return {
        "id": user.pk,
        "username": user.username,
        "email": user.email,
        "is_active": user.is_active,
        "is_platform_admin": user.is_superuser,
        "version": state.version if state else 0,
        "space_count": m.Membership.objects.filter(user=user).count(),
        "date_joined": user.date_joined,
        "last_login": user.last_login,
    }


def space_record(space):
    return dict(
        record(space),
        version=space.revision,
        can_delegate=bool(space.admin_access_enabled and not space.deleted_at),
        members=[
            {
                "id": row.pk,
                "user_id": row.user_id,
                "username": row.user.username,
                "role": row.role,
            }
            for row in m.Membership.objects.filter(workspace=space)
            .select_related("user")
            .order_by("pk")
        ],
    )


def list_page(request, qs, fn):
    offset = max(0, int(request.GET.get("offset", 0)))
    limit = min(200, max(1, int(request.GET.get("limit", 100))))
    return {
        "items": [fn(item) for item in qs[offset : offset + limit]],
        "count": qs.count(),
        "offset": offset,
        "limit": limit,
        "has_more": offset + limit < qs.count(),
    }


def checked_user_name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 100:
        raise DomainError("用户名长度须为 1–100 个字符")
    return value.strip()


def revoke_sessions(user):
    for session in Session.objects.filter(expire_date__gt=timezone.now()).iterator():
        if str(session.get_decoded().get("_auth_user_id")) == str(user.pk):
            session.delete()


def user_write(actor, ident, action, method, body):
    require_admin(actor)
    if ident is None:
        if method != "POST" or action:
            raise DomainError("不支持此方法", "method_not_allowed", 405)
        username = checked_user_name(body.get("username", ""))
        administrator = body.get("is_platform_admin", False)
        if not isinstance(administrator, bool):
            raise DomainError("账号类型必须为布尔值")
        if administrator and body.get("space_name"):
            raise DomainError("管理员账号不能拥有个人账簿空间")
        validate_password(body.get("password", ""))
        if User.objects.filter(username=username).exists():
            raise DomainError("用户名不可用")
        user = User.objects.create_user(
            username=username,
            email=str(body.get("email", ""))[:254],
            password=body["password"],
            is_superuser=administrator,
            is_staff=administrator,
        )
        PlatformUserState.objects.create(user=user, version=1)
        if body.get("space_name"):
            space = m.Workspace.objects.create(
                name=str(body["space_name"]).strip()[:100]
            )
            m.Membership.objects.create(workspace=space, user=user, role="owner")
        log_admin(actor, "user.created", user.pk, {"username": user.username})
        return user_record(user)
    user = User.objects.select_for_update().filter(pk=ident).first()
    if not user:
        raise DomainError("用户不存在", "not_found", 404)
    state, _ = PlatformUserState.objects.get_or_create(user=user)
    expected_version(body, state.version)
    if action is None and method == "DELETE":
        from .platform_cleanup import delete_user

        return delete_user(actor, user, body)
    if action == "password" and method == "POST":
        if user.pk == actor.pk:
            raise DomainError("修改自己的密码请使用个人密码设置并验证原密码")
        validate_password(body.get("password", ""), user)
        user.set_password(body["password"])
        user.save(update_fields=["password"])
        revoke_sessions(user)
        log_admin(actor, "user.password_reset", user.pk)
    elif action is None and method == "PATCH":
        if set(body) - {
            "version",
            "username",
            "email",
            "is_active",
            "is_platform_admin",
        }:
            raise DomainError(
                "仅能修改用户名、邮箱和账号状态；身份标识等内部字段不可修改"
            )
        for field in ("is_active", "is_platform_admin"):
            if field in body and not isinstance(body[field], bool):
                raise DomainError("账号状态必须为布尔值")
        next_active = body.get("is_active", user.is_active)
        next_admin = body.get("is_platform_admin", user.is_superuser)
        if next_admin != user.is_superuser:
            raise DomainError(
                "管理员和普通用户为独立账号类型，不能互相转换；请创建对应类型的新账号"
            )
        if user.pk == actor.pk and (not next_active or not next_admin):
            raise DomainError("不能停用或降级当前登录的管理员")
        if user.is_active and user.is_superuser and (not next_active or not next_admin):
            if (
                not User.objects.filter(is_active=True, is_superuser=True)
                .exclude(pk=user.pk)
                .exists()
            ):
                raise DomainError("必须保留至少一位可用的平台管理员")
        old = {
            "username": user.username,
            "email": user.email,
            "is_active": user.is_active,
            "is_platform_admin": user.is_superuser,
        }
        user.username = checked_user_name(body.get("username", user.username))
        if User.objects.exclude(pk=user.pk).filter(username=user.username).exists():
            raise DomainError("用户名不可用")
        user.email = str(body.get("email", user.email))[:254]
        user.is_active, user.is_superuser, user.is_staff = (
            next_active,
            next_admin,
            next_admin,
        )
        user.save(
            update_fields=["username", "email", "is_active", "is_superuser", "is_staff"]
        )
        if not next_active:
            revoke_sessions(user)
        log_admin(
            actor,
            "user.updated",
            user.pk,
            {
                "before": old,
                "after": {
                    "username": user.username,
                    "email": user.email,
                    "is_active": next_active,
                    "is_platform_admin": next_admin,
                },
            },
        )
    else:
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    state.version += 1
    state.save(update_fields=["version"])
    return user_record(user)


def space_write(actor, ident, method, body):
    require_admin(actor)
    if ident is None and method == "POST":
        name = str(body.get("name", "")).strip()
        owner = User.objects.filter(
            pk=body.get("owner_user_id"), is_active=True, is_superuser=False
        ).first()
        currency = body.get("base_currency", "CNY")
        if (
            not name
            or len(name) > 100
            or not owner
            or currency not in {"CNY", "USD", "HKD"}
        ):
            raise DomainError("请填写账簿名、有效的所有者及币种")
        space = m.Workspace.objects.create(name=name, base_currency=currency)
        m.Membership.objects.create(workspace=space, user=owner, role="owner")
        log_admin(actor, "space.created", space.pk, {"owner_user_id": owner.pk})
        return space_record(space)
    if ident and method == "PATCH":
        from .workspace_management import update_workspace_details

        space = (
            m.Workspace.objects.select_for_update()
            .filter(pk=ident, deleted_at__isnull=True)
            .first()
        )
        if not space:
            raise DomainError("账簿不存在", "not_found", 404)
        space = update_workspace_details(space, actor, body)
        return space_record(space)
    raise DomainError("不支持删除账簿，请管理其成员和配置", "method_not_allowed", 405)


def dispatch_admin(request, path, body):
    require_admin(request.user)
    resource = path[0] if path else ""
    ident = path[1] if len(path) > 1 else None
    action = path[2] if len(path) > 2 else None
    if len(path) > 3:
        raise DomainError("接口不存在", "not_found", 404)
    if request.method == "GET":
        if resource == "users" and not ident:
            qs = User.objects.order_by("id")
            if request.GET.get("q"):
                qs = qs.filter(username__icontains=request.GET["q"][:100])
            return list_page(request, qs, user_record)
        if resource == "spaces" and not ident:
            qs = m.Workspace.objects.filter(
                deleted_at__isnull=request.GET.get("deleted") != "true"
            ).order_by("created_at")
            if request.GET.get("user_id"):
                qs = qs.filter(membership__user_id=request.GET["user_id"])
            if request.GET.get("q"):
                qs = qs.filter(name__icontains=request.GET["q"][:100])
            return list_page(request, qs, space_record)
        if resource == "spaces" and ident and not action:
            space = m.Workspace.objects.filter(pk=ident).first()
            if not space:
                raise DomainError("空间不存在", "not_found", 404)
            return dict(
                space_record(space),
                users=[
                    user_record(member.user)
                    for member in m.Membership.objects.filter(workspace=space)
                    .select_related("user")
                    .order_by("pk")
                ],
                role="owner",
                administration=True,
                membership_role=None,
            )
        if resource == "glossary" and not ident:
            from .glossary import read_glossary

            return read_glossary()
        if resource == "configuration-templates":
            from .configuration_templates import (
                snapshot,
                template_record,
                available_templates,
            )

            if ident == "preview":
                result = snapshot(
                    request.GET.get("user_id"),
                    request.GET.get("space_id"),
                    actor=request.user,
                )
                log_admin(
                    request.user,
                    "configuration_template.preview",
                    request.GET.get("space_id", ""),
                )
                return result
            if not ident:
                return list_page(
                    request,
                    available_templates().order_by("-created_at"),
                    lambda x: template_record(x, True),
                )
        if resource == "audit" and not ident:
            return list_page(
                request,
                PlatformAudit.objects.select_related("actor").order_by("-created_at"),
                lambda a: {
                    "id": str(a.pk),
                    "actor_id": a.actor_id,
                    "actor_name": a.actor.username
                    if a.actor
                    else a.actor_label or "已删除的管理员",
                    "actor_reference": a.actor_reference,
                    "action": a.action,
                    "target": a.target,
                    "detail": audit_detail(a),
                    "created_at": a.created_at,
                },
            )
        if resource == "data-sources" and not ident:
            from .provider_policy import get_provider_config, provider_directory

            obj = PlatformSetting.objects.filter(pk="market_sources").first()
            return {
                "version": obj.version if obj else 0,
                "config": get_provider_config(),
                "providers": provider_directory(),
            }
        raise DomainError("接口不存在", "not_found", 404)

    def save(actor):
        if resource == "glossary" and not ident and request.method == "PUT":
            from .glossary import write_glossary

            return write_glossary(actor, body)
        if resource == "configuration-templates" and not action:
            from .configuration_templates import admin_write

            return admin_write(actor, ident, request.method, body)
        if resource == "users":
            return user_write(actor, ident, action, request.method, body)
        if (
            resource == "spaces"
            and ident
            and (
                request.method == "DELETE"
                and action in {None, "purge"}
                or request.method == "POST"
                and action == "restore"
            )
        ):
            from .platform_cleanup import admin_space_state

            return admin_space_state(actor, ident, action or "delete", body)
        if resource == "spaces" and not action:
            return space_write(actor, ident, request.method, body)
        if resource == "data-sources" and not ident and request.method == "PUT":
            from .provider_policy import (
                validate_provider_config,
                invalidate_provider_config_cache,
                provider_directory,
            )

            try:
                config = validate_provider_config(body.get("config"))
            except (ValueError, TypeError) as error:
                raise DomainError(str(error))
            obj, _ = PlatformSetting.objects.get_or_create(pk="market_sources")
            expected_version(body, obj.version)
            obj.data = config
            obj.version += 1
            obj.save()
            log_admin(
                actor,
                "data_sources.updated",
                obj.pk,
                {"version": obj.version, "config": config},
            )
            transaction.on_commit(invalidate_provider_config_cache)
            return {
                "version": obj.version,
                "config": config,
                "providers": provider_directory(),
            }
        raise DomainError("接口不存在或不支持此方法", "not_found", 404)

    def authorize(actor):
        # This runs inside platform_command's transaction, before replaying any
        # previous response. A revocation also fences old successful commands.
        from .admin_access import require_delegation

        if resource == "spaces" and ident and not action and request.method == "PATCH":
            require_delegation(actor, ident)
        if resource == "configuration-templates":
            source = body.get("source_space_id")
            if ident:
                template = m.ConfigurationTemplate.objects.filter(pk=ident).first()
                if not template:
                    raise DomainError("模板不存在", "not_found", 404)
                source = template.source_workspace_id
            require_delegation(actor, source)

    return platform_command(request, "/".join(path), body, save, authorize=authorize)


def audit_detail(entry):
    """Keep platform audit metadata, hide delegated financial detail on revoke."""
    detail = entry.detail
    sid = detail.get("space_id") or detail.get("source_space_id")
    if (
        sid
        and not m.Workspace.objects.filter(
            pk=sid, deleted_at__isnull=True, admin_access_enabled=True
        ).exists()
    ):
        return {"redacted": True, "reason": "admin_access_required"}
    return detail
