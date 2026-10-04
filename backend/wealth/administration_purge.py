"""Previewed, tenant-scoped erasure of a deleted business record and its dependencies."""

from collections import defaultdict
from decimal import Decimal
import json

from django.db import connection, transaction

from . import models as m
from .common import DomainError, audit, bump, digest, record, serial
from .platform_admin import log_admin, require_admin

# Only these business tables may be removed. Permissions, audit, invitations and
# credentials are deliberately outside this operation.
MODELS = (
    m.JournalLine,
    m.PositionMovement,
    m.SourceFact,
    m.EvidenceLink,
    m.SourceRecord,
    m.Occurrence,
    m.Snapshot,
    m.Price,
    m.FxRate,
    m.ResourceRevision,
    m.Resource,
    m.ImportBatch,
    m.Event,
)
LABELS = {
    "event": "交易及更正记录",
    "journalline": "资金分录",
    "positionmovement": "持仓变动",
    "sourcefact": "导入对应关系",
    "evidencelink": "原始凭证关联",
    "sourcerecord": "账单明细",
    "occurrence": "计划期次",
    "snapshot": "机构权益",
    "price": "行情净值",
    "fxrate": "汇率",
    "resourcerevision": "配置历史",
    "resource": "关联配置",
    "importbatch": "导入批次",
    "account": "账户",
    "instrument": "投资产品",
}
LIMIT = 20000


def references(value):
    if isinstance(value, dict):
        return set().union(*(references(v) for v in value.values())) if value else set()
    if isinstance(value, (list, tuple)):
        return set().union(*(references(v) for v in value)) if value else set()
    return {value} if isinstance(value, str) else set()


def _manager(model):
    return getattr(model, "all_objects", model.objects)


def plan(space, category, obj):
    from .administration_data import deleted, item_record

    if not deleted(space, category, obj):
        raise DomainError(
            "请先将记录移入已删除列表，再进行彻底删除", "not_deleted", 409
        )
    rows = {model: list(_manager(model).filter(tenant=space)) for model in MODELS}
    if sum(map(len, rows.values())) > LIMIT:
        raise DomainError("账簿数据较多，请先导出并联系管理员分批整理；本次未删除数据")
    selected = {str(obj.pk)}
    entries = {str(row.pk): row for group in rows.values() for row in group}
    entries[str(obj.pk)] = obj
    dependencies = {}
    for ident, row in entries.items():
        refs = set()
        for field in row._meta.fields:
            if field.is_relation and field.name not in {"tenant", "created_by"}:
                value = getattr(row, field.attname)
                if value is not None:
                    refs.add(str(value))
            elif field.get_internal_type() == "JSONField":
                refs.update(references(getattr(row, field.name)))
        dependencies[ident] = refs
    events = {str(row.pk): row for row in rows[m.Event]}
    for item in m.Audit.objects.filter(tenant=space, action="occurrence.confirmed"):
        if item.object_id in dependencies:
            dependencies[item.object_id].update(references(item.detail))
    # A transfer, confirmation or reversal must never lose only one side. Keep
    # an entire operation together and include later cost-dependent movements.
    for _ in range(LIMIT):
        previous = set(selected)
        for k, refs in dependencies.items():
            if not refs & selected:
                continue
            row = entries[k]
            if isinstance(row, m.Occurrence) and str(row.plan_id) not in selected:
                # Keep the sequence as cancelled so the scheduler cannot recreate it.
                continue
            if (
                isinstance(row, m.Resource)
                and row.kind == "investment_tags"
                and k != str(obj.pk)
            ):
                continue
            selected.add(k)
        for row in rows[m.Resource]:
            if str(row.pk) in selected and row.kind == "administration_observations":
                target = row.data.get("target_id")
                if target in entries:
                    selected.add(target)
        selected.update(
            str(row.event_id)
            for model in (m.JournalLine, m.PositionMovement)
            for row in rows[model]
            if str(row.pk) in selected
        )
        selected_events = [row for key, row in events.items() if key in selected]
        operations = {row.operation_id for row in selected_events}
        selected.update(
            key for key, row in events.items() if row.operation_id in operations
        )
        for row in selected_events:
            selected.update(str(x) for x in (row.related_id, row.reverses_id) if x)
        earliest = {}
        for row in rows[m.PositionMovement]:
            if str(row.event_id) in selected:
                key = (row.account_id, row.instrument_id)
                created = events[str(row.event_id)].created_at
                earliest[key] = min(earliest.get(key, created), created)
        for row in rows[m.PositionMovement]:
            key = (row.account_id, row.instrument_id)
            if (
                key in earliest
                and events[str(row.event_id)].created_at >= earliest[key]
            ):
                selected.add(str(row.event_id))
        # Remove target evidence rows as well as their link, but retain unrelated
        # rows and shared source files in mixed imports.
        selected.update(
            str(row.record_id)
            for row in rows[m.EvidenceLink]
            if str(row.pk) in selected
        )
        if selected == previous:
            break
    else:
        raise DomainError("关联数据无法收敛，本次未删除任何记录")
    chosen = [entries[k] for k in selected if k in entries]
    tables = defaultdict(list)
    for row in chosen:
        tables[row._meta.db_table].append(str(row.pk))
    tables = {key: sorted(value) for key, value in sorted(tables.items())}
    deltas = defaultdict(lambda: Decimal(0))
    for row in rows[m.JournalLine]:
        if (
            str(row.pk) in selected
            and row.account_id
            and row.code in {"cash", "liability"}
        ):
            deltas[(str(row.account_id), row.currency)] -= row.amount
    accounts = {str(a.pk): a for a in m.Account.objects.filter(tenant=space)}
    cash_effects = [
        {
            "account_id": aid,
            "account_name": accounts[aid].name,
            "currency": currency,
            "change": amount,
            "account_removed": category == "accounts" and aid == str(obj.pk),
        }
        for (aid, currency), amount in sorted(deltas.items())
        if amount != 0
    ]
    catalog_updates = []
    for product in m.Instrument.objects.filter(tenant=space):
        if (
            str(product.pk) not in selected
            and references(product.specification) & selected
        ):
            catalog_updates.append(product)
    resource_updates = [
        row
        for row in rows[m.Resource]
        if str(row.pk) not in selected
        and row.kind == "investment_tags"
        and references(row.data) & selected
    ]
    occurrence_updates = [
        row
        for row in rows[m.Occurrence]
        if str(row.pk) not in selected and (dependencies[str(row.pk)] & selected)
    ]
    payload = {
        "tables": tables,
        "versions": sorted((str(x.pk), x.version) for x in chosen),
        "catalog_versions": [(str(x.pk), x.version) for x in catalog_updates],
        "resource_versions": [(str(x.pk), x.version) for x in resource_updates],
        "occurrence_versions": [(str(x.pk), x.version) for x in occurrence_updates],
        "revision": space.revision,
    }
    result = {
        "item": item_record(space, category, obj),
        "data_revision": space.revision,
        "preview_token": digest(payload),
        "record_count": len(chosen),
        "counts": [
            {"name": LABELS[key.removeprefix("wealth_")], "count": len(ids)}
            for key, ids in tables.items()
        ],
        "cash_effects": cash_effects,
        "updated_product_count": len(catalog_updates),
        "retained_tag_count": len(resource_updates),
        "cancelled_occurrence_count": len(occurrence_updates),
        "affected_items": [
            {
                "type": LABELS[row._meta.model_name],
                "id": str(row.pk),
                "name": getattr(row, "name", None)
                or getattr(row, "description", None)
                or (
                    row.data.get("name") or row.data.get("title")
                    if isinstance(row, m.Resource)
                    else None
                )
                or LABELS[row._meta.model_name],
                "account": accounts[str(row.account_id)].name
                if getattr(row, "account_id", None)
                else None,
            }
            for row in chosen
            if isinstance(row, (m.Event, m.Resource, m.Snapshot, m.PositionMovement))
        ]
        + [
            {
                "type": "保留并移除关联",
                "id": str(row.pk),
                "name": row.name
                if isinstance(row, m.Instrument)
                else row.data.get("name", "投资标签"),
            }
            for row in [*catalog_updates, *resource_updates]
        ],
        "retained": "操作审计、共用原始账单文件和已有备份按原保留规则保留；已删除业务记录不能在回收站恢复。",
    }
    return (
        serial(result),
        tables,
        {
            "products": catalog_updates,
            "resources": resource_updates,
            "occurrences": occurrence_updates,
        },
        selected,
    )


def _prune(value, ids):
    if isinstance(value, dict):
        return {
            k: _prune(v, ids)
            for k, v in value.items()
            if not (isinstance(v, str) and v in ids)
        }
    if isinstance(value, list):
        return [_prune(v, ids) for v in value if not (isinstance(v, str) and v in ids)]
    return value


@transaction.atomic
def purge(request, space, category, ident, body):
    from .administration_data import _target, _guard

    require_admin(request.user)
    from .admin_access import require_delegation

    space = require_delegation(request.user, space)
    space = m.Workspace.objects.select_for_update().get(pk=space.pk)
    if space.deleted_at:
        raise DomainError("空间已删除", "not_found", 404)
    obj = _target(space, category, ident)
    reason = _guard(space, obj, body)
    preview, tables, updates, ids = plan(space, category, obj)
    if (
        body.get("confirm_name") != preview["item"]["name"]
        or body.get("confirm") is not True
    ):
        raise DomainError(
            "请填写完整名称并确认彻底删除关联记录", "purge_confirmation_required"
        )
    if body.get("preview_token") != preview["preview_token"]:
        raise DomainError(
            "删除影响已变化，请重新预览后确认", "purge_preview_changed", 409
        )
    for product in updates["products"]:
        before = record(product)
        product.specification = _prune(product.specification, ids)
        product.version += 1
        product.save(update_fields=["specification", "version"])
        audit(
            space,
            request.user,
            "administration.references.cleaned",
            product,
            {"before": before, "after": record(product)},
        )
    for resource in updates["resources"]:
        resource.data = _prune(resource.data, ids)
        resource.version += 1
        resource.save(update_fields=["data", "version"])
        m.ResourceRevision.objects.create(
            tenant=space,
            created_by=request.user,
            resource=resource,
            version=resource.version,
            data=resource.data,
        )
        audit(space, request.user, "administration.references.cleaned", resource)
    for occurrence in updates["occurrences"]:
        occurrence.event_id = None
        occurrence.status = "cancelled"
        occurrence.details = {"permanently_removed": True, "reason": reason}
        occurrence.version += 1
        occurrence.save(update_fields=["event", "status", "details", "version"])
        audit(space, request.user, "administration.occurrence.cancelled", occurrence)
    # Preserve retry identities without returning obsolete records to old clients.
    for item in m.Idempotency.objects.filter(tenant=space):
        if references(item.result) & ids:
            item.result = {"purged": True, "message": "关联记录已彻底删除，请刷新页面"}
            item.save(update_fields=["result"])
    m.Projection.objects.filter(tenant=space).delete()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT public.wealth_purge_business_record(%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
            [
                request.user.pk,
                str(space.pk),
                obj._meta.db_table,
                str(obj.pk),
                space.revision,
                obj.version,
                preview["item"]["name"],
                json.dumps(tables),
            ],
        )
    revision = bump(space, request.user)
    detail = {
        "category": category,
        "name": preview["item"]["name"],
        "reason": reason,
        "counts": preview["counts"],
        "cash_effects": preview["cash_effects"],
    }
    audit(space, request.user, "administration.record.purged", obj, detail)
    log_admin(
        request.user,
        "business_record.purged",
        ident,
        {**detail, "space_id": str(space.pk)},
    )
    return {
        "id": str(ident),
        "purged": True,
        "data_revision": revision,
        "counts": preview["counts"],
    }
