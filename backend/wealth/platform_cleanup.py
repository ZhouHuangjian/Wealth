"""Explicit platform erasure, with database-scoped exceptions and durable file cleanup."""

import logging
import shutil
import uuid
from pathlib import Path

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from . import models as m
from .common import DomainError, audit, record, tenant_context
from .platform_admin import expected_version, log_admin, revoke_sessions
from .platform_models import PlatformSetting

logger = logging.getLogger(__name__)
FILE_CLEANUP_PREFIX = "workspace_file_cleanup:"


def delete_user(actor, user, body):
    if body.get("confirm_username") != user.username:
        raise DomainError("请输入完整用户名以确认永久删除账号")
    if user.pk == actor.pk:
        raise DomainError("不能删除当前登录的管理员")
    if user.is_active and user.is_superuser:
        if (
            not type(user)
            .objects.filter(is_active=True, is_superuser=True)
            .exclude(pk=user.pk)
            .exists()
        ):
            raise DomainError("必须保留至少一位可用的平台管理员")
    memberships = list(
        m.Membership.objects.filter(user=user).select_related("workspace")
    )
    stranded = [
        str(member.workspace_id)
        for member in memberships
        if member.role == "owner"
        and member.workspace.deleted_at is None
        and not m.Membership.objects.filter(
            workspace_id=member.workspace_id,
            role="owner",
            user__is_active=True,
            user__is_superuser=False,
        )
        .exclude(user=user)
        .exists()
    ]
    if stranded:
        raise DomainError(
            "该用户仍是部分使用中空间的唯一所有者，请先转交所有者或将这些空间移入回收站",
            fields={"space_ids": stranded},
        )
    result = {
        "id": user.pk,
        "username": user.username,
        "deleted": True,
        "removed_memberships": len(memberships),
    }
    revoke_sessions(user)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT public.wealth_delete_platform_user(%s,%s,%s,%s)",
            [actor.pk, user.pk, body["version"], user.username],
        )
    log_admin(
        actor,
        "user.deleted",
        user.pk,
        {
            "username": user.username,
            "removed_memberships": len(memberships),
            "spaces_deleted": 0,
        },
    )
    return result


def admin_space_state(actor, ident, action, body):
    space = m.Workspace.objects.select_for_update().filter(pk=ident).first()
    if not space:
        raise DomainError("空间不存在", "not_found", 404)
    expected_version(body, space.revision)
    if action != "restore" and body.get("confirm_name") != space.name:
        raise DomainError("请输入完整空间名称以确认删除")
    if action == "purge":
        if not space.deleted_at:
            raise DomainError("请先将空间移入回收站，再执行永久删除")
        sid = str(space.pk)
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.wealth_purge_workspace(%s,%s,%s,%s)",
                [actor.pk, sid, space.revision, space.name],
            )
        PlatformSetting.objects.update_or_create(
            key=FILE_CLEANUP_PREFIX + sid,
            defaults={"data": {"space_id": sid, "status": "pending"}, "version": 1},
        )
        log_admin(actor, "space.purged", sid, {"name": space.name, "permanent": True})
        transaction.on_commit(lambda: cleanup_workspace_files(sid))
        return {
            "id": sid,
            "deleted": True,
            "purged": True,
            "attachment_cleanup": "scheduled",
        }
    restore = action == "restore"
    if bool(space.deleted_at) == (not restore):
        raise DomainError("空间状态已变化，请刷新", "version_conflict", 412)
    space.deleted_at = None if restore else timezone.now()
    space.revision += 1
    space.save(update_fields=["deleted_at", "revision"])
    with tenant_context(space.pk):
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
    log_admin(actor, "space.restored" if restore else "space.deleted", space.pk)
    return dict(record(space), version=space.revision, recoverable=True)


def cleanup_workspace_files(space_id):
    """Retryable after commit. Never follow a supplied path or symlink."""
    sid = str(uuid.UUID(str(space_id)))
    key = FILE_CLEANUP_PREFIX + sid
    if m.Workspace.objects.filter(pk=sid).exists():
        return False
    marker = PlatformSetting.objects.filter(pk=key).first()
    if not marker or marker.data.get("status") == "complete":
        return True
    directory = Path(settings.PRIVATE_MEDIA_ROOT).resolve() / sid
    try:
        if directory.is_symlink():
            directory.unlink()
        elif directory.exists():
            shutil.rmtree(directory)
        PlatformSetting.objects.filter(pk=key).update(
            data={"space_id": sid, "status": "complete"}
        )
        return True
    except OSError:
        # The durable marker survives process death and is retried by the worker.
        logger.exception("Workspace attachment erasure will be retried for %s", sid)
        return False


def retry_pending_file_cleanup(limit=20):
    markers = list(
        PlatformSetting.objects.filter(
            key__startswith=FILE_CLEANUP_PREFIX, data__status="pending"
        )[:limit]
    )
    return {
        "completed": sum(
            cleanup_workspace_files(item.data["space_id"]) for item in markers
        )
    }
