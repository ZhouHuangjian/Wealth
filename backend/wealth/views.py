"""Same-origin session API. Every private resource is resolved inside an authorized space."""

import hashlib
import io
import json
import uuid
import zipfile
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.contrib.auth import (
    authenticate,
    get_user_model,
    login,
    logout,
    update_session_auth_hash,
)
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.db.models import Prefetch, Q
from django.http import FileResponse, JsonResponse
from django.http.response import HttpResponseBase
from django.middleware.csrf import get_token
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie

from . import models as m
from .common import (
    DomainError,
    audit,
    bump,
    day,
    dec,
    digest,
    get_obj,
    record,
    serial,
    tenant_context,
)
from .imports import (
    ADAPTERS,
    batch_preview,
    commit_batch,
    create_batch,
    preview,
    reverse_batch,
)
from .ledger import balance, event_detail, post_event, reverse_event
from .reporting import calendar, overview, performance, positions

User = get_user_model()
MODELS = {
    "accounts": m.Account,
    "instruments": m.Instrument,
    "prices": m.Price,
    "fx": m.FxRate,
    "snapshots": m.Snapshot,
}
RESOURCES = {
    "plans",
    "loans",
    "goals",
    "scenarios",
    "reservations",
    "notes",
    "budgets",
    "reconciliations",
    "strategies",
    "todos",
    "watchlist",
}


def health(request):
    try:
        with connection.cursor() as c:
            c.execute("SELECT 1")
        return JsonResponse(
            {
                "status": "ok",
                "version": settings.SPECTACULAR_SETTINGS["VERSION"],
                "mode": "development" if settings.DEBUG else "production",
            }
        )
    except Exception:
        return JsonResponse({"status": "database_unavailable"}, status=503)


def data_body(request):
    if request.content_type and "multipart" in request.content_type:
        return request.POST.dict()
    if not request.body:
        return {}
    try:
        value = json.loads(request.body)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, UnicodeDecodeError):
        raise DomainError("请求必须为 JSON 对象", "invalid_json", 400)


def auth_state(request):
    from .platform_admin import is_platform_admin

    user = request.user
    memberships = (
        list(
            m.Membership.objects.filter(
                user=user, workspace__deleted_at__isnull=True
            ).select_related("workspace")
        )
        if user.is_authenticated
        else []
    )
    administrator = is_platform_admin(user)
    if administrator:
        # Platform operators enter a customer's space explicitly from management.
        spaces = []
    else:
        spaces = [dict(record(x.workspace), role=x.role) for x in memberships]
    return {
        "user": {
            "id": user.pk,
            "username": user.username,
            "is_platform_admin": administrator,
        }
        if user.is_authenticated
        else None,
        "spaces": spaces,
        "csrf_token": get_token(request),
        "setup_required": not User.objects.exists(),
    }


def rate_limit(request, username):
    key = hashlib.sha256(
        (request.META.get("REMOTE_ADDR", "") + ":" + username).encode()
    ).hexdigest()
    attempt, _ = m.LoginAttempt.objects.select_for_update().get_or_create(
        key=key, defaults={"window_start": timezone.now()}
    )
    if timezone.now() - attempt.window_start > timedelta(minutes=5):
        attempt.count = 0
        attempt.window_start = timezone.now()
    if attempt.count >= 10:
        raise DomainError("尝试次数过多，请五分钟后重试", "rate_limited", 429)
    attempt.count += 1
    attempt.save()


def new_user(body):
    username = str(body.get("username", "")).strip()
    if not username or len(username) > 100:
        raise DomainError("用户名长度须为 1–100 个字符")
    password = body.get("password", "")
    validate_password(password)
    if User.objects.filter(username=username).exists():
        raise DomainError("用户名不可用")
    return User.objects.create_user(username=username, password=password)


def auth_route(request, path, body):
    if path == "auth/me" and request.method == "GET":
        return auth_state(request)
    if request.method != "POST":
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    if path == "auth/login":
        with transaction.atomic():
            rate_limit(request, str(body.get("username", "")))
        user = authenticate(
            request, username=body.get("username"), password=body.get("password")
        )
        if user is None:
            raise DomainError("用户名或密码不正确", "invalid_credentials", 401)
        login(request, user)
        return auth_state(request)
    if path == "auth/setup":
        with transaction.atomic():
            if connection.vendor == "postgresql":
                with connection.cursor() as c:
                    c.execute("SELECT pg_advisory_xact_lock(812339401)")
            if User.objects.exists():
                raise DomainError("系统已经初始化，请通过邀请加入", "setup_closed", 409)
            user = new_user(body)
            user.is_superuser = user.is_staff = True
            user.save(update_fields=["is_superuser", "is_staff"])
            login(request, user)
        return auth_state(request)
    if path == "auth/join":
        with transaction.atomic():
            invite, space = resolve_invite(body.get("token", ""))
            with tenant_context(space.pk):
                user = new_user(body)
                accept_invite(invite, space, user)
                login(request, user)
        return auth_state(request)
    if not request.user.is_authenticated:
        raise DomainError("请先登录", "unauthenticated", 401)
    if path == "auth/logout":
        logout(request)
        return {"ok": True}
    if path == "auth/password":
        from .platform_models import PlatformUserState

        with transaction.atomic():
            user = User.objects.select_for_update().get(pk=request.user.pk)
            if not user.is_active:
                raise DomainError("账号已停用，请联系管理员", "forbidden", 403)
            if not user.check_password(body.get("current_password", "")):
                raise DomainError("原密码不正确")
            validate_password(body.get("password", ""), user)
            user.set_password(body["password"])
            user.save(update_fields=["password"])
            state, _ = PlatformUserState.objects.get_or_create(user=user)
            state.version += 1
            state.save(update_fields=["version"])
            request.user = user
            update_session_auth_hash(request, user)
        return {"ok": True}
    raise DomainError("接口不存在", "not_found", 404)


@transaction.atomic
def resolve_invite(token):
    if not isinstance(token, str) or len(token) > 200:
        raise DomainError("邀请无效或已过期")
    try:
        sid, secret = token.split(".", 1)
        space = m.Workspace.objects.select_for_update().get(
            pk=sid, deleted_at__isnull=True
        )
    except (ValueError, ValidationError, m.Workspace.DoesNotExist):
        raise DomainError("邀请无效或已过期")
    with tenant_context(space.pk):
        invite = (
            m.Invitation.objects.select_for_update()
            .filter(
                tenant=space, token_hash=hashlib.sha256(secret.encode()).hexdigest()
            )
            .first()
        )
        if (
            not invite
            or invite.revoked
            or invite.used_at
            or invite.expires_at <= timezone.now()
        ):
            raise DomainError("邀请无效或已过期")
    return invite, space


def accept_invite(invite, space, user):
    if user.is_superuser:
        raise DomainError(
            "管理员账号只用于平台管理，请使用普通账号加入空间", "forbidden", 403
        )
    m.Membership.objects.get_or_create(
        workspace=space, user=user, defaults={"role": invite.role}
    )
    invite.used_at = timezone.now()
    invite.save(update_fields=["used_at"])
    audit(space, user, "invitation.accepted", invite)


@ensure_csrf_cookie
def api(request, route):
    route = route.strip("/")
    try:
        body = data_body(request) if request.method != "GET" else {}
        if route.startswith("auth/"):
            return JsonResponse(serial(auth_route(request, route, body)))
        if route == "invitations/preview" and request.method in {"GET", "POST"}:
            invite, space = resolve_invite(
                body.get("token") or request.GET.get("token", "")
            )
            return JsonResponse(
                {
                    "space_name": space.name,
                    "role": invite.role,
                    "expires_at": str(invite.expires_at),
                    "sharing": "加入后按角色访问该空间全部账务与笔记；个人内容请放入独立私人空间。",
                }
            )
        if not request.user.is_authenticated:
            raise DomainError("请先登录", "unauthenticated", 401)
        if route == "glossary" and request.method == "GET":
            from .glossary import read_glossary

            return JsonResponse(serial(read_glossary()))
        if route == "me/navigation-preferences":
            from .platform_admin import navigation

            return JsonResponse(serial(navigation(request, body)))
        if route.startswith("admin/"):
            from .platform_admin import dispatch_admin

            return JsonResponse(
                serial(dispatch_admin(request, route.split("/")[1:], body))
            )
        if route == "configuration-templates" and request.method == "GET":
            from .configuration_templates import template_record, available_templates

            return JsonResponse(
                serial(
                    page(
                        request,
                        available_templates()
                        .filter(published=True)
                        .order_by("-created_at"),
                        template_record,
                    )
                )
            )
        if route == "spaces/trash" and request.method == "GET":
            from .workspace_management import deleted_spaces

            return JsonResponse(serial(deleted_spaces(request.user)))
        parts = route.split("/")
        if parts[0] == "spaces" and (
            len(parts) == 2
            and request.method == "DELETE"
            or len(parts) == 3
            and parts[2] == "restore"
            and request.method == "POST"
        ):
            from .workspace_management import change_workspace_state

            return JsonResponse(
                serial(change_workspace_state(request, parts[1], len(parts) == 3, body))
            )
        if route == "invitations/accept" and request.method == "POST":
            with transaction.atomic():
                actor = User.objects.select_for_update().get(pk=request.user.pk)
                if not actor.is_active:
                    raise DomainError("账号已停用", "forbidden", 403)
                request.user = actor
                invite, space = resolve_invite(body.get("token", ""))
                with tenant_context(space.pk):
                    accept_invite(invite, space, request.user)
            return JsonResponse(serial(auth_state(request)))
        if route == "spaces":
            if request.method == "GET":
                return JsonResponse({"items": auth_state(request)["spaces"]})
            if request.method != "POST":
                raise DomainError("不支持此方法", "method_not_allowed", 405)
            currency = body.get("base_currency", "CNY")
            if currency not in {"CNY", "HKD", "USD"}:
                raise DomainError("首版支持 CNY/HKD/USD")
            name = str(body.get("name", "")).strip()
            if not name:
                raise DomainError("请填写空间名称")
            with transaction.atomic():
                actor = User.objects.select_for_update().get(pk=request.user.pk)
                if not actor.is_active:
                    raise DomainError("账号已停用", "forbidden", 403)
                if actor.is_superuser:
                    raise DomainError(
                        "管理员账号没有个人空间，请在管理中心为普通用户创建空间",
                        "forbidden",
                        403,
                    )
                request.user = actor
                space = m.Workspace.objects.create(
                    name=name[:100], base_currency=currency
                )
                m.Membership.objects.create(
                    workspace=space, user=request.user, role="owner"
                )
                invitation = None
                if body.get("create_invitation") is True:
                    from .workspace_management import create_invitation

                    with tenant_context(space.pk):
                        invitation = create_invitation(space, request.user, {})
            return JsonResponse(
                serial(dict(record(space), role="owner", invitation=invitation)),
                status=201,
            )
        parts = route.split("/")
        if len(parts) < 3 or parts[0] != "spaces":
            raise DomainError("接口不存在", "not_found", 404)
        from .platform_admin import is_platform_admin, log_admin

        administrator = is_platform_admin(request.user)
        try:
            membership = (
                m.Membership.objects.select_related("workspace")
                .filter(
                    user=request.user,
                    workspace_id=parts[1],
                    workspace__deleted_at__isnull=True,
                )
                .first()
            )
            space = (
                m.Workspace.objects.filter(pk=parts[1], deleted_at__isnull=True).first()
                if administrator
                else (membership.workspace if membership else None)
            )
        except (ValueError, ValidationError):
            space = None
        if not space:
            raise DomainError("空间不存在或未获授权", "not_found", 404)
        with tenant_context(space.pk):
            role = "owner" if administrator else membership.role
            readonly_dca_preview = (
                request.method == "POST"
                and len(parts) >= 3
                and parts[2] == "plans"
                and (
                    len(parts) == 5
                    and parts[4] == "history-preview"
                    or len(parts) == 6
                    and parts[4:] == ["history-import", "validate"]
                )
            )
            if administrator or (
                request.method not in {"GET", "HEAD"} and not readonly_dca_preview
            ):
                actor = User.objects.select_for_update().get(pk=request.user.pk)
                if not actor.is_active:
                    raise DomainError("账号已停用", "forbidden", 403)
                if administrator:
                    if not is_platform_admin(actor):
                        raise DomainError("管理员授权已撤销", "forbidden", 403)
                request.user = actor
                space = m.Workspace.objects.select_for_update().get(pk=space.pk)
                if space.deleted_at:
                    raise DomainError("此空间已移入回收站", "not_found", 404)
                if not administrator:
                    membership = m.Membership.objects.filter(pk=membership.pk).first()
                    if not membership:
                        raise DomainError("成员授权已撤销", "forbidden", 403)
                    role = membership.role
                    if role == "viewer":
                        raise DomainError("只读成员不能修改账目", "forbidden", 403)
            if administrator:
                from .admin_access import require_delegation

                space = require_delegation(request.user, space)
            response = dispatch_space(request, space, role, parts[2:], body)
            if administrator and not readonly_dca_preview:
                log_admin(
                    request.user,
                    "space.access"
                    if request.method in {"GET", "HEAD"}
                    else "space.command",
                    space.pk,
                    {
                        "method": request.method,
                        "resource": "/".join(parts[2:]),
                        "administration": True,
                    },
                )
            if isinstance(response, HttpResponseBase):
                return response
            return JsonResponse(serial(response), safe=isinstance(response, dict))
    except DomainError as e:
        return JsonResponse(
            {
                "code": e.code,
                "message": e.message,
                "fields": e.fields,
                "request_id": str(uuid.uuid4()),
            },
            status=e.status,
        )
    except ValidationError as e:
        return JsonResponse(
            {"code": "validation_error", "message": "；".join(e.messages)}, status=422
        )
    except (ValueError, TypeError, KeyError):
        return JsonResponse(
            {
                "code": "validation_error",
                "message": "请求字段或格式不正确",
                "request_id": str(uuid.uuid4()),
            },
            status=422,
        )
    except IntegrityError:
        return JsonResponse(
            {
                "code": "constraint_conflict",
                "message": "数据已存在、引用不符或并发冲突，请刷新核对",
            },
            status=409,
        )


def require_owner(role):
    if role != "owner":
        raise DomainError("此操作仅空间 Owner 可执行", "forbidden", 403)


def version_check(request, obj, body):
    supplied = request.headers.get("If-Match", body.get("version"))
    if supplied is None:
        raise DomainError("修改需提供记录版本", "version_required", 428)
    if str(supplied).strip('"') != str(obj.version):
        raise DomainError("记录已变更，请刷新再编辑", "version_conflict", 412)


def write_command(request, space, command, body, fn):
    key = request.headers.get("Idempotency-Key")
    if not key or len(key) > 160:
        raise DomainError(
            "财务提交必须提供 Idempotency-Key", "idempotency_required", 400
        )
    existing = m.Idempotency.objects.filter(
        tenant=space, actor=request.user, command=command, key=key
    ).first()
    signature = digest(body)
    if existing:
        if existing.digest != signature:
            raise DomainError("同一幂等键不能提交不同内容", "idempotency_conflict", 409)
        return existing.result
    result = serial(fn())
    m.Idempotency.objects.create(
        tenant=space,
        created_by=request.user,
        actor=request.user,
        command=command,
        key=key,
        digest=signature,
        result=result,
    )
    return result


def page(request, qs, serialize=record, default=100):
    offset = max(0, int(request.GET.get("offset", 0)))
    limit = min(1000, max(1, int(request.GET.get("limit", default))))
    count = qs.count()
    return {
        "items": [serialize(x) for x in qs[offset : offset + limit]],
        "count": count,
        "offset": offset,
        "limit": limit,
        "has_more": offset + limit < count,
    }


def dispatch_space(request, space, role, path, body):
    resource = path[0]
    if resource == "admin-access" and len(path) == 1:
        from .admin_access import access_record, require_consent_owner, update_access

        if request.method == "GET":
            return access_record(request.user, space)
        if request.method == "PUT":
            # Authorize before idempotency replay; delegated admins cannot reuse
            # an old owner's result or the synthetic owner role to self-authorize.
            require_consent_owner(request.user, space)
            return write_command(
                request,
                space,
                "workspace.admin_access",
                body,
                lambda: update_access(request.user, space, body),
            )
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    if resource == "profile" and len(path) == 1:
        if request.method == "GET":
            return dict(record(space), version=space.revision)
        if request.method == "PATCH":
            from .workspace_management import update_workspace_details

            require_owner(role)

            def rename_space():
                updated = update_workspace_details(space, request.user, body)
                return dict(record(updated), version=updated.revision)

            return write_command(
                request, space, "workspace.profile", body, rename_space
            )
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    if resource == "administration":
        from .administration_data import dispatch

        return dispatch(request, space, path[1:], body)
    ident = path[1] if len(path) > 1 else None
    action = path[2] if len(path) > 2 else None
    user = request.user
    if resource == "entry-defaults" and request.method == "GET":
        from .fund_orders import entry_defaults

        return entry_defaults(space, user)
    if resource == "fund-orders":
        from .fund_orders import (
            KIND,
            convert_fund,
            detail,
            list_orders,
            preferences,
            save_order,
            transition,
        )

        if request.method == "GET":
            if ident == "defaults":
                return preferences(
                    space,
                    request.GET.get("instrument_id"),
                    request.GET.get("account_id"),
                )
            if ident:
                return detail(get_obj(m.Resource, space, ident, kind=KIND))
            return list_orders(
                space,
                instrument_id=request.GET.get("instrument_id"),
                account_id=request.GET.get("account_id"),
                pending=request.GET.get("pending") == "true",
                offset=request.GET.get("offset"),
                limit=request.GET.get("limit"),
            )
        if request.method == "POST":
            if ident == "convert":
                return write_command(
                    request,
                    space,
                    "/".join(path),
                    body,
                    lambda: convert_fund(space, user, body),
                )

            def execute_order():
                row = get_obj(m.Resource, space, ident, kind=KIND) if ident else None
                if row:
                    version_check(request, row, body)
                if action == "transition" and row:
                    return transition(space, user, row, body)
                if not action:
                    return save_order(space, user, body, row)
                raise DomainError("不支持的申购操作")

            return write_command(request, space, "/".join(path), body, execute_order)
    if resource == "investment-trades" and not ident and request.method == "POST":
        from .investment_trades import record_trade

        return write_command(
            request, space, resource, body, lambda: record_trade(space, user, body)
        )
    if (
        resource == "investment-trades"
        and ident == "confirm"
        and request.method == "POST"
    ):
        from .investment_trades import confirm_fund_trade

        return write_command(
            request,
            space,
            "/".join(path),
            body,
            lambda: confirm_fund_trade(space, user, body),
        )
    if resource == "option-holdings":
        from .option_positions import (
            KIND,
            option_items,
            option_record,
            save_option_position,
        )

        if request.method == "GET":
            if ident:
                return option_record(get_obj(m.Resource, space, ident, kind=KIND))
            return {
                "items": option_items(
                    space,
                    request.GET.get("as_of"),
                    request.GET.get("account_id"),
                    request.GET.get("instrument_id"),
                    request.GET.get("status", "active"),
                ),
                "data_revision": space.revision,
            }
        if (request.method == "POST" and not ident) or (
            request.method == "PATCH" and ident
        ):
            return write_command(
                request,
                space,
                "/".join(path),
                body,
                lambda: save_option_position(space, user, body, ident=ident),
            )
        raise DomainError(
            "期权持仓请使用新增、编辑或关闭，不能直接删除记录",
            "method_not_allowed",
            405,
        )
    from . import insights

    if (
        resource == "configuration-templates"
        and ident
        and action == "apply"
        and request.method == "POST"
    ):
        from .configuration_templates import apply_template

        return write_command(
            request,
            space,
            "/".join(path),
            body,
            lambda: apply_template(space, user, ident, body, role),
        )
    if resource == "dividends":
        from .dividends import dispatch_dividends

        return dispatch_dividends(request, space, user, path, body, role)

    if resource == "net-worth-comparison" and request.method == "GET":
        from .portfolio import net_worth_comparison

        return net_worth_comparison(
            space, request.GET.get("as_of"), request.GET.get("currency")
        )
    if resource == "portfolio-analysis" and request.method == "GET":
        from .portfolio import portfolio_analysis

        return portfolio_analysis(space, request.GET.get("as_of"))
    if resource == "tag-series" and request.method == "GET":
        from .portfolio import tag_series

        return tag_series(
            space,
            request.GET.get("tag_id"),
            request.GET.get("start") or str(day() - timedelta(days=365)),
            request.GET.get("end") or str(day()),
        )
    if resource == "signals":
        if request.method == "GET" and not ident:
            return insights.signals(space)
        if request.method == "POST" and ident == "evaluate":
            return write_command(
                request,
                space,
                "signals/evaluate",
                body,
                lambda: insights.evaluate_rules(space, user),
            )
        if request.method == "POST" and ident and action == "ack":
            return insights.acknowledge(space, ident)
        raise DomainError("接口不存在", "not_found", 404)
    if resource in insights.RESOURCE_PATHS:
        kind = insights.RESOURCE_PATHS[resource]
        if kind == "dashboard_preferences":
            obj = m.Resource.objects.filter(tenant=space, kind=kind).first()
        else:
            obj = get_obj(m.Resource, space, ident, kind=kind) if ident else None
        if request.method == "GET":
            if kind == "dashboard_preferences":
                return insights.preferences(space)
            if obj:
                return insights.configuration_record(obj)
            if kind == "market_watchlist":
                return insights.watchlist(space)
            return dict(
                page(
                    request,
                    m.Resource.objects.filter(tenant=space, kind=kind).order_by(
                        "created_at"
                    ),
                    serialize=insights.configuration_record,
                    default=500,
                ),
                data_revision=space.revision,
            )
        if request.method in {"POST", "PATCH", "PUT"}:
            if request.method != "POST" and not obj:
                raise DomainError("记录不存在", "not_found", 404)

            def save_insight():
                if obj:
                    version_check(request, obj, body)
                return insights.save_configuration(space, user, kind, body, obj)

            return write_command(
                request, space, f"{resource}/{ident or 'new'}", body, save_insight
            )
        raise DomainError(
            "请停用或归档配置，不直接删除关联记录", "method_not_allowed", 405
        )
    if resource == "holdings":
        from .investments import holdings_summary, record_holding
        from .market_sync import enabled, queue_refresh

        if request.method == "POST" and ident and action == "void-placeholder":
            from .dca_history import void_placeholder

            return write_command(
                request,
                space,
                f"holdings/{ident}/void-placeholder",
                body,
                lambda: void_placeholder(space, user, ident, body),
            )

        if request.method == "POST" and ident and action in {"correct", "check"}:
            from .holding_checks import save_holding_check
            from .holding_corrections import correct_holding

            handler = correct_holding if action == "correct" else save_holding_check
            return write_command(
                request,
                space,
                f"holdings/{ident}/{action}",
                body,
                lambda: handler(space, user, ident, body),
            )

        if request.method == "GET" and not ident:
            return holdings_summary(
                space,
                when=request.GET.get("as_of"),
                account_id=request.GET.get("account_id"),
                instrument_id=request.GET.get("instrument_id"),
                kind=request.GET.get("kind"),
            )
        if request.method == "POST" and not ident:

            def save_holding():
                result = record_holding(space, user, body)
                if enabled():
                    result["market_refresh"] = queue_refresh(
                        space,
                        user,
                        [body["instrument_id"]],
                        history=True,
                        start=max(
                            day(body.get("purchase_date")),
                            day() - timedelta(days=5 * 366),
                        ),
                    )
                return result

            return write_command(request, space, "holdings", body, save_holding)
    if resource == "profit-calendar" and request.method == "GET":
        from .investments import profit_calendar

        return profit_calendar(
            space,
            start=request.GET.get("start"),
            end=request.GET.get("end"),
            period=request.GET.get("period", "day"),
            selected_day=request.GET.get("selected_day"),
            account_id=request.GET.get("account_id"),
            instrument_id=request.GET.get("instrument_id"),
            kind=request.GET.get("kind"),
        )
    if resource == "market":
        from . import market_sync

        if ident == "catalog" and request.method == "GET":
            from .catalog import browse_catalog

            return browse_catalog(
                kind=request.GET.get("kind", ""),
                market=request.GET.get("market", ""),
                query=request.GET.get("q", ""),
                offset=request.GET.get("offset", 0),
                limit=request.GET.get("limit", 50),
            )
        if ident in {"resolve", "trade-dates"} and request.method in {"GET", "POST"}:
            from .metadata_service import metadata_input, resolve_metadata

            payload = request.GET.dict() if request.method == "GET" else body
            if ident == "resolve":
                return resolve_metadata(space, payload)
            from .trading_calendar import preview_trade_dates

            product = payload.get("instrument", payload)
            return preview_trade_dates(
                {**payload, "instrument": metadata_input(space, product)}
            )
        if ident == "search" and request.method == "GET":
            query = request.GET.get("q", "").strip()
            if not query or len(query) > 80:
                return {"items": [], "status": "empty", "message": "输入产品代码或名称"}
            try:
                from .catalog import search_catalog

                return search_catalog(
                    query,
                    request.GET.get("kind", "fund"),
                    request.GET.get("market", "CN"),
                    remote=request.GET.get("remote") == "1",
                )
            except Exception:
                return {
                    "items": [],
                    "status": "unavailable",
                    "message": "搜索源暂时不可用，可手动录入产品代码与名称",
                }
        if ident == "quotes" and request.method == "GET":
            return market_sync.quote_list(space)
        if ident == "valuation" and request.method == "GET":
            return market_sync.valuation_summary(space)
        if ident == "refresh" and request.method == "POST":
            return write_command(
                request,
                space,
                "market/refresh",
                body,
                lambda: market_sync.queue_refresh(
                    space,
                    user,
                    body.get("instrument_ids"),
                    history=body.get("history") is True,
                    start=body.get("start"),
                ),
            )
        raise DomainError("接口不存在或不支持此方法", "not_found", 404)
    if resource == "overview" and request.method == "GET":
        if (
            request.GET.get("as_of", str(day())) == str(day())
            and request.GET.get("currency", space.base_currency) == space.base_currency
        ):
            cached = m.Projection.objects.filter(
                tenant=space, revision=space.revision, as_of=day()
            ).first()
            if (
                cached
                and cached.payload.get("calculation_version") == "account-equity-v24"
            ):
                return dict(cached.payload, cached=True)
        return overview(space, request.GET.get("as_of"), request.GET.get("currency"))
    if resource == "positions" and request.method == "GET":
        return {
            "items": serial(positions(space, request.GET.get("as_of"))),
            "data_revision": space.revision,
        }
    if resource == "performance" and request.method == "GET":
        return performance(space, request.GET.get("start"), request.GET.get("end"))
    if resource == "calendar" and request.method == "GET":
        return calendar(
            space,
            request.GET.get("start") or str(day().replace(day=1)),
            request.GET.get("end") or str(day() + timedelta(days=31)),
        )
    if resource == "forecast" and request.method in {"GET", "POST"}:
        from .planning import forecast

        return forecast(space, body if body else request.GET.dict())
    if resource == "adapters" and request.method == "GET":
        return {"items": ADAPTERS}
    if resource == "search" and request.method == "GET":
        from .common import catalog_queryset

        q = request.GET.get("q", "").strip()[:100]
        if len(q) < 1:
            return {"items": []}
        return {
            "items": [
                *[
                    dict(record(a), resource="accounts")
                    for a in catalog_queryset(m.Account, space).filter(
                        name__icontains=q
                    )[:20]
                ],
                *[
                    dict(record(r), resource="notes")
                    for r in m.Resource.objects.filter(
                        tenant=space, kind="notes"
                    ).filter(Q(data__title__icontains=q) | Q(data__body__icontains=q))[
                        :20
                    ]
                ],
            ]
        }
    if resource == "accounts" and ident and action == "opening-date":
        from .account_opening import correct_opening_date, opening_date_metadata

        if request.method == "GET":
            return opening_date_metadata(space, get_obj(m.Account, space, ident))
        if request.method == "POST":
            return write_command(
                request,
                space,
                "/".join(path),
                body,
                lambda: correct_opening_date(
                    space, user, get_obj(m.Account, space, ident), body
                ),
            )
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    if (
        resource in {"accounts", "instruments"}
        and ident
        and (action in {"deletion", "restore"} or request.method == "DELETE")
    ):
        from .catalog_lifecycle import (
            delete_catalog_item,
            deletion_preview,
            restore_catalog_item,
        )

        if action == "deletion" and request.method == "GET":
            return deletion_preview(space, resource, ident)
        if request.method == "DELETE" and not action:
            return write_command(
                request,
                space,
                "/".join(path),
                body,
                lambda: delete_catalog_item(space, user, resource, ident, body),
            )
        if action == "restore" and request.method == "POST":
            return write_command(
                request,
                space,
                "/".join(path),
                body,
                lambda: restore_catalog_item(space, user, resource, ident, body),
            )
        raise DomainError("不支持此方法", "method_not_allowed", 405)
    if resource in MODELS:
        if (
            resource == "instruments"
            and ident
            and request.method in {"PATCH", "PUT"}
            and "option_position" in body
        ):
            return write_command(
                request,
                space,
                "/".join(path),
                body,
                lambda: model_resource(request, space, resource, ident, body),
            )
        if not ident and request.method == "POST":
            return write_command(
                request,
                space,
                resource,
                body,
                lambda: model_resource(request, space, resource, ident, body),
            )
        return model_resource(request, space, resource, ident, body)
    if resource == "events":
        if request.method == "GET":
            if ident:
                return event_detail(get_obj(m.Event, space, ident))
            qs = m.Event.objects.filter(tenant=space)
            if request.GET.get("account_id"):
                qs = qs.filter(lines__account_id=request.GET["account_id"]).distinct()
            if request.GET.get("q"):
                qs = qs.filter(description__icontains=request.GET["q"][:100])
            if request.GET.get("kind"):
                qs = qs.filter(kind__in=request.GET["kind"].split(","))
            if request.GET.get("currency"):
                qs = qs.filter(payload__currency=request.GET["currency"])
            if request.GET.get("start"):
                qs = qs.filter(economic_date__gte=day(request.GET["start"]))
            if request.GET.get("end"):
                qs = qs.filter(economic_date__lte=day(request.GET["end"]))
            qs = qs.select_related("reversal").prefetch_related(
                "lines",
                "movements",
                Prefetch(
                    "evidence_links",
                    queryset=m.EvidenceLink.objects.filter(active=True).select_related(
                        "record"
                    ),
                    to_attr="active_evidence",
                ),
            )
            return dict(page(request, qs, event_detail), data_revision=space.revision)
        if request.method == "POST":
            if action in {"reverse", "correct"}:
                event = get_obj(m.Event, space, ident)

                def execute():
                    if (
                        action == "correct"
                        and event.payload.get("opening_source") == "existing_holding"
                    ):
                        raise DomainError(
                            "存量持仓请使用持仓页面的更正入口，保持原市值与机构资金分配不变",
                            "holding_correction_required",
                        )
                    rev = reverse_event(space, user, event, body.get("reason"))
                    if action == "correct":
                        return event_detail(
                            post_event(space, user, body["replacement"])
                        )
                    return event_detail(rev)

                return write_command(
                    request, space, f"events/{ident}/{action}", body, execute
                )
            if not ident:

                def save_event_with_defaults():
                    result = event_detail(post_event(space, user, body))
                    if body.get("kind") in {"income", "expense"}:
                        from .fund_orders import entry_defaults

                        entry_defaults(space, user, body)
                    return result

                return write_command(
                    request,
                    space,
                    "events",
                    body,
                    save_event_with_defaults,
                )
    if resource == "imports":
        if role == "viewer":
            raise DomainError("原始导入记录仅 Owner 和 Editor 可访问", "forbidden", 403)
        if not ident and request.method == "GET":
            return dict(
                page(
                    request,
                    m.ImportBatch.objects.filter(tenant=space).order_by("-created_at"),
                ),
                data_revision=space.revision,
            )
        if not ident and request.method == "POST":
            if "file" not in request.FILES:
                raise DomainError("请选择文件")
            return record(
                create_batch(
                    space,
                    user,
                    request.FILES["file"],
                    body.get("source", "generic"),
                    body.get("account_id"),
                )
            )
        batch = get_obj(m.ImportBatch, space, ident)
        if action == "file" and request.method == "GET":
            require_owner(role)
            audit(space, user, "import.download", batch)
            return FileResponse(
                open(settings.PRIVATE_MEDIA_ROOT / batch.storage_key, "rb"),
                as_attachment=True,
                filename=batch.filename,
            )
        if request.method == "GET":
            return batch_preview(
                space,
                batch,
                max(0, int(request.GET.get("offset", 0))),
                min(10000, max(1, int(request.GET.get("limit", 500)))),
            )
        if action == "preview":
            return preview(space, user, batch, body)
        if action == "commit":
            return write_command(
                request,
                space,
                f"imports/{ident}/commit",
                body,
                lambda: commit_batch(space, user, batch, body),
            )
        if action == "reverse":
            return write_command(
                request,
                space,
                f"imports/{ident}/reverse",
                body,
                lambda: reverse_batch(space, user, batch, body.get("reason")),
            )
    if resource in RESOURCES:
        from .planning import generate_schedule, save_resource

        obj = get_obj(m.Resource, space, ident, kind=resource) if ident else None
        if resource == "plans" and obj and action == "automation":
            from .dca_automation import automation_status, run_plan

            if len(path) == 3 and request.method == "GET":
                return automation_status(space, obj.pk)
            if len(path) == 4 and path[3] == "run" and request.method == "POST":
                if (
                    set(body) != {"expected_plan_version"}
                    or type(body.get("expected_plan_version")) is not int
                    or body["expected_plan_version"] < 1
                ):
                    raise DomainError("请传入当前计划版本再检查")
                return write_command(
                    request,
                    space,
                    f"plans/{ident}/automation/run",
                    body,
                    lambda: run_plan(
                        space,
                        user,
                        obj.pk,
                        expected_plan_version=body["expected_plan_version"],
                    ),
                )
            raise DomainError("未找到此自动定投操作", "not_found", 404)
        if resource == "plans" and obj and action == "history-import":
            from .dca_import import commit_import, import_status, validate_import

            if len(path) == 3 and request.method == "GET":
                return import_status(space, obj.pk)
            if len(path) == 4 and request.method == "POST" and path[3] == "validate":
                return validate_import(space, obj.pk, body)
            if len(path) == 4 and request.method == "POST" and path[3] == "commit":
                return write_command(
                    request,
                    space,
                    f"plans/{ident}/history-import/commit",
                    body,
                    lambda: commit_import(space, user, obj.pk, body),
                )
            raise DomainError("未找到此补录操作", "not_found", 404)
        if (
            resource == "plans"
            and obj
            and action == "history-preview"
            and request.method == "POST"
        ):
            from .dca_history import history_preview

            return history_preview(space, obj.pk, body)
        if obj and action == "versions" and request.method == "GET":
            return {
                "items": [
                    record(x)
                    for x in m.ResourceRevision.objects.filter(
                        tenant=space, resource=obj
                    ).order_by("version")
                ]
            }
        if obj and action == "attachments":
            return note_attachment(request, space, role, obj, path, body)
        if (
            obj
            and action in {"generate", "generate-schedule"}
            and request.method == "POST"
        ):
            return {
                "items": [record(x) for x in generate_schedule(space, user, obj)],
                "data_revision": space.revision,
            }
        if request.method == "GET":
            if obj:
                return record(obj)
            qs = m.Resource.objects.filter(tenant=space, kind=resource).order_by(
                "-created_at"
            )
            if request.GET.get("q"):
                qs = qs.filter(
                    Q(data__title__icontains=request.GET["q"])
                    | Q(data__body__icontains=request.GET["q"])
                    | Q(data__name__icontains=request.GET["q"])
                    | Q(data__description__icontains=request.GET["q"])
                )
            if request.GET.get("kind"):
                qs = qs.filter(data__kind__in=request.GET["kind"].split(","))
            for key in ("instrument_id", "account_id", "goal_id", "plan_id"):
                if request.GET.get(key):
                    if key == "instrument_id":
                        get_obj(m.Instrument, space, request.GET[key])
                    elif key == "account_id":
                        get_obj(m.Account, space, request.GET[key])
                    else:
                        get_obj(m.Resource, space, request.GET[key])
                    qs = qs.filter(**{f"data__{key}": request.GET[key]})
            if resource == "plans" and request.GET.get("holding_account_id"):
                from .pending_purchases import plans_for_holding

                holding = get_obj(m.Account, space, request.GET["holding_account_id"])
                qs = plans_for_holding(space, qs, holding.pk)
            return dict(page(request, qs, default=500), data_revision=space.revision)
        if request.method in {"POST", "PATCH", "PUT"}:
            if obj:
                version_check(request, obj, body)
            if not obj:
                return write_command(
                    request,
                    space,
                    resource,
                    body,
                    lambda: record(
                        save_resource(
                            space,
                            user,
                            resource,
                            body,
                            run_automatic=resource == "plans",
                        )
                    ),
                )
            return record(
                save_resource(
                    space, user, resource, body, obj, run_automatic=resource == "plans"
                )
            )
    if resource in {"occurrences", "installments"}:
        from .planning import confirm_occurrence

        if request.method == "GET":
            qs = (
                m.Occurrence.objects.filter(tenant=space)
                .select_related("plan")
                .order_by("due_date")
            )
            if resource == "installments":
                qs = qs.filter(plan__kind="loans")
            from .planning import today
            from .subscription_calendar import subscription_day, subscription_rule

            instruments = {
                str(i.pk): i for i in m.Instrument.objects.filter(tenant=space)
            }
            rules = {}

            def occurrence_record(o):
                from .dca_automation import occurrence_processing

                row = {
                    **o.details,
                    **record(o),
                    "name": o.plan.data.get("name"),
                    "plan_kind": o.plan.kind,
                    "operation_kind": o.plan.data.get("kind", "loan"),
                    "automation_enabled": (o.plan.data.get("automation") or {}).get(
                        "enabled", False
                    ),
                    "automation": occurrence_processing(o),
                }
                if (
                    not o.event_id
                    and o.status != "cancelled"
                    and (o.status != "skipped" or o.details.get("auto_skip"))
                ):
                    row["status"] = (
                        "pending" if o.due_date <= today(space) else "scheduled"
                    )
                    inst = instruments.get(o.plan.data.get("instrument_id"))
                    if o.plan.data.get("kind") == "dca" and inst:
                        key = str(inst.pk)
                        if key not in rules:
                            rules[key] = subscription_rule(inst)
                        availability = subscription_day(o.due_date, rule=rules[key])
                        row["subscription_day"] = availability
                        row["auto_skip"] = availability["is_open"] is False
                        if row["auto_skip"]:
                            row["status"] = "skipped"
                return row

            return {
                "items": [occurrence_record(o) for o in qs[:1000]],
                "data_revision": space.revision,
            }
        occ = get_obj(m.Occurrence, space, ident)
        if action == "confirm":
            return write_command(
                request,
                space,
                f"occurrences/{ident}/confirm",
                body,
                lambda: record(
                    confirm_occurrence(space, user, occ, body.get("event_id"))
                ),
            )
        if request.method == "PATCH":
            version_check(request, occ, body)
            if occ.event_id:
                raise DomainError("已有实账的期次不能改为跳过")
            if body.get("status") not in {"skipped", "pending"}:
                raise DomainError("可变更为跳过或待处理")
            occ.status = body["status"]
            # A user skip is distinct from a generated holiday skip.
            occ.details = {**occ.details, "auto_skip": False}
            occ.version += 1
            occ.save()
            bump(space, user, invalidate_reconciliations=False)
            audit(space, user, "occurrence.updated", occ)
            return record(occ)
    if resource == "members":
        return members(request, space, role, ident, body)
    if resource == "invitations":
        require_owner(role)
        if request.method == "GET":
            return {
                "items": [record(x) for x in m.Invitation.objects.filter(tenant=space)]
            }
        if ident:
            inv = get_obj(m.Invitation, space, ident)
            inv.revoked = True
            inv.save()
            audit(space, user, "invitation.revoked", inv)
            return record(inv)
        from .workspace_management import create_invitation

        return create_invitation(space, user, body)
    if resource == "audit" and request.method == "GET":
        return {
            "items": [
                record(a)
                for a in m.Audit.objects.filter(tenant=space).order_by("-created_at")[
                    :200
                ]
            ]
        }
    if resource == "jobs" and request.method == "GET":
        return {
            "items": [
                record(j)
                for j in m.Outbox.objects.filter(tenant=space).order_by("-created_at")[
                    :100
                ]
            ]
        }
    if resource == "exports":
        return exports(request, space, role, ident, action)
    raise DomainError("接口不存在或不支持此方法", "not_found", 404)


def model_resource(request, space, kind, ident, body):
    model = MODELS[kind]
    obj = get_obj(model, space, ident) if ident else None
    if (
        kind == "accounts"
        and obj
        and request.method in {"PATCH", "PUT"}
        and "opening_date" in body
    ):
        from .account_opening import apply_account_edit

        return apply_account_edit(
            space,
            request.user,
            obj,
            body,
            lambda fresh, clean_body: model_resource(
                request, space, kind, str(fresh.pk), clean_body
            ),
        )
    if request.method == "GET":

        def model_record(x):
            r = record(x)
            if kind == "accounts":
                from .account_balances import account_balance_projection
                from .recording_coverage import coverage

                r.update(coverage(space, x))
                r.update(account_balance_projection(space, x))
            elif kind == "instruments":
                linked = set(x.specification.get("account_ids", []))
                linked.update(
                    str(aid)
                    for aid in m.PositionMovement.objects.filter(
                        tenant=space, instrument=x
                    ).values_list("account_id", flat=True)
                )
                linked.update(
                    m.Resource.objects.filter(
                        tenant=space,
                        kind="option_positions",
                        data__instrument_id=str(x.pk),
                    ).values_list("data__account_id", flat=True)
                )
                accounts = m.Account.objects.filter(
                    tenant=space, pk__in=linked
                ).order_by("name")
                r["account_ids"] = [str(a.pk) for a in accounts]
                r["account_names"] = [a.name for a in accounts]
                r["accounts"] = [
                    {
                        "id": str(a.pk),
                        "name": a.name,
                        "currency": a.currency,
                        "kind": a.kind,
                    }
                    for a in accounts
                ]
            return r

        if obj:
            return model_record(obj)

        qs = model.objects.filter(tenant=space).order_by("-created_at")
        if kind in {"accounts", "instruments"}:
            from .catalog_lifecycle import deleted_catalog_ids

            deleted = deleted_catalog_ids(space, kind)
            status = request.GET.get("status", "active")
            if status not in {"active", "deleted"}:
                raise DomainError("档案状态须为 active 或 deleted")
            qs = (
                qs.filter(pk__in=deleted)
                if status == "deleted"
                else qs.exclude(pk__in=deleted)
            )
        if request.GET.get("q") and kind in {"accounts", "instruments"}:
            query = Q(name__icontains=request.GET["q"][:100])
            if kind == "instruments":
                query |= Q(code__icontains=request.GET["q"][:100])
            qs = qs.filter(query)
        if request.GET.get("kind") and kind in {"accounts", "instruments", "prices"}:
            qs = qs.filter(kind__in=request.GET["kind"].split(","))
        return dict(
            page(request, qs, model_record, default=1000), data_revision=space.revision
        )
    if request.method not in {"POST", "PATCH", "PUT"}:
        raise DomainError("不支持删除财务档案，请归档", "method_not_allowed", 405)
    if obj:
        version_check(request, obj, body)
    if obj and kind in {"prices", "fx", "snapshots"}:
        raise DomainError("请追加新版本观察记录，不原地覆盖历史来源")
    values = {}
    allowed = {
        f.name: f
        for f in model._meta.fields
        if f.name not in {"id", "tenant", "created_by", "created_at", "version"}
    }
    for name, field in allowed.items():
        key = name + "_id" if field.is_relation else name
        if key not in body and name not in body:
            continue
        value = body.get(key, body.get(name))
        if field.is_relation:
            values[name] = get_obj(field.related_model, space, value) if value else None
        elif field.get_internal_type() == "DecimalField":
            values[name] = dec(
                value, nonnegative=name not in {"equity"}, places=field.decimal_places
            )
        else:
            values[name] = value
    if kind == "accounts":
        from .option_positions import has_option_reference

        option_reference = obj and has_option_reference(space, account_id=obj.pk)
        if option_reference and (
            values.get("currency", obj.currency) != obj.currency
            or values.get("kind", obj.kind) != obj.kind
            or (
                values.get("valuation_mode", obj.valuation_mode) != obj.valuation_mode
                and values.get("valuation_mode")
                not in {"snapshot", "institution_snapshot"}
            )
        ):
            raise DomainError(
                "已有期权持仓参考，账户币种和类型不能直接更改；机构权益口径请核对后设置"
            )
        if not ident and values.get("kind") in {
            "future",
            "futures",
            "option",
            "options",
        }:
            values["valuation_mode"] = "snapshot"
        if (
            obj
            and any(k in values for k in ("currency", "valuation_mode", "kind"))
            and (
                m.JournalLine.objects.filter(tenant=space, account=obj).exists()
                or m.Snapshot.objects.filter(tenant=space, account=obj).exists()
                or m.PositionMovement.objects.filter(tenant=space, account=obj).exists()
            )
        ):
            if (
                values.get("currency", obj.currency) != obj.currency
                or values.get("kind", obj.kind) != obj.kind
                or values.get("valuation_mode", obj.valuation_mode)
                != obj.valuation_mode
            ):
                raise DomainError(
                    "已有账务或权益记录，账户类型、币种和计值方式变更需先对账迁移"
                )
        if (
            values.get("archived")
            and obj
            and (
                balance(space, obj) != 0
                or has_option_reference(space, account_id=obj.pk, active_only=True)
                or m.Occurrence.objects.filter(
                    tenant=space,
                    plan__data__account_id=str(obj.pk),
                    status__in=["scheduled", "pending"],
                ).exists()
            )
        ):
            raise DomainError("存在余额、持仓或开放计划，不能直接归档")
        if values.get("currency", obj.currency if obj else "CNY") not in {
            "CNY",
            "HKD",
            "USD",
        }:
            raise DomainError("首版支持 CNY/HKD/USD")
        if values.get("valuation_mode") == "detailed_ledger":
            values["valuation_mode"] = "detailed"
        if values.get("valuation_mode") == "institution_snapshot":
            values["valuation_mode"] = "snapshot"
        if values.get("valuation_mode", "detailed") not in {"detailed", "snapshot"}:
            raise DomainError("无效计值模式")
        if (
            values.get("archived")
            and obj
            and any(p["account_id"] == str(obj.pk) for p in positions(space))
        ):
            raise DomainError("存在持仓，不能直接归档")
    if kind == "instruments":
        from .metadata_service import resolve_metadata
        from .option_positions import has_option_reference

        identity_fields = ("code", "kind", "market", "currency")
        base = {
            field: values.get(field, getattr(obj, field) if obj else "")
            for field in (*identity_fields, "name", "specification")
        }
        base["specification"] = base["specification"] or {}
        if body.get("overrides") is not None:
            base["overrides"] = body["overrides"]
        if base.get("code"):
            metadata = resolve_metadata(space, base)
            changing_identity = obj is None or any(
                field in values and values[field] != getattr(obj, field)
                for field in identity_fields
            )
            if changing_identity and metadata["status"] not in {"ambiguous", "unknown"}:
                for field in identity_fields:
                    if metadata.get(field):
                        values[field] = metadata[field]
                if not values.get("name") and not obj:
                    values["name"] = metadata["name"]
            values["specification"] = metadata["specification"]
        insights_spec = values.get("specification", obj.specification if obj else {})
        if not isinstance(insights_spec, dict):
            raise DomainError("产品说明须为对象")
        extra = dict(insights_spec)
        from .insights import validate_tag_specification

        extra = validate_tag_specification(space, extra)
        for k in ("strategy", "watchlisted"):
            if k in body:
                extra[k] = body[k]
        if obj and (
            m.PositionMovement.objects.filter(tenant=space, instrument=obj).exists()
            or m.Price.objects.filter(tenant=space, instrument=obj).exists()
            or m.Resource.objects.filter(
                tenant=space, kind="market_quotes", data__instrument_id=str(obj.pk)
            ).exists()
            or has_option_reference(space, instrument_id=obj.pk)
        ):
            if any(
                name in values and values[name] != getattr(obj, name)
                for name in ("code", "market", "currency", "share_class", "kind")
            ):
                raise DomainError(
                    "已有持仓或行情记录，产品身份不能直接变更，请另建正确产品"
                )
        if obj and has_option_reference(space, instrument_id=obj.pk):
            for key in (
                "exchange",
                "option_type",
                "option_right",
                "strike",
                "underlying_code",
                "contract_month",
                "contract_multiplier",
                "quote_unit",
                "unit",
            ):
                if obj.specification.get(key) is not None and extra.get(
                    key
                ) != obj.specification.get(key):
                    raise DomainError(
                        "已有期权持仓参考，不能改变合约规格；请另建正确合约"
                    )
        if "account_ids" in body or "account_ids" in extra:
            from .investments import validate_investment_account

            ids = body.get("account_ids", extra.get("account_ids"))
            if not isinstance(ids, list) or not ids or len(ids) > 100:
                raise DomainError("请选择至少一个对应账户")
            product = m.Instrument(
                **{
                    name: values.get(name, getattr(obj, name) if obj else default)
                    for name, default in [
                        ("kind", "fund"),
                        ("currency", "CNY"),
                        ("code", ""),
                        ("market", "CN"),
                    ]
                },
                specification=extra,
            )
            normalized = []
            for aid in dict.fromkeys(ids):
                account = get_obj(m.Account, space, aid)
                validate_investment_account(account, product)
                normalized.append(str(account.pk))
            extra["account_ids"] = normalized
        if obj:
            referenced_accounts = list(
                m.Resource.objects.filter(
                    tenant=space,
                    kind="option_positions",
                    data__instrument_id=str(obj.pk),
                ).values_list("data__account_id", flat=True)
            )
            if referenced_accounts:
                extra["account_ids"] = list(
                    dict.fromkeys([*extra.get("account_ids", []), *referenced_accounts])
                )
        values["specification"] = extra
    if kind in {"prices", "fx"}:
        key = "value" if kind == "prices" else "rate"
        if values.get(key, 0) <= 0:
            raise DomainError("价格或汇率必须大于零")
    if kind == "snapshots":
        if body.get("asset_kind") in {"future", "futures"}:
            account = values.get("account")
            if not account or account.kind not in {"future", "futures"}:
                raise DomainError(
                    "期货权益只能选择已录入的期货账户", "account_kind_mismatch"
                )
        if "coverage_confirmed" in body:
            if not isinstance(body["coverage_confirmed"], bool):
                raise DomainError("权益范围确认必须为布尔值")
            values["complete"] = body["coverage_confirmed"]
        if body.get("includes_options") is not None and not isinstance(
            body["includes_options"], bool
        ):
            raise DomainError("期权覆盖标志必须为布尔值或 null")
        if not isinstance(body.get("details", {}), dict):
            raise DomainError("快照补充信息必须为对象")
        values["details"] = {
            **body.get("details", {}),
            **{
                k: body[k]
                for k in (
                    "margin",
                    "available",
                    "source",
                    "positions",
                    "no_option_positions",
                )
                if k in body
            },
        }
        from .valuation_basis import validate_snapshot_basis

        values["details"].update(validate_snapshot_basis(body))
        if "no_option_positions" in values["details"] and not isinstance(
            values["details"]["no_option_positions"], bool
        ):
            raise DomainError("无期权持仓确认必须为布尔值")
        if (
            values["details"].get("no_option_positions") is True
            and body.get("includes_options") is not False
        ):
            raise DomainError("无期权持仓确认需同时声明期权包含标志为 false")
        for eid in values.get("included_event_ids", []):
            event = get_obj(m.Event, space, eid)
            if (
                values.get("account")
                and not event.lines.filter(
                    account=values["account"], code="cash"
                ).exists()
            ):
                raise DomainError("吸收入金事项必须涉及本快照账户的资金流水")
            if event.economic_date > day(values.get("economic_date")):
                raise DomainError("快照不能吸收未来资金流水")
        if (
            values.get("account")
            and values.get("currency") != values["account"].currency
        ):
            raise DomainError("权益快照币种与账户不符")
    if not obj:
        obj = model(tenant=space, created_by=request.user, **values)
    else:
        for k, v in values.items():
            setattr(obj, k, v)
        obj.version += 1
    obj.full_clean(exclude=["created_by"])
    obj.save()
    if kind == "accounts":
        from .recording_coverage import save_coverage

        save_coverage(space, request.user, obj, body)
    option_position = None
    if kind == "instruments" and "option_position" in body:
        from .option_positions import save_option_position

        option_position = save_option_position(
            space, request.user, body["option_position"], instrument=obj
        )
    initialized = False
    if kind == "accounts" and not ident:
        from .account_opening import initialize_account

        initialized = initialize_account(space, request.user, obj, body)
    if not initialized:
        bump(space, request.user)
    audit(space, request.user, f"{kind}.saved", obj)
    if kind == "instruments":
        from .market_sync import enabled, queue_refresh

        if enabled():
            queue_refresh(space, request.user, [str(obj.pk)])
    result = record(obj)
    if option_position is not None:
        result["option_position"] = option_position
    return result


def members(request, space, role, ident, body):
    qs = m.Membership.objects.filter(workspace=space).select_related("user")
    if request.method == "GET":
        return {
            "items": [
                {
                    "id": x.pk,
                    "user_id": x.user_id,
                    "username": x.user.username,
                    "role": x.role,
                    "version": 1,
                }
                for x in qs
            ]
        }
    require_owner(role)
    if request.method == "POST" and not ident:
        from .platform_admin import require_admin

        require_admin(request.user)
        person = User.objects.filter(
            pk=body.get("user_id"), is_active=True, is_superuser=False
        ).first()
        assigned_role = body.get("role", "viewer")
        if not person or assigned_role not in {"owner", "editor", "viewer"}:
            raise DomainError("请选择有效用户和成员角色")
        if qs.filter(user=person).exists():
            raise DomainError("用户已在该账簿中，请编辑现有成员")
        member = m.Membership.objects.create(
            workspace=space, user=person, role=assigned_role
        )
        audit(
            space,
            request.user,
            "member.admin_added",
            person.pk,
            {"role": assigned_role},
        )
        return {
            "id": member.pk,
            "user_id": person.pk,
            "username": person.username,
            "role": member.role,
            "version": 1,
        }
    member = qs.filter(pk=ident).first()
    if not member:
        raise DomainError("成员不存在", "not_found", 404)
    next_role = body.get("role")
    if (
        member.role == "owner"
        and qs.filter(role="owner").count() == 1
        and (request.method == "DELETE" or next_role != "owner")
    ):
        raise DomainError("不能移除或降级最后一位 Owner")
    if request.method == "DELETE":
        audit(space, request.user, "member.removed", member.user_id)
        member.delete()
        return {"ok": True}
    if next_role not in {"owner", "editor", "viewer"}:
        raise DomainError("无效角色")
    member.role = next_role
    member.save()
    audit(
        space, request.user, "member.role_changed", member.user_id, {"role": next_role}
    )
    return {"id": member.pk, "role": next_role, "version": 1}


def note_attachment(request, space, role, note, path, body):
    if note.kind != "notes":
        raise DomainError("附件仅支持笔记")
    if request.method == "GET":
        aid = path[3] if len(path) > 3 else None
        attachments = m.Resource.objects.filter(
            tenant=space, kind="note_attachments", data__note_id=str(note.pk)
        )
        if not aid:
            return {"items": [record(x) for x in attachments]}
        attachment = attachments.filter(pk=aid).first()
        if not attachment:
            raise DomainError("附件不存在", "not_found", 404)
        return FileResponse(
            open(settings.PRIVATE_MEDIA_ROOT / attachment.data["storage_key"], "rb"),
            content_type=attachment.data["content_type"],
        )
    if "file" not in request.FILES:
        raise DomainError("请选择图片附件")
    content = request.FILES["file"].read(5 * 1024 * 1024 + 1)
    if len(content) > 5 * 1024 * 1024:
        raise DomainError("图片超过 5MB")
    from PIL import Image

    try:
        image = Image.open(io.BytesIO(content))
        image.verify()
        if (
            image.format not in {"JPEG", "PNG", "WEBP"}
            or image.width * image.height > 20_000_000
        ):
            raise ValueError()
    except Exception:
        raise DomainError("请选择有效的 JPG、PNG 或 WebP 图片")
    key = f"{space.pk}/{uuid.uuid4()}.attachment"
    p = settings.PRIVATE_MEDIA_ROOT / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)
    p.chmod(0o600)
    item = m.Resource.objects.create(
        tenant=space,
        created_by=request.user,
        kind="note_attachments",
        data={
            "note_id": str(note.pk),
            "filename": Path(request.FILES["file"].name.replace("\\", "/")).name,
            "storage_key": key,
            "content_type": Image.MIME[image.format],
        },
    )
    audit(space, request.user, "note.attachment_added", note)
    return {"id": str(item.pk), "filename": item.data["filename"]}


def exports(request, space, role, ident, action):
    require_owner(role)
    if request.method == "POST":
        model_names = [
            "Account",
            "Instrument",
            "Event",
            "JournalLine",
            "PositionMovement",
            "Price",
            "FxRate",
            "ImportBatch",
            "SourceRecord",
            "SourceFact",
            "EvidenceLink",
            "Resource",
            "ResourceRevision",
            "Occurrence",
            "Snapshot",
            "Audit",
        ]
        output = {
            "schema": "wealth-v2",
            "workspace": record(space),
            "created_at": str(timezone.now()),
            "tables": {},
        }
        for name in model_names:
            model = getattr(m, name)
            output["tables"][name] = [
                record(x) for x in model.objects.filter(tenant=space)
            ]
        key = f"{space.pk}/{uuid.uuid4()}.export.zip"
        p = settings.PRIVATE_MEDIA_ROOT / key
        p.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(
                "wealth.json", json.dumps(serial(output), ensure_ascii=False, indent=2)
            )
            for b in m.ImportBatch.objects.filter(tenant=space):
                file = settings.PRIVATE_MEDIA_ROOT / b.storage_key
                if file.exists():
                    z.write(file, f"evidence/{b.pk}/{b.filename}")
            for attachment in m.Resource.objects.filter(
                tenant=space, kind="note_attachments"
            ):
                file = settings.PRIVATE_MEDIA_ROOT / attachment.data["storage_key"]
                if file.exists():
                    z.write(
                        file,
                        f"attachments/{attachment.pk}/{attachment.data['filename']}",
                    )
        p.chmod(0o600)
        export = m.Resource.objects.create(
            tenant=space,
            created_by=request.user,
            kind="exports",
            data={
                "storage_key": key,
                "status": "ready",
                "requested_by": request.user.pk,
                "revision": space.revision,
            },
        )
        audit(space, request.user, "export.created", export)
        return {
            "id": str(export.pk),
            "status": "ready",
            "download_url": f"/api/v1/spaces/{space.pk}/exports/{export.pk}/download",
        }
    export = get_obj(m.Resource, space, ident, kind="exports")
    if action == "download":
        if export.created_by_id != request.user.pk:
            raise DomainError("仅导出请求人可下载此结果", "forbidden", 403)
        audit(space, request.user, "export.downloaded", export)
        return FileResponse(
            open(settings.PRIVATE_MEDIA_ROOT / export.data["storage_key"], "rb"),
            as_attachment=True,
            filename="wealth-export.zip",
        )
    return {"id": str(export.pk), "status": export.data["status"]}
