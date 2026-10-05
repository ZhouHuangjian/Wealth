"""Owner-controlled, revocable consent for platform administrators to enter a book."""

from django.contrib.auth import get_user_model
from django.db import transaction

from . import models as m
from .common import DomainError, audit, tenant_context


def require_delegation(actor, space):
    """Re-read consent while locking the book through the delegated operation.

    Call inside a transaction, before looking up cached command results. Keeping
    this lock means completed revocations also fence in-flight delegated work.
    Lifecycle operations (user/whole-book deletion and restoration) are separate.
    """
    from .platform_admin import require_admin

    require_admin(actor)
    current = (
        m.Workspace.objects.select_for_update()
        .filter(pk=getattr(space, "pk", space), deleted_at__isnull=True)
        .first()
    )
    if not current:
        raise DomainError("空间不存在或已删除", "not_found", 404)
    if not current.admin_access_enabled:
        raise DomainError(
            "空间所有者尚未允许管理员代管，请由所有者在设置中开启",
            "admin_access_required",
            403,
        )
    return current


def owner_can_manage(actor, space):
    # A platform administrator must never acquire consent through an owner role,
    # including legacy/injected memberships or the delegated UI's synthetic role.
    return bool(
        actor.is_active
        and not actor.is_superuser
        and m.Membership.objects.filter(
            user=actor, workspace=space, role="owner"
        ).exists()
    )


def access_record(actor, space):
    return {
        "enabled": space.admin_access_enabled,
        "version": space.admin_access_version,
        "can_manage": owner_can_manage(actor, space),
    }


def require_consent_owner(actor, space):
    if not owner_can_manage(actor, space):
        raise DomainError(
            "仅空间所有者的普通账号可以设置管理员代管授权", "forbidden", 403
        )


@transaction.atomic
def update_access(actor, space, body):
    from .platform_admin import expected_version

    actor = get_user_model().objects.select_for_update().get(pk=actor.pk)
    space = m.Workspace.objects.select_for_update().get(pk=space.pk)
    if space.deleted_at:
        raise DomainError("空间已删除", "not_found", 404)
    require_consent_owner(actor, space)
    if set(body) - {"enabled", "version"} or not isinstance(body.get("enabled"), bool):
        raise DomainError("请明确选择允许或关闭管理员代管")
    expected_version(body, space.admin_access_version)
    before = space.admin_access_enabled
    space.admin_access_enabled = body["enabled"]
    space.admin_access_version += 1
    space.save(update_fields=["admin_access_enabled", "admin_access_version"])
    with tenant_context(space.pk):
        audit(
            space,
            actor,
            "workspace.admin_access.changed",
            space,
            {
                "before": before,
                "enabled": space.admin_access_enabled,
                "version": space.admin_access_version,
            },
        )
    return access_record(actor, space)
