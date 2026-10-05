"""Recoverable workspace deletion and one-use invitations."""

import hashlib
import secrets
from datetime import timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from . import models as m
from .common import DomainError, tenant_context, audit, bump, record
from .platform_admin import expected_version, is_platform_admin, log_admin


@transaction.atomic
def update_workspace_details(space, user, body):
    """Rename a book under a fresh owner/admin authorization and version lock.

    Call through an idempotent workspace/platform command. Currency, members,
    ownership and historical financial facts are deliberately outside this edit.
    """
    actor = get_user_model().objects.select_for_update().get(pk=user.pk)
    if not actor.is_active:
        raise DomainError("账号已停用", "forbidden", 403)
    space = m.Workspace.objects.select_for_update().filter(pk=space.pk).first()
    if not space or space.deleted_at:
        raise DomainError("账簿不存在", "not_found", 404)
    administrator = is_platform_admin(actor)
    if administrator:
        from .admin_access import require_delegation

        space = require_delegation(actor, space)
    if (
        not administrator
        and not m.Membership.objects.filter(
            workspace=space, user=actor, role="owner"
        ).exists()
    ):
        raise DomainError("仅空间所有者或平台管理员可修改账簿名", "forbidden", 403)
    if set(body) - {"version", "name", "timezone"}:
        raise DomainError("仅能修改账簿名与时区，币种和成员需使用对应管理功能")
    expected_version(body, space.revision)
    raw_name, tz = body.get("name", space.name), body.get("timezone", space.timezone)
    if not isinstance(raw_name, str) or not 1 <= len(raw_name.strip()) <= 100:
        raise DomainError("账簿名长度须为 1–100 个字符")
    if not isinstance(tz, str):
        raise DomainError("请选择有效的时区")
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise DomainError("请选择有效的时区") from None
    name = raw_name.strip()
    before = {"name": space.name, "timezone": space.timezone}
    space.name, space.timezone = name, tz
    space.save(update_fields=["name", "timezone"])
    with tenant_context(space.pk):
        bump(space, actor, invalidate_reconciliations=False)
        audit(
            space,
            actor,
            "workspace.admin_updated" if administrator else "workspace.updated",
            space,
            {"before": before, "after": {"name": name, "timezone": tz}},
        )
    if administrator:
        log_admin(
            actor,
            "space.updated",
            space.pk,
            {"before": before, "after": {"name": name, "timezone": tz}},
        )
    return space


def create_invitation(space, user, body):
    role = body.get("role", "viewer")
    if role not in {"owner", "editor", "viewer"}:
        raise DomainError("无效角色")
    try:
        days = int(body.get("expires_days", 7))
    except (TypeError, ValueError):
        raise DomainError("有效期须为 1 至 30 天") from None
    if not 1 <= days <= 30:
        raise DomainError("有效期须为 1 至 30 天")
    if space.deleted_at:
        raise DomainError("此空间已移入回收站", "not_found", 404)
    secret = secrets.token_urlsafe(32)
    inv = m.Invitation.objects.create(
        tenant=space,
        created_by=user,
        token_hash=hashlib.sha256(secret.encode()).hexdigest(),
        role=role,
        expires_at=timezone.now() + timedelta(days=days),
    )
    audit(space, user, "invitation.created", inv)
    return dict(
        record(inv),
        token=f"{space.pk}.{secret}",
        sharing="注册时填写邀请码，加入后按角色共享本空间；邀请码仅能使用一次",
    )


def deleted_spaces(user):
    qs = m.Workspace.objects.filter(deleted_at__isnull=False).order_by("-deleted_at")
    if not is_platform_admin(user):
        qs = qs.filter(membership__user=user, membership__role="owner")
    return {"items": [dict(record(s), version=s.revision) for s in qs]}


def change_workspace_state(request, ident, restore, body):
    from .views import write_command

    with transaction.atomic():
        actor = get_user_model().objects.select_for_update().get(pk=request.user.pk)
        if not actor.is_active:
            raise DomainError("账号已停用", "forbidden", 403)
        space = m.Workspace.objects.select_for_update().filter(pk=ident).first()
        administrator = is_platform_admin(actor)
        owner = (
            space
            and m.Membership.objects.filter(
                workspace=space, user=actor, role="owner"
            ).exists()
        )
        if not space or not (administrator or owner):
            raise DomainError("空间不存在或未获管理授权", "not_found", 404)
        with tenant_context(space.pk):

            def save():
                expected_version(body, space.revision)
                if not restore and body.get("confirm_name") != space.name:
                    raise DomainError("请输入完整空间名称以确认删除")
                if bool(space.deleted_at) == (not restore):
                    raise DomainError("空间状态已变化，请刷新", "version_conflict", 412)
                space.deleted_at = None if restore else timezone.now()
                space.revision += 1
                space.save(update_fields=["deleted_at", "revision"])
                if not restore:
                    m.Invitation.objects.filter(tenant=space, revoked=False).update(
                        revoked=True
                    )
                audit(
                    space,
                    actor,
                    "workspace.restored" if restore else "workspace.deleted",
                    space,
                )
                if administrator:
                    log_admin(
                        actor,
                        "space.restored" if restore else "space.deleted",
                        space.pk,
                    )
                return dict(record(space), version=space.revision, recoverable=True)

            return write_command(
                request,
                space,
                "workspace.restore" if restore else "workspace.delete",
                body,
                save,
            )
