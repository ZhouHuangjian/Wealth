"""Actor-preserving administration of tenant business records, with recoverable changes."""

from copy import copy, deepcopy
import uuid

from django.db import transaction
from django.db.models import Q

from . import models as m
from .common import DomainError, audit, bump, day, record, serial
from .platform_admin import expected_version, require_admin

OBSERVATIONS = {"prices": m.Price, "fx": m.FxRate, "snapshots": m.Snapshot}
PLANNING = {
    "plans": "定投与收支计划",
    "loans": "贷款计划",
    "goals": "财富目标",
    "scenarios": "目标方案",
    "reservations": "资金预留",
    "budgets": "预算",
    "notes": "投资手札",
    "strategies": "投资策略",
    "todos": "待办",
    "watchlist": "观察笔记",
    "reconciliations": "账户核对",
}
INSIGHTS = {
    "investment-tags": "投资标签",
    "market-watchlist": "市场自选",
    "signal-rules": "补仓与条件提醒",
    "dashboard-preferences": "首页显示",
}
LABELS = {
    "accounts": "账户",
    "instruments": "投资产品",
    "events": "收支与交易",
    "prices": "价格与净值",
    "fx": "估值汇率",
    "snapshots": "机构权益",
    "option-holdings": "期权持仓",
    **PLANNING,
    **INSIGHTS,
}
DEFAULTS = {
    "accounts": dict(
        name="",
        kind="bank",
        currency="CNY",
        institution="",
        opening_balance="0",
        opening_date="today",
    ),
    "instruments": dict(
        name="", code="", kind="fund", market="CN", currency="CNY", account_ids=[]
    ),
    "events": dict(
        kind="expense",
        account_id="",
        economic_date="today",
        amount="",
        currency="CNY",
        category="",
        description="",
    ),
    "prices": dict(
        instrument_id="",
        value="",
        economic_date="today",
        kind="official_nav",
        source="管理员录入",
    ),
    "fx": dict(
        base="USD",
        quote="CNY",
        rate="",
        economic_date="today",
        purpose="valuation",
        source="管理员录入",
    ),
    "snapshots": dict(
        account_id="",
        equity="",
        currency="CNY",
        economic_date="today",
        coverage="",
        complete=False,
        includes_options=None,
        included_event_ids=[],
    ),
    "plans": dict(
        name="",
        account_id="",
        instrument_id="",
        kind="expense",
        amount="",
        currency="CNY",
        start_date="today",
        frequency="monthly",
        status="active",
    ),
    "loans": dict(
        name="",
        account_id="",
        liability_account_id="",
        principal="",
        annual_rate="0",
        term_months=12,
        method="annuity",
        first_due_date="today",
        currency="CNY",
        status="active",
    ),
    "goals": dict(
        name="", amount="", currency="CNY", target_date="today", status="draft"
    ),
    "scenarios": dict(name="", goal_id="", amount="", currency="CNY", status="draft"),
    "reservations": dict(
        name="", account_id="", amount="", currency="CNY", status="active"
    ),
    "budgets": dict(
        name="",
        account_id="",
        amount="",
        currency="CNY",
        start_date="today",
        end_date="today",
        category="",
    ),
    "notes": dict(title="", body="", tags=[], status="draft"),
    "strategies": dict(name="", description="", status="active"),
    "todos": dict(name="", description="", due_date="today", status="active"),
    "watchlist": dict(name="", instrument_id="", description="", status="active"),
    "reconciliations": dict(
        account_id="", kind="cash", as_of="today", institution_value="", currency="CNY"
    ),
    "investment-tags": dict(
        name="", color="#527765", target_weight="0", instrument_ids=[], archived=False
    ),
    "market-watchlist": dict(instrument_id="", enabled=True, show_on_home=True),
    "signal-rules": dict(
        name="", enabled=True, match="all", cooldown_hours=24, conditions=[]
    ),
    "dashboard-preferences": dict(
        show_market_environment=True, show_valuation=True, show_signals=True
    ),
    "option-holdings": dict(
        account_id="",
        instrument_id="",
        quantity="",
        side="long",
        contract_multiplier="",
        opening_price="",
        current_value="",
        purchase_date="today",
        as_of="today",
        status="active",
    ),
}
INTERNAL = {
    "id",
    "tenant_id",
    "created_by_id",
    "created_at",
    "version",
    "data",
    "storage_key",
    "token_hash",
}


def resource_kind(category):
    from .insights import RESOURCE_PATHS

    if category in PLANNING:
        return category
    if category in RESOURCE_PATHS:
        return RESOURCE_PATHS[category]
    if category == "option-holdings":
        return "option_positions"
    return None


def queryset(space, category):
    if category in OBSERVATIONS:
        return OBSERVATIONS[category].all_objects.filter(tenant=space)
    if category in {"accounts", "instruments", "events"}:
        model = {"accounts": m.Account, "instruments": m.Instrument, "events": m.Event}[
            category
        ]
        return model.objects.filter(tenant=space)
    return m.Resource.all_objects.filter(tenant=space, kind=resource_kind(category))


def observation_state(space, obj):
    return m.Resource.all_objects.filter(
        tenant=space,
        kind="administration_observations",
        data__model=obj._meta.model_name,
        data__target_id=str(obj.pk),
    ).first()


def deleted(space, category, obj):
    if category in {"accounts", "instruments"}:
        from .catalog_lifecycle import is_catalog_deleted

        return is_catalog_deleted(space, category, obj.pk)
    if category in OBSERVATIONS:
        state = observation_state(space, obj)
        return bool(state and state.data.get("status") in {"deleted", "superseded"})
    if category == "events":
        return bool(obj.reverses_id or hasattr(obj, "reversal"))
    return obj.data.get("_administration_deleted") is True


def values_for(category, obj):
    if isinstance(obj, m.Resource):
        return {
            k: v
            for k, v in obj.data.items()
            if not k.startswith("_") and k not in INTERNAL
        }
    if category == "events":
        if obj.payload.get("opening_source") == "existing_holding":
            from .holding_corrections import correction_metadata

            meta = correction_metadata(obj.tenant, obj)
            if meta["eligible"]:
                return meta["initial_values"]
        return {
            k: v
            for k, v in obj.payload.items()
            if not k.startswith("_") and k not in INTERNAL
        }
    return {k: v for k, v in record(obj).items() if k not in INTERNAL}


def item_record(space, category, obj):
    values = values_for(category, obj)
    result = {
        "id": str(obj.pk),
        "version": obj.version,
        "values": values,
        "name": values.get("name")
        or values.get("title")
        or values.get("description")
        or LABELS[category],
        "date": str(
            values.get("economic_date")
            or values.get("start_date")
            or values.get("as_of")
            or ""
        ),
        "deleted": deleted(space, category, obj),
        "updated_by": obj.created_by_id,
    }
    if category in OBSERVATIONS:
        state = observation_state(space, obj)
        result["replacement_id"] = state.data.get("replacement_id") if state else None
    if category == "events":
        result["can_restore"] = False
        if obj.payload.get("opening_source") == "existing_holding":
            from .holding_corrections import correction_metadata

            result["holding_correction"] = correction_metadata(space, obj)
    return serial(result)


def _contains(value, ident):
    if isinstance(value, dict):
        return any(_contains(v, ident) for v in value.values())
    if isinstance(value, list):
        return any(_contains(v, ident) for v in value)
    return value == ident


def dependencies(space, category, obj):
    """Never leave a live configuration pointing at a removed required parent."""
    if category in {"accounts", "instruments"}:
        from .catalog_lifecycle import deletion_preview

        return deletion_preview(space, category, obj.pk)["blockers"]
    refs = []
    if isinstance(obj, m.Resource):
        for other in m.Resource.objects.filter(tenant=space).exclude(pk=obj.pk):
            if other.kind in {
                "administration_observations",
                "catalog_deletions",
                "market_quotes",
                # Operational cursor only: deleting its parent plan must remain
                # possible. Permanent erasure follows its plan_id automatically.
                "dca_automation_runtime",
            }:
                continue
            if _contains(other.data, str(obj.pk)):
                refs.append(
                    {
                        "id": str(other.pk),
                        "name": other.data.get("name")
                        or other.data.get("title")
                        or "关联配置",
                    }
                )
        for inst in m.Instrument.objects.filter(tenant=space):
            if _contains(inst.specification, str(obj.pk)):
                refs.append({"id": str(inst.pk), "name": inst.name})
    if category in OBSERVATIONS:
        for other in m.Resource.objects.filter(tenant=space):
            if other.kind != "administration_observations" and _contains(
                other.data, str(obj.pk)
            ):
                refs.append(
                    {
                        "id": str(other.pk),
                        "name": other.data.get("name") or "关联核对记录",
                    }
                )
    return (
        [
            {
                "code": "references",
                "message": "请先处理关联配置，避免留下失效引用",
                "count": len(refs),
                "items": refs[:20],
            }
        ]
        if refs
        else []
    )


def _target(space, category, ident):
    from django.core.exceptions import ValidationError

    try:
        obj = queryset(space, category).filter(pk=ident).first()
    except (ValueError, TypeError, ValidationError):
        obj = None
    if obj is None:
        raise DomainError("记录不存在或不属于当前空间", "not_found", 404)
    return obj


def _guard(space, obj, body):
    if obj is not None:
        expected_version(body, obj.version)
    if isinstance(body.get("expected_revision"), bool) or str(
        body.get("expected_revision")
    ) != str(space.revision):
        raise DomainError(
            "账簿已有新修改，请重新读取记录后再保存", "version_conflict", 412
        )
    reason = body.get("reason")
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 500:
        raise DomainError("请填写简短的修改原因（最多 500 字）")
    return reason.strip()


def _observation_mark(space, user, obj, status, replacement=None):
    state = observation_state(space, obj)
    data = {
        "model": obj._meta.model_name,
        "target_id": str(obj.pk),
        "status": status,
        "replacement_id": str(replacement.pk) if replacement else None,
    }
    if state:
        state.data = data
        state.version += 1
        state.save()
    else:
        state = m.Resource.all_objects.create(
            tenant=space, created_by=user, kind="administration_observations", data=data
        )
    m.ResourceRevision.objects.create(
        tenant=space, created_by=user, resource=state, version=state.version, data=data
    )
    obj.version += 1
    obj.save(update_fields=["version"])


def _resource_delete(space, user, obj, restore=False):
    from .planning import save_resource
    from .insights import RESOURCE_PATHS, save_configuration

    before = deepcopy(obj.data)
    m.ResourceRevision.objects.get_or_create(
        tenant=space,
        resource=obj,
        version=obj.version,
        defaults={"created_by": user, "data": before},
    )
    if restore:
        obj.data.pop("_administration_deleted", None)
        obj.save(update_fields=["data"])
        if obj.kind in PLANNING:
            return save_resource(space, user, obj.kind, values_for(obj.kind, obj), obj)
        if obj.kind in RESOURCE_PATHS.values():
            save_configuration(space, user, obj.kind, values_for(obj.kind, obj), obj)
            return obj
        if obj.kind == "option_positions":
            from .option_positions import save_option_position

            save_option_position(
                space,
                user,
                {**values_for("option-holdings", obj), "version": obj.version},
                ident=str(obj.pk),
            )
            return obj
    else:
        obj.data["_administration_deleted"] = True
    obj.version += 1
    obj.save()
    m.ResourceRevision.objects.create(
        tenant=space, created_by=user, resource=obj, version=obj.version, data=obj.data
    )
    return obj


def _event_dependencies(space, event):
    """Return a reverse topological order; explicit confirmation covers the whole set."""
    ids = {event.pk}
    for _ in range(1001):
        previous = set(ids)
        ids.update(
            m.Event.objects.filter(
                tenant=space,
                related_id__in=ids,
                reversal__isnull=True,
                reverses__isnull=True,
            ).values_list("pk", flat=True)
        )
        for movement in m.PositionMovement.objects.filter(
            tenant=space, event_id__in=ids
        ):
            ids.update(
                m.PositionMovement.objects.filter(
                    tenant=space,
                    account_id=movement.account_id,
                    instrument_id=movement.instrument_id,
                    event__created_at__gt=movement.event.created_at,
                    event__reversal__isnull=True,
                    event__reverses__isnull=True,
                ).values_list("event_id", flat=True)
            )
        if len(ids) > 1000:
            raise DomainError("关联事项超过 1000 条，请按时间范围分批处理")
        if ids == previous:
            return list(
                m.Event.objects.filter(tenant=space, pk__in=ids).order_by("-created_at")
            )
    raise DomainError("关联事项存在异常，无法自动确定处理顺序")


def _save(request, space, category, obj, values, reason=""):
    from .views import model_resource
    from .planning import save_resource
    from .insights import RESOURCE_PATHS, save_configuration

    if category in {"accounts", "instruments"} or category in OBSERVATIONS:
        forwarded = copy(request)
        forwarded.method = "PATCH" if obj and category not in OBSERVATIONS else "POST"
        result = model_resource(
            forwarded,
            space,
            category,
            str(obj.pk) if obj and category not in OBSERVATIONS else None,
            {
                **values,
                **({"version": obj.version} if obj else {}),
                "expected_revision": space.revision,
                "reason": reason,
            },
        )
        return _target(space, category, result["id"])
    if category in PLANNING:
        return save_resource(space, request.user, category, values, obj)
    if category in RESOURCE_PATHS:
        result = save_configuration(
            space, request.user, RESOURCE_PATHS[category], values, obj
        )
        return _target(space, category, result["id"])
    if category == "option-holdings":
        from .option_positions import save_option_position

        result = save_option_position(
            space,
            request.user,
            {**values, **({"version": obj.version} if obj else {})},
            ident=str(obj.pk) if obj else None,
        )
        return _target(space, category, result["id"])
    if category == "events":
        from .ledger import post_event

        return post_event(space, request.user, values)

    raise DomainError("此记录请在对应业务页面处理")


def _correct_cash_opening(space, user, event, values, reason):
    from .account_opening import opening_date_metadata, CORRECTION_ACTION
    from .common import get_obj, dec
    from .ledger import cash_code, LIABILITIES, reverse_event

    account = get_obj(m.Account, space, event.payload.get("account_id"))
    metadata = opening_date_metadata(space, account)
    if (
        not metadata["editable"]
        or metadata["source_id"] != str(event.pk)
        or metadata["kind"] != "cash"
    ):
        raise DomainError(
            "请先核对账户期初来源，再更正这笔期初资金", "opening_source_unverified", 409
        )
    allowed = {"amount", "economic_date", "description", "category"}
    if any(
        values.get(key) != event.payload.get(key)
        for key in (set(values) | set(event.payload)) - allowed
    ):
        raise DomainError(
            "期初更正可修改金额、日期和备注；账户、币种和业务类型保持原记录"
        )
    when = day(values.get("economic_date"))
    if when > day(metadata["max_date"]) or (
        metadata["min_date"] and when < day(metadata["min_date"])
    ):
        raise DomainError(
            "期初日期须在已有资金与持仓记录之前，请核对日期",
            "opening_date_dependency",
            409,
        )
    amount = dec(values.get("amount"), nonnegative=True)
    sign = -1 if account.kind in LIABILITIES else 1
    original_lines = list(event.lines.all())
    if (
        len(original_lines) != 2
        or event.movements.exists()
        or not any(
            line.account_id == account.pk and line.code == cash_code(account)
            for line in original_lines
        )
    ):
        raise DomainError("期初包含其他业务，请在持仓更正入口核对")
    reversal = reverse_event(space, user, event, reason)
    result = m.Event.objects.create(
        tenant=space,
        created_by=user,
        kind="opening",
        economic_date=when,
        description=str(values.get("description") or "")[:500],
        category=str(values.get("category") or "")[:100],
        payload={**event.payload, **values},
        operation_id=event.operation_id,
        stage_key=f"{space.pk}:opening-date:{event.pk}:{uuid.uuid4()}",
        revision=bump(space, user),
    )
    m.JournalLine.objects.bulk_create(
        [
            m.JournalLine(
                tenant=space,
                created_by=user,
                event=result,
                account=account,
                code=cash_code(account),
                currency=account.currency,
                amount=sign * amount,
            ),
            m.JournalLine(
                tenant=space,
                created_by=user,
                event=result,
                code="equity",
                currency=account.currency,
                amount=-sign * amount,
            ),
        ]
    )
    account.version += 1
    account.save(update_fields=["version"])
    audit(
        space,
        user,
        CORRECTION_ACTION,
        account,
        {
            "kind": "cash",
            "old_source_id": str(event.pk),
            "new_source_id": str(result.pk),
            "old_date": str(event.economic_date),
            "new_date": str(when),
            "reason": reason,
            "reversal_id": str(reversal.pk),
            "administrative": True,
        },
    )
    return result


@transaction.atomic
def command(request, space, category, ident, operation, body):
    require_admin(request.user)
    space = m.Workspace.objects.select_for_update().get(pk=space.pk)
    if space.deleted_at:
        raise DomainError("空间已删除", "not_found", 404)
    obj = _target(space, category, ident) if ident else None
    reason = _guard(space, obj, body)
    before = record(obj) if obj else None
    is_deleted = deleted(space, category, obj) if obj else False
    if operation == "restore":
        if not obj or not is_deleted or category == "events":
            raise DomainError("此记录不能恢复；已撤销的交易请重新登记", "conflict", 409)
        if category in {"accounts", "instruments"}:
            from .catalog_lifecycle import restore_catalog_item

            restore_catalog_item(
                space,
                request.user,
                category,
                ident,
                {k: body[k] for k in ("version", "expected_revision")},
            )
        elif category in OBSERVATIONS:
            state = observation_state(space, obj)
            replacement = state.data.get("replacement_id")
            visited = set()
            while replacement and replacement not in visited:
                visited.add(replacement)
                if (
                    OBSERVATIONS[category]
                    .objects.filter(tenant=space, pk=replacement)
                    .exists()
                ):
                    raise DomainError(
                        "此记录已被新版替代，请编辑新版，或先删除新版再恢复",
                        "replacement_active",
                        409,
                    )
                successor = (
                    OBSERVATIONS[category]
                    .all_objects.filter(tenant=space, pk=replacement)
                    .first()
                )
                successor_state = (
                    observation_state(space, successor) if successor else None
                )
                replacement = (
                    successor_state.data.get("replacement_id")
                    if successor_state
                    else None
                )
            _observation_mark(space, request.user, obj, "restored")
        else:
            _resource_delete(space, request.user, obj, restore=True)
    elif operation == "delete":
        if not obj or is_deleted:
            raise DomainError("记录已经删除或撤销", "conflict", 409)
        if body.get("confirm") is not True:
            raise DomainError("请确认已核对删除影响")
        if category in {"accounts", "instruments"}:
            from .catalog_lifecycle import delete_catalog_item

            # Administration may remove a catalog from active statistics while retaining
            # all immutable history. Ordinary users retain strict dependency checks.
            delete_catalog_item(
                space,
                request.user,
                category,
                ident,
                {k: body[k] for k in ("version", "expected_revision", "confirm")},
                administrative=True,
            )
        elif category == "events":
            from .ledger import reverse_event

            events = _event_dependencies(space, obj)
            if len(events) > 1 and body.get("include_related") is not True:
                raise DomainError(
                    f"此事项有关联阶段，需一并撤销 {len(events)} 条事项",
                    "dependent_events",
                    409,
                )
            for event in events:
                reverse_event(space, request.user, event, reason)
        else:
            refs = dependencies(space, category, obj)
            if refs:
                raise DomainError(
                    "请先处理关联配置",
                    "dependent_records",
                    409,
                    fields={"blockers": refs},
                )
            if category in OBSERVATIONS:
                _observation_mark(space, request.user, obj, "deleted")
            else:
                _resource_delete(space, request.user, obj)
    elif operation == "save":
        if is_deleted:
            raise DomainError("请先恢复记录再编辑", "record_deleted", 409)
        values = body.get("values")
        if not isinstance(values, dict) or any(
            k.startswith("_") or k in INTERNAL for k in values
        ):
            raise DomainError("请提交有效的业务字段，不能更改系统身份")
        replacement_event = None
        if obj and category == "events":
            from .ledger import reverse_event

            if obj.payload.get("opening_source") == "existing_holding":
                from .holding_corrections import correct_holding

                result = correct_holding(
                    space,
                    request.user,
                    str(obj.pk),
                    {**values, "expected_revision": space.revision, "reason": reason},
                    administrative=True,
                )
                replacement_event = m.Event.objects.get(
                    tenant=space, pk=result["event"]["id"]
                )
            elif obj.kind == "opening" and not obj.payload.get("instrument_id"):
                replacement_event = _correct_cash_opening(
                    space, request.user, obj, values, reason
                )
            else:
                reverse_event(space, request.user, obj, reason)
        previous = obj
        opening_snapshot = False
        if previous and category == "snapshots":
            from .account_opening import trusted_opening_ids

            opening_snapshot = (
                str(previous.pk)
                in trusted_opening_ids(space, previous.account)["snapshot"]
            )
        obj = replacement_event or _save(request, space, category, obj, values, reason)
        if previous and category in OBSERVATIONS:
            _observation_mark(space, request.user, previous, "superseded", obj)
            if category == "snapshots":
                if opening_snapshot:
                    audit(
                        space,
                        request.user,
                        "snapshots.account_opening",
                        obj,
                        {"replacement_for": str(previous.pk)},
                    )
    else:
        raise DomainError("不支持此操作", "method_not_allowed", 405)
    bump(space, request.user)
    obj.refresh_from_db()
    audit(
        space,
        request.user,
        f"administration.{category}.{operation}",
        obj,
        {
            "reason": reason,
            "before": before,
            "after": record(obj),
            "administrator_id": request.user.pk,
        },
    )
    return {"item": item_record(space, category, obj), "data_revision": space.revision}


def dispatch(request, space, path, body):
    require_admin(request.user)
    from .views import page, write_command

    category = path[0] if path else None
    if not category:
        if request.method != "GET":
            raise DomainError("不支持此操作", "method_not_allowed", 405)
        return {
            "categories": [
                {
                    "key": k,
                    "label": v,
                    "defaults": {
                        f: (str(day()) if value == "today" else value)
                        for f, value in DEFAULTS[k].items()
                    },
                }
                for k, v in LABELS.items()
            ],
            "data_revision": space.revision,
        }
    if category not in LABELS or len(path) > 3:
        raise DomainError("管理分类不存在", "not_found", 404)
    ident = path[1] if len(path) > 1 else None
    action = path[2] if len(path) > 2 else None
    if request.method == "GET":
        if action == "purge-preview" and ident:
            from .administration_purge import plan

            return plan(space, category, _target(space, category, ident))[0]
        if action:
            raise DomainError("管理路径不存在", "not_found", 404)
        if ident:
            obj = _target(space, category, ident)
            item = item_record(space, category, obj)
            result = {
                "item": item,
                "data_revision": space.revision,
                "dependencies": dependencies(space, category, obj),
            }
            if category == "events" and not item["deleted"]:
                result["related_count"] = len(_event_dependencies(space, obj))
            if category in {"accounts", "instruments"}:
                from .catalog_lifecycle import deletion_preview

                result["impact"] = deletion_preview(space, category, ident)["impact"]
            if category == "accounts" and not item["deleted"]:
                from .account_opening import opening_date_metadata

                result["opening"] = opening_date_metadata(space, obj)
                if result["opening"]["available"]:
                    result["item"]["values"]["opening_date"] = result["opening"][
                        "opening_date"
                    ]
            return result
        state = request.GET.get("status", "active")
        if state not in {"active", "deleted", "all"}:
            raise DomainError("请选择有效的记录状态")
        rows = queryset(space, category).order_by("-created_at")
        # List only tenant rows. Model-specific filters avoid joining unrelated spaces.
        if state != "all":
            if category in OBSERVATIONS:
                active = (
                    OBSERVATIONS[category].objects.filter(tenant=space).values("pk")
                )
                rows = (
                    rows.filter(pk__in=active)
                    if state == "active"
                    else rows.exclude(pk__in=active)
                )
            elif category in {"accounts", "instruments"}:
                from .catalog_lifecycle import deleted_catalog_ids

                ids = deleted_catalog_ids(space, category)
                rows = (
                    rows.exclude(pk__in=ids)
                    if state == "active"
                    else rows.filter(pk__in=ids)
                )
            elif category == "events":
                active = Q(reversal__isnull=True, reverses__isnull=True)
                rows = (
                    rows.filter(active) if state == "active" else rows.exclude(active)
                )
            else:
                rows = (
                    rows.filter(
                        Q(data___administration_deleted__isnull=True)
                        | Q(data___administration_deleted=False)
                    )
                    if state == "active"
                    else rows.filter(data___administration_deleted=True)
                )
        query = request.GET.get("q", "").strip()[:100]
        if query:
            if category in {"accounts", "instruments"}:
                rows = rows.filter(
                    Q(name__icontains=query)
                    | (
                        Q(code__icontains=query)
                        if category == "instruments"
                        else Q(institution__icontains=query)
                    )
                )
            elif category == "events":
                rows = rows.filter(
                    Q(description__icontains=query) | Q(category__icontains=query)
                )
            elif resource_kind(category):
                rows = rows.filter(
                    Q(data__name__icontains=query)
                    | Q(data__title__icontains=query)
                    | Q(data__description__icontains=query)
                )
            else:
                rows = (
                    rows.filter(Q(source__icontains=query))
                    if category != "snapshots"
                    else rows.filter(coverage__icontains=query)
                )
        return {
            **page(
                request, rows, lambda obj: item_record(space, category, obj), default=20
            ),
            "data_revision": space.revision,
        }
    operation = (
        "purge"
        if action == "purge" and request.method == "POST" and ident
        else "restore"
        if action == "restore" and request.method == "POST"
        else "delete"
        if request.method == "DELETE" and ident and not action
        else "save"
        if (
            (request.method == "POST" and not ident)
            or (request.method == "PATCH" and ident)
        )
        and not action
        else None
    )
    if not operation:
        raise DomainError("不支持此操作", "method_not_allowed", 405)
    if operation == "purge":
        from .administration_purge import purge

        return write_command(
            request,
            space,
            "administration/purge/" + "/".join(path),
            body,
            lambda: purge(request, space, category, ident, body),
        )
    return write_command(
        request,
        space,
        "administration/" + operation + "/" + "/".join(path),
        body,
        lambda: command(request, space, category, ident, operation, body),
    )
