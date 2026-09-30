import hashlib
import json
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, localcontext
from uuid import UUID
from django.db import connection, transaction
from django.utils import timezone
from .models import Workspace, Membership, Audit, Outbox, Resource


class DomainError(Exception):
    def __init__(self, message, code="invalid", status=422, fields=None):
        self.message, self.code, self.status, self.fields = (
            message,
            code,
            status,
            fields or {},
        )
        super().__init__(message)


def serial(value):
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (UUID, date, datetime)):
        return str(value)
    if isinstance(value, dict):
        return {k: serial(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serial(v) for v in value]
    return value


def digest(value):
    return hashlib.sha256(
        json.dumps(
            serial(value), sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()


def dec(value, *, nonnegative=False, places=12):
    if isinstance(value, (float, bool)) or value in (None, ""):
        raise DomainError("金额必须是十进制字符串，未知值不能填零")
    try:
        n = Decimal(str(value))
    except InvalidOperation:
        raise DomainError("金额格式不正确")
    if not n.is_finite() or (nonnegative and n < 0):
        raise DomainError("金额须为有限且有效的数值")
    if n.as_tuple().exponent < -places or n.adjusted() >= 38 - places:
        raise DomainError("数值超过支持的精度或范围")
    return n


def day(value=None):
    try:
        return date.fromisoformat(str(value)) if value else timezone.localdate()
    except ValueError:
        raise DomainError("日期须为 YYYY-MM-DD")


def money_round(value):
    with localcontext() as ctx:
        ctx.prec = 160
        return value.quantize(Decimal("0.000000000001"))


def get_obj(model, space, ident, **filters):
    try:
        obj = model.objects.filter(tenant=space, pk=ident, **filters).first()
    except (
        ValueError,
        TypeError,
        __import__("django").core.exceptions.ValidationError,
    ):
        obj = None
    if not obj:
        raise DomainError("记录不存在或不属于当前空间", "not_found", 404)
    from .models import Account, Instrument

    if model in {Account, Instrument}:
        from .catalog_lifecycle import is_catalog_deleted

        kind = "accounts" if model is Account else "instruments"
        if is_catalog_deleted(space, kind, obj.pk):
            raise DomainError(
                "此档案已删除，请先在已删除列表中恢复", "catalog_deleted", 409
            )
    return obj


def catalog_queryset(model, space):
    """Active account/product catalog; historical facts keep their original FKs."""
    from .catalog_lifecycle import deleted_catalog_ids
    from .models import Account, Instrument

    if model not in {Account, Instrument}:
        raise ValueError("Expected an account or instrument catalog")
    kind = "accounts" if model is Account else "instruments"
    return model.objects.filter(tenant=space).exclude(
        pk__in=deleted_catalog_ids(space, kind)
    )


@contextmanager
def tenant_context(space_id):
    with transaction.atomic():
        previous = ""
        if connection.vendor == "postgresql":
            with connection.cursor() as cursor:
                cursor.execute("SELECT current_setting('app.tenant_id', true)")
                previous = cursor.fetchone()[0] or ""
                cursor.execute(
                    "SELECT set_config('app.tenant_id', %s, true)", [str(space_id)]
                )
        try:
            with localcontext() as ctx:
                ctx.prec = 160
                yield
        finally:
            if connection.vendor == "postgresql" and not connection.needs_rollback:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT set_config('app.tenant_id', %s, true)", [previous]
                    )


def audit(space, user, action, obj, detail=None):
    Audit.objects.create(
        tenant=space,
        created_by=user,
        action=action,
        object_id=str(getattr(obj, "pk", obj)),
        detail=serial(detail or {}),
    )


def bump(space, user=None, invalidate_reconciliations=True):
    locked = Workspace.objects.select_for_update().get(pk=space.pk)
    locked.revision += 1
    locked.save(update_fields=["revision"])
    space.revision = locked.revision
    Outbox.objects.get_or_create(
        tenant=space,
        revision=space.revision,
        kind="recompute",
        defaults={"created_by": user},
    )
    for rec in (
        Resource.objects.filter(tenant=space, kind="reconciliations")
        if invalidate_reconciliations
        else []
    ):
        if rec.data.get("status") == "matched":
            from .models import ResourceRevision

            ResourceRevision.objects.get_or_create(
                tenant=space,
                resource=rec,
                version=rec.version,
                defaults={"created_by": user, "data": dict(rec.data)},
            )
            rec.data["status"] = "stale"
            rec.version += 1
            rec.save(update_fields=["data", "version"])
            ResourceRevision.objects.get_or_create(
                tenant=space,
                resource=rec,
                version=rec.version,
                defaults={"created_by": user, "data": dict(rec.data)},
            )
    return space.revision


def record(obj):
    from .models import Resource

    result = {}
    for f in obj._meta.fields:
        if f.name in ("storage_key", "token_hash"):
            continue
        key = f.name + "_id" if f.is_relation else f.name
        result[key] = serial(getattr(obj, f.attname))
    if isinstance(obj, Resource):
        data = {
            k: v for k, v in obj.data.items() if k not in {"storage_key", "token_hash"}
        }
        result["data"] = serial(data)
        result.update(serial(data))
        result["id"] = str(obj.pk)
        result["version"] = obj.version
    return result
