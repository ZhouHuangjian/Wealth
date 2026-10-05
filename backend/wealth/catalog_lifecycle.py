"""Recoverable removal of unused catalog entries; financial facts stay intact."""

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .common import DomainError, audit, bump, day, dec, record, serial
from .models import (
    Account,
    Event,
    ImportBatch,
    Instrument,
    JournalLine,
    Occurrence,
    PositionMovement,
    Price,
    Resource,
    ResourceRevision,
    Snapshot,
    SourceRecord,
    Workspace,
)

KIND = "catalog_deletions"
MODELS = {"accounts": Account, "instruments": Instrument}


def deleted_catalog_ids(space, kind):
    if kind not in MODELS:
        return []
    return list(
        Resource.objects.filter(
            tenant=space,
            kind=KIND,
            data__target_kind=kind,
            data__status="deleted",
        ).values_list("data__target_id", flat=True)
    )


def is_catalog_deleted(space, kind, ident):
    return (
        kind in MODELS
        and Resource.objects.filter(
            tenant=space,
            kind=KIND,
            data__target_kind=kind,
            data__target_id=str(ident),
            data__status="deleted",
        ).exists()
    )


def filter_active_catalog(queryset, space, kind):
    return queryset.exclude(pk__in=deleted_catalog_ids(space, kind))


def _target(space, kind, ident):
    if kind not in MODELS:
        raise DomainError("不支持此档案的删除操作", "not_found", 404)
    try:
        obj = MODELS[kind].objects.filter(tenant=space, pk=ident).first()
    except (ValidationError, ValueError, TypeError):
        obj = None
    if obj is None:
        raise DomainError("记录不存在或不属于当前空间", "not_found", 404)
    return obj


def _tombstone(space, kind, ident):
    rows = list(
        Resource.objects.filter(
            tenant=space, kind=KIND, data__target_kind=kind, data__target_id=str(ident)
        )
    )
    if len(rows) > 1:
        raise DomainError(
            "删除记录存在重复，请先核对", "catalog_lifecycle_conflict", 409
        )
    return rows[0] if rows else None


def _references(value, ident):
    """Exact JSON references, including nested account lists and funding routes."""
    if isinstance(value, dict):
        return any(_references(item, ident) for item in value.values())
    if isinstance(value, list):
        return any(_references(item, ident) for item in value)
    return isinstance(value, str) and value == ident


def _dependency(code, message, rows):
    rows = list(rows)
    if not rows:
        return None
    return {
        "code": code,
        "message": message,
        "count": len(rows),
        "items": [
            {
                "id": str(row.pk),
                "name": getattr(row, "name", None)
                or getattr(row, "description", None)
                or (getattr(row, "data", {}) or {}).get("name")
                or (getattr(row, "data", {}) or {}).get("title")
                or getattr(row, "filename", None)
                or getattr(row, "kind", None)
                or str(row.pk),
            }
            for row in rows[:20]
        ],
    }


def _initial_event(event, account, trusted_ids):
    from .ledger import cash_code

    original = event.reverses if event.reverses_id else event
    if (
        original.kind != "opening"
        or str(original.pk) not in trusted_ids
        or original.payload.get("instrument_id")
        or original.payload.get("opening_source") == "existing_holding"
        or original.related_id
        or original.movements.exists()
    ):
        return False
    lines = list(original.lines.all())
    account_lines = [line for line in lines if line.account_id == account.pk]
    equity_lines = [
        line for line in lines if line.account_id is None and line.code == "equity"
    ]
    return (
        original.payload.get("account_id") == str(account.pk)
        and len(lines) == 2
        and len(account_lines) == len(equity_lines) == 1
        and account_lines[0].code == cash_code(account)
        and all(
            line.currency == account.currency and line.instrument_id is None
            for line in lines
        )
        and account_lines[0].amount + equity_lines[0].amount == 0
    )


def _dependencies(space, kind, obj):
    from .account_opening import trusted_opening_ids

    ident = str(obj.pk)
    blockers = []
    trusted = trusted_opening_ids(space, obj) if kind == "accounts" else {}
    if kind == "accounts":
        line_ids = JournalLine.objects.filter(tenant=space, account=obj).values_list(
            "event_id", flat=True
        )
        movement_ids = PositionMovement.objects.filter(
            tenant=space, account=obj
        ).values_list("event_id", flat=True)
    else:
        line_ids = JournalLine.objects.filter(tenant=space, instrument=obj).values_list(
            "event_id", flat=True
        )
        movement_ids = PositionMovement.objects.filter(
            tenant=space, instrument=obj
        ).values_list("event_id", flat=True)
    financial_ids = {str(pk) for pk in line_ids} | {str(pk) for pk in movement_ids}
    events = [
        event
        for event in Event.objects.filter(tenant=space).select_related("reverses")
        if str(event.pk) in financial_ids or _references(event.payload, ident)
    ]
    unsafe = (
        events
        if kind == "instruments"
        else [
            event for event in events if not _initial_event(event, obj, trusted["cash"])
        ]
    )
    blockers.append(
        _dependency(
            "financial_history",
            "已有实际流水或持仓记录，不能删除；已冲正的历史也会保留。",
            unsafe,
        )
    )
    retained = {
        "opening_events": len(events) - len(unsafe),
        "prices": 0,
        "market_resources": 0,
    }
    if kind == "accounts":
        snapshots = list(Snapshot.objects.filter(tenant=space, account=obj))
        other_snapshots = [
            row
            for row in snapshots
            if str(row.pk) not in trusted["snapshot"] or row.included_event_ids
        ]
        retained["opening_snapshots"] = len(snapshots) - len(other_snapshots)
        blockers.append(
            _dependency(
                "snapshots",
                "已有后续机构权益记录，请保留账户用于历史核对。",
                other_snapshots,
            )
        )
        batches = list(ImportBatch.objects.filter(tenant=space, account=obj))
        blockers.append(
            _dependency("imports", "已关联导入账单，请先处理账单引用。", batches)
        )
        linked = [
            row
            for row in filter_active_catalog(
                Instrument.objects.filter(tenant=space), space, "instruments"
            )
            if _references(row.specification, ident)
        ]
        blockers.append(
            _dependency(
                "linked_products",
                "投资产品仍关联此账户，请先修改产品的关联账户或删除未使用产品。",
                linked,
            )
        )
    else:
        retained["prices"] = Price.objects.filter(tenant=space, instrument=obj).count()
        linked = [
            row
            for row in filter_active_catalog(
                Instrument.objects.filter(tenant=space).exclude(pk=obj.pk),
                space,
                "instruments",
            )
            if _references(row.specification, ident)
        ]
        blockers.append(
            _dependency(
                "linked_products",
                "其他投资产品仍引用此产品，请先处理关联配置。",
                linked,
            )
        )
    imported = [
        row
        for row in SourceRecord.objects.filter(tenant=space)
        if _references(row.normalized, ident) or _references(row.raw, ident)
    ]
    blockers.append(
        _dependency(
            "import_records", "导入账单中仍有此档案的引用，请先处理相关记录。", imported
        )
    )
    dependencies = {}
    for resource in Resource.objects.filter(tenant=space).exclude(kind=KIND):
        if not _references(resource.data, ident):
            continue
        if resource.kind == "market_quotes":
            retained["market_resources"] += 1
            continue
        dependencies.setdefault(resource.kind, []).append(resource)
    labels = {
        "plans": "定投或收支计划仍引用此档案，请先修改计划。",
        "loans": "借贷计划仍引用此账户，请先处理计划。",
        "option_positions": "已有期权持仓参考，请保留档案用于核对。",
        "reservations": "资金预留仍引用此账户，请先处理资金预留。",
        "dca_import_periods": "已有历史定投补录期次，请保留原始关联。",
        "holding_valuations": "已有持仓估值记录，请保留原始关联。",
    }
    for resource_kind, rows in dependencies.items():
        blockers.append(
            _dependency(
                f"resource_{resource_kind}",
                labels.get(
                    resource_kind, "其他配置或参考记录仍引用此档案，请先处理关联。"
                ),
                rows,
            )
        )
    occurrences = [
        row
        for row in Occurrence.objects.filter(tenant=space)
        if _references(row.details, ident)
    ]
    blockers.append(
        _dependency(
            "occurrences", "计划期次仍引用此档案，请先处理计划及期次。", occurrences
        )
    )
    return [row for row in blockers if row], retained


def _impact(space, kind, obj):
    if kind == "instruments":
        from .reporting import positions

        rows = [p for p in positions(space) if p["instrument_id"] == str(obj.pk)]
        contributing = [p for p in rows if p["contributes"]]
        amount = (
            sum((p["market_value"] for p in contributing), dec("0"))
            if all(p["market_value"] is not None for p in contributing)
            else None
        )
        return {
            "currency": obj.currency,
            "removed_value": amount,
            "net_asset_change": -amount if amount is not None else None,
            "valuation_basis": "holding_value" if rows else "unused_product",
            "valuation_date": None,
            "warnings": [
                "移出统计后可恢复。原始流水保留，机构总权益不会因删除单个产品而改写。"
            ],
        }
    from .ledger import balance
    from .portfolio import _institution_value, _snapshot_account

    when = day()
    if _snapshot_account(obj):
        valuation = _institution_value(space, obj, when, prefer_reference=True)
        amount = valuation["local_value"]
        basis = valuation["basis"]
        as_of = valuation["date"]
        warnings = list(valuation["gaps"])
    else:
        from django.db.models import Sum
        from .reporting import ASSET_CODES, positions

        amount = JournalLine.objects.filter(
            tenant=space,
            account=obj,
            event__economic_date__lte=when,
            code__in=ASSET_CODES - {"investment"},
        ).aggregate(total=Sum("amount"))["total"] or dec("0")
        holdings = [p for p in positions(space, when) if p["account_id"] == str(obj.pk)]
        amount = (
            amount + sum((p["market_value"] for p in holdings), dec("0"))
            if all(p["market_value"] is not None for p in holdings)
            else None
        )
        basis, as_of, warnings = "ledger_opening", when, []
    warnings.append(
        "删除后各项资产统计将不再包含该账户；原始期初记录保留，恢复后重新计入。"
    )
    return serial(
        {
            "currency": obj.currency,
            "removed_value": amount,
            "net_asset_change": -amount if amount is not None else None,
            "valuation_basis": basis,
            "valuation_date": as_of,
            "warnings": warnings,
        }
    )


def deletion_preview(space, kind, ident):
    """Read only, including for items already in the recoverable-deletion list."""
    obj = _target(space, kind, ident)
    tombstone = _tombstone(space, kind, obj.pk)
    deleted = bool(tombstone and tombstone.data.get("status") == "deleted")
    blockers, retained = _dependencies(space, kind, obj)
    restore_blockers = []
    if deleted and kind == "instruments":
        linked_ids = obj.specification.get("account_ids", [])
        for account_id in linked_ids:
            account = Account.objects.filter(tenant=space, pk=account_id).first()
            if account is None or is_catalog_deleted(space, "accounts", account_id):
                restore_blockers.append(
                    {
                        "code": "deleted_linked_account",
                        "count": 1,
                        "message": "关联账户已删除，请先恢复账户，再恢复投资产品。",
                        "items": [
                            {
                                "id": str(account_id),
                                "name": account.name if account else "原关联账户",
                            }
                        ],
                    }
                )
    return serial(
        {
            "object": record(obj),
            "deleted": deleted,
            "can_delete": not deleted and not blockers,
            "can_restore": deleted and not restore_blockers,
            "blockers": blockers,
            "restore_blockers": restore_blockers,
            "impact": _impact(space, kind, obj),
            "retained": retained,
            "deletion": record(tombstone) if tombstone else None,
            "data_revision": Workspace.objects.get(pk=space.pk).revision,
        }
    )


def _check_version(space, obj, body):
    if not isinstance(body, dict) or set(body) - {
        "version",
        "expected_revision",
        "confirm",
    }:
        raise DomainError("删除或恢复请求含不支持的参数")
    if (
        isinstance(body.get("version"), bool)
        or isinstance(body.get("expected_revision"), bool)
        or str(body.get("version")) != str(obj.version)
        or str(body.get("expected_revision")) != str(space.revision)
    ):
        raise DomainError(
            "档案或账簿已变化，请重新查看删除影响后操作", "version_conflict", 412
        )


def _write_tombstone(space, user, obj, kind, tombstone, data, action):
    if tombstone:
        tombstone.data = data
        tombstone.version += 1
        tombstone.save()
    else:
        tombstone = Resource.objects.create(
            tenant=space, created_by=user, kind=KIND, data=data
        )
    ResourceRevision.objects.create(
        tenant=space,
        created_by=user,
        resource=tombstone,
        version=tombstone.version,
        data=data,
    )
    obj.version += 1
    obj.save()
    bump(space, user, invalidate_reconciliations=False)
    impact = dict(data.get("deletion_impact") or {})
    if action == "catalog.restored" and impact.get("net_asset_change") is not None:
        from decimal import Decimal

        impact["net_asset_change"] = -Decimal(str(impact["net_asset_change"]))
    audit(
        space,
        user,
        action,
        obj,
        {
            "target_kind": kind,
            "deletion_id": str(tombstone.pk),
            "deletion_version": tombstone.version,
            "impact": impact,
            "financial_facts_preserved": True,
        },
    )
    return serial(
        {
            "item": record(obj),
            "deleted": data["status"] == "deleted",
            "deletion": record(tombstone),
            "data_revision": space.revision,
        }
    )


@transaction.atomic
def delete_catalog_item(space, user, kind, ident, body, *, administrative=False):
    if administrative:
        from .admin_access import require_delegation

        require_delegation(user, space)
    locked = Workspace.objects.select_for_update().get(pk=space.pk)
    if locked.deleted_at:
        raise DomainError("空间已移入回收站", "not_found", 404)
    space.revision = locked.revision
    obj = _target(space, kind, ident)
    _check_version(space, obj, body)
    if body.get("confirm") is not True:
        raise DomainError(
            "请确认已了解删除后资产统计的变化，可在已删除列表恢复",
            "catalog_delete_confirmation_required",
        )
    preview = deletion_preview(space, kind, ident)
    if preview["deleted"]:
        raise DomainError("档案已删除，可在已删除列表恢复", "already_deleted", 409)
    if not preview["can_delete"] and not administrative:
        raise DomainError(
            "档案仍有关联记录，未删除任何内容",
            "catalog_has_dependencies",
            409,
            fields={"preview": preview},
        )
    tombstone = _tombstone(space, kind, ident)
    data = {
        **(tombstone.data if tombstone else {}),
        "target_kind": kind,
        "target_id": str(obj.pk),
        "target_name": obj.name,
        "status": "deleted",
        "deleted_at": timezone.now().isoformat(),
        "deleted_by": str(user.pk),
        "deletion_impact": preview["impact"],
        "retained": preview["retained"],
        "previous_archived": obj.archived if kind == "accounts" else None,
        "administrative": administrative,
    }
    if administrative:
        # Keep dependent settings recoverable, but stop them from generating new
        # transactions, reservations, alerts or valuations for a removed catalog.
        affected = []
        for resource in Resource.objects.filter(tenant=space).exclude(
            kind__in=[KIND, "administration_observations", "market_quotes"]
        ):
            if _references(resource.data, str(obj.pk)) and resource.kind in {
                "plans",
                "loans",
                "reservations",
                "budgets",
                "strategies",
                "todos",
                "watchlist",
                "market_watchlist",
                "signal_rules",
                "option_positions",
            }:
                from .administration_data import _resource_delete

                _resource_delete(space, user, resource)
                affected.append(str(resource.pk))
                audit(
                    space,
                    user,
                    "administration.dependent.deleted",
                    resource,
                    {"catalog_id": str(obj.pk), "reason": "关联账户或产品已删除"},
                )
        data["dependent_deleted_ids"] = affected
    if kind == "accounts":
        obj.archived = True
    return _write_tombstone(space, user, obj, kind, tombstone, data, "catalog.deleted")


@transaction.atomic
def restore_catalog_item(space, user, kind, ident, body):
    locked = Workspace.objects.select_for_update().get(pk=space.pk)
    if locked.deleted_at:
        raise DomainError("空间已移入回收站", "not_found", 404)
    space.revision = locked.revision
    obj = _target(space, kind, ident)
    _check_version(space, obj, body)
    preview = deletion_preview(space, kind, ident)
    if not preview["deleted"]:
        raise DomainError("该档案未删除", "not_deleted", 409)
    if not preview["can_restore"]:
        raise DomainError(
            "请先恢复关联账户",
            "catalog_restore_dependencies",
            409,
            fields={"preview": preview},
        )
    tombstone = _tombstone(space, kind, ident)
    data = {
        **tombstone.data,
        "status": "restored",
        "restored_at": timezone.now().isoformat(),
        "restored_by": str(user.pk),
    }
    if kind == "accounts":
        obj.archived = bool(data.get("previous_archived", False))
    return _write_tombstone(space, user, obj, kind, tombstone, data, "catalog.restored")
