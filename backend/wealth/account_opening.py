"""Record and correct opening dates without rewriting posted financial facts."""

from copy import deepcopy
import uuid

from django.db import transaction
from django.db.models import Q

from .common import DomainError, audit, bump, day, dec, get_obj, serial
from .ledger import cash_code, post_event, reverse_event
from .models import Account, Audit, Event, JournalLine, Snapshot, Workspace
from .portfolio import _snapshot_account
from .valuation_basis import validate_snapshot_basis


@transaction.atomic
def initialize_account(space, user, account, body):
    """Return True when an opening was recorded and the book revision advanced.

    Called once, inside the account-create command's idempotent transaction. An
    institution's total equity is an observation, not a deposit or income event.
    Existing accounts and immutable opening events are never rewritten here.
    """
    raw = body.get("opening_balance")
    if raw in (None, ""):
        return False
    when = day(body.get("opening_date"))
    if when > day():
        raise DomainError("期初日期不能晚于今天；未来计划请在规划中录入")
    if not _snapshot_account(account):
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(account.pk),
                "currency": account.currency,
                "amount": str(dec(raw, nonnegative=True)),
                "economic_date": str(when),
                "description": "期初余额",
            },
            stage_key=f"{space.pk}:opening:{account.pk}",
        )
        return True
    coverage = body.get("opening_coverage", "")
    if not isinstance(coverage, str) or not coverage.strip():
        raise DomainError(
            "机构权益账户请填写期初金额的包含范围，例如客户总权益（含期权市值）；不能把入金金额当作总权益",
            "opening_equity_coverage_required",
        )
    confirmed = body.get("opening_coverage_confirmed", False)
    if not isinstance(confirmed, bool):
        raise DomainError("期初权益范围确认必须为布尔值")
    option_scope = body.get("opening_option_scope", "unknown")
    if not isinstance(option_scope, str) or option_scope not in {
        "includes_options",
        "no_options",
        "unknown",
    }:
        raise DomainError("请选择有效的期初期权包含范围")
    details = {"source": "manual_account_opening", "opening_account": True}
    details.update(
        validate_snapshot_basis(
            {
                key.removeprefix("opening_"): body[key]
                for key in (
                    "opening_valuation_basis",
                    "opening_valuation_observed_at",
                    "opening_calendar_id",
                )
                if key in body
            }
        )
    )
    available = body.get("opening_available")
    if available not in (None, ""):
        details["available"] = str(dec(available, nonnegative=True))
    if option_scope == "no_options":
        details["no_option_positions"] = True
    snapshot = Snapshot(
        tenant=space,
        created_by=user,
        account=account,
        economic_date=when,
        currency=account.currency,
        equity=dec(raw),
        coverage=coverage.strip(),
        complete=confirmed,
        includes_options=(
            True
            if option_scope == "includes_options"
            else False
            if option_scope == "no_options"
            else None
        ),
        details=details,
    )
    snapshot.full_clean(exclude=["created_by"])
    snapshot.save()
    bump(space, user)
    audit(space, user, "snapshots.account_opening", snapshot)
    return True


CORRECTION_ACTION = "account.opening_date_corrected"


@transaction.atomic
def apply_account_edit(space, user, account, body, save_profile):
    """Combine a validated profile edit and an optional opening correction.

    The authorized/idempotent caller supplies
    ``save_profile(fresh_account, clean_body)``.
    That callback must retain the normal identity/archive validation and perform
    its usual version increment, save, revision bump and audit. It must use the
    passed instance: the date correction may have advanced the account version.
    Either both changes commit or all financial/profile changes roll back.
    """
    from .platform_admin import expected_version

    locked_space = Workspace.objects.select_for_update().get(pk=space.pk)
    if locked_space.deleted_at:
        raise DomainError("此空间已移入回收站", "not_found", 404)
    account = get_obj(Account, locked_space, account.pk)
    account = Account.objects.select_for_update().get(
        pk=account.pk, tenant=locked_space
    )
    expected_version(body, account.version)
    correction = None
    if "opening_date" in body:
        metadata = opening_date_metadata(locked_space, account)
        raw_date = body["opening_date"]
        if not isinstance(raw_date, str) or not raw_date:
            raise DomainError("请填写有效的期初日期")
        # An unchanged displayed date is not a financial amendment. A profile
        # rename remains possible even if an archived opening is read-only.
        if day(raw_date).isoformat() != metadata["opening_date"]:
            correction = correct_opening_date(
                locked_space,
                user,
                account,
                {
                    key: body[key]
                    for key in (
                        "version",
                        "expected_revision",
                        "opening_date",
                        "reason",
                    )
                    if key in body
                },
            )
            account.refresh_from_db()
    clean_body = {key: value for key, value in body.items() if key != "opening_date"}
    clean_body["version"] = account.version
    if "expected_revision" in clean_body:
        locked_space.refresh_from_db(fields=["revision"])
        clean_body["expected_revision"] = locked_space.revision
    result = save_profile(account, clean_body)
    space.refresh_from_db(fields=["revision"])
    return {
        **result,
        "opening": opening_date_metadata(locked_space, account),
        "opening_date_changed": bool(correction and correction["changed"]),
    }


def trusted_opening_ids(space, account):
    """Original server-created sources and their audited correction descendants."""
    cash = {
        str(pk)
        for pk in Event.objects.filter(
            tenant=space,
            kind="opening",
            stage_key=f"{space.pk}:opening:{account.pk}",
            lines__account=account,
        ).values_list("pk", flat=True)
    }
    original_snapshots = list(
        Audit.objects.filter(
            tenant=space, action="snapshots.account_opening"
        ).values_list("object_id", flat=True)
    )
    snapshots = {
        str(pk)
        for pk in Snapshot.objects.filter(
            tenant=space, account=account, pk__in=original_snapshots
        ).values_list("pk", flat=True)
    }
    trusted = {"cash": cash, "snapshot": snapshots}
    for change in Audit.objects.filter(
        tenant=space, action=CORRECTION_ACTION, object_id=str(account.pk)
    ).order_by("created_at", "pk"):
        kind = change.detail.get("kind")
        old = change.detail.get("old_source_id")
        new = change.detail.get("new_source_id")
        if kind not in trusted or old not in trusted[kind] or not new:
            continue
        valid = (
            Snapshot.objects.filter(tenant=space, account=account, pk=new).exists()
            if kind == "snapshot"
            else Event.objects.filter(
                tenant=space,
                pk=new,
                kind="opening",
                lines__account=account,
                stage_key__startswith=f"{space.pk}:opening-date:{old}:",
            ).exists()
        )
        if valid:
            trusted[kind].add(new)
    return trusted


def effective_snapshots(space, account=None):
    """Append-only date corrections supersede an old observation at all dates.

    Only immutable, server-written audit records can supersede a snapshot;
    arbitrary user-supplied snapshot details cannot hide prior observations.
    Keep the raw Snapshot table available for evidence/history and export.
    """
    qs = Snapshot.objects.filter(tenant=space)
    changes = Audit.objects.filter(
        tenant=space, action=CORRECTION_ACTION, detail__kind="snapshot"
    )
    if account is not None:
        qs = qs.filter(account=account)
        changes = changes.filter(object_id=str(account.pk))
    superseded = [row.detail["old_source_id"] for row in changes]
    return qs.exclude(pk__in=superseded) if superseded else qs


def _opening_source(space, account):
    trusted = trusted_opening_ids(space, account)
    snapshots = list(
        effective_snapshots(space, account)
        .filter(pk__in=trusted["snapshot"])
        .order_by("economic_date", "created_at")[:2]
    )
    if snapshots:
        if len(snapshots) != 1:
            return (
                None,
                "snapshot",
                "存在多条开户权益，需先核对期初来源，不能直接改日期",
            )
        return snapshots[0], "snapshot", None
    events = Event.objects.filter(
        tenant=space,
        kind="opening",
        reversal__isnull=True,
        reverses__isnull=True,
        lines__account=account,
        pk__in=trusted["cash"],
    ).distinct()
    candidates = []
    for event in events:
        if event.payload.get("instrument_id") or event.movements.exists():
            continue
        lines = list(event.lines.all())
        account_lines = [line for line in lines if line.account_id == account.pk]
        equities = [
            line for line in lines if line.account_id is None and line.code == "equity"
        ]
        if (
            len(lines) == 2
            and len(account_lines) == len(equities) == 1
            and account_lines[0].code == cash_code(account)
            and all(
                line.currency == account.currency and line.instrument_id is None
                for line in lines
            )
            and account_lines[0].amount + equities[0].amount == 0
        ):
            candidates.append(event)
    if len(candidates) > 1:
        return None, "cash", "存在多条现金期初，需先核对来源，不能直接改日期"
    if candidates:
        return candidates[0], "cash", None
    return (
        None,
        None,
        "没有可更正的账户现金期初或开户权益；持仓买入日期请在持仓记录中处理",
    )


def _date_limits(space, account, source, kind):
    events = Event.objects.filter(
        tenant=space, reversal__isnull=True, reverses__isnull=True
    ).filter(Q(lines__account=account) | Q(movements__account=account))
    if kind == "cash":
        events = events.exclude(pk=source.pk)
    elif source.included_event_ids:
        events = events.exclude(pk__in=source.included_event_ids)
    event = events.order_by("economic_date").first()
    snapshots = effective_snapshots(space, account)
    if kind == "snapshot":
        snapshots = snapshots.exclude(pk=source.pk)
    observation = snapshots.order_by("economic_date").first()
    maximum = min(
        [day()]
        + ([event.economic_date] if event else [])
        + ([observation.economic_date] if observation else [])
    )
    minimum = None
    if kind == "snapshot" and source.included_event_ids:
        included = (
            Event.objects.filter(tenant=space, pk__in=source.included_event_ids)
            .order_by("-economic_date")
            .first()
        )
        minimum = included.economic_date if included else None
    return minimum, maximum


def opening_date_metadata(space, account):
    account = get_obj(Account, space, account.pk)
    source, kind, reason = _opening_source(space, account)
    minimum, maximum = (
        _date_limits(space, account, source, kind) if source else (None, day())
    )
    if account.archived:
        reason = "账户已归档，请先恢复账户再更正期初日期"
    elif (
        source
        and kind == "cash"
        and (
            source.related_id
            or source.following.filter(
                reversal__isnull=True, reverses__isnull=True
            ).exists()
        )
    ):
        reason = "期初存在关联业务阶段，需先核对并处理关联记录，不能单独改日期"
    elif minimum and minimum > maximum:
        reason = "期初覆盖的资金记录与后续记录日期冲突，请先核对机构权益范围"
    amount = None
    if source:
        amount = (
            source.equity
            if kind == "snapshot"
            else abs(source.lines.get(account=account, code=cash_code(account)).amount)
        )
    return serial(
        {
            "account_id": str(account.pk),
            "available": source is not None,
            "editable": source is not None and reason is None,
            "kind": kind,
            "opening_date": source.economic_date if source else None,
            "amount": amount,
            "currency": account.currency,
            "version": account.version,
            "data_revision": Workspace.objects.only("revision")
            .get(pk=space.pk)
            .revision,
            "source_id": str(source.pk) if source else None,
            "min_date": minimum,
            "max_date": maximum,
            "reason": reason,
            "method": (
                "append_snapshot" if kind == "snapshot" else "reverse_and_replace"
            )
            if source
            else None,
        }
    )


@transaction.atomic
def correct_opening_date(space, user, account, body):
    """Called by an authorized, idempotent account command under tenant scope."""
    from .platform_admin import expected_version

    if set(body) - {"version", "expected_revision", "opening_date", "reason"}:
        raise DomainError("此操作只更正期初日期，不能同时修改金额、币种或权益范围")
    locked_space = Workspace.objects.select_for_update().get(pk=space.pk)
    if locked_space.deleted_at:
        raise DomainError("此空间已移入回收站", "not_found", 404)
    account = get_obj(Account, space, account.pk)
    account = Account.objects.select_for_update().get(pk=account.pk, tenant=space)
    expected_version(body, account.version)
    if "expected_revision" not in body:
        raise DomainError("请刷新期初记录并提供账簿版本", "revision_required", 428)
    if isinstance(body["expected_revision"], bool) or str(
        body["expected_revision"]
    ) != str(locked_space.revision):
        raise DomainError(
            "账簿已有新记录，请刷新后重新核对期初日期", "version_conflict", 412
        )
    metadata = opening_date_metadata(space, account)
    if not metadata["editable"]:
        raise DomainError(metadata["reason"], "opening_date_not_editable", 409)
    raw_date = body.get("opening_date")
    if not isinstance(raw_date, str) or not raw_date:
        raise DomainError("请填写更正后的期初日期")
    when = day(raw_date)
    reason = body.get("reason")
    if not isinstance(reason, str) or not reason.strip() or len(reason.strip()) > 500:
        raise DomainError("请填写 1 至 500 字的期初日期更正说明")
    if when > day():
        raise DomainError("期初日期不能晚于今天")
    if when > day(metadata["max_date"]):
        raise DomainError(
            f"期初日期不能晚于已有资金、持仓或权益记录日期 {metadata['max_date']}，否则这些记录将失去期初依据",
            "opening_date_dependency",
            409,
        )
    if metadata["min_date"] and when < day(metadata["min_date"]):
        raise DomainError(
            "更正日期不能早于本期初权益已包含的资金记录", "opening_date_dependency", 409
        )
    if when == day(metadata["opening_date"]):
        return {
            **metadata,
            "changed": False,
            "previous_date": metadata["opening_date"],
            "new_source_id": metadata["source_id"],
        }
    source, kind, _ = _opening_source(space, account)
    old_id = str(source.pk)
    old_date = source.economic_date
    reversal = None
    if kind == "snapshot":
        details = deepcopy(source.details)
        details["opening_date_supersedes"] = old_id
        replacement = Snapshot.objects.create(
            tenant=space,
            created_by=user,
            account=account,
            economic_date=when,
            equity=source.equity,
            currency=source.currency,
            coverage=source.coverage,
            complete=source.complete,
            includes_options=source.includes_options,
            included_event_ids=deepcopy(source.included_event_ids),
            details=details,
        )
        bump(space, user)
    else:
        lines = list(source.lines.all())
        reversal = reverse_event(space, user, source, reason.strip())
        payload = deepcopy(source.payload)
        payload.update(economic_date=str(when), opening_date_supersedes=old_id)
        replacement = Event.objects.create(
            tenant=space,
            created_by=user,
            kind="opening",
            economic_date=when,
            description=source.description,
            category=source.category,
            payload=payload,
            operation_id=source.operation_id,
            stage_key=f"{space.pk}:opening-date:{source.pk}:{uuid.uuid4()}",
            revision=bump(space, user),
        )
        # Recreate precisely the old balanced amounts in the same transaction;
        # post_event's normal duplicate-opening guard stays strict for all callers.
        JournalLine.objects.bulk_create(
            [
                JournalLine(
                    tenant=space,
                    created_by=user,
                    event=replacement,
                    account_id=line.account_id,
                    code=line.code,
                    currency=line.currency,
                    amount=line.amount,
                    instrument_id=line.instrument_id,
                )
                for line in lines
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
            "kind": kind,
            "old_source_id": old_id,
            "new_source_id": str(replacement.pk),
            "old_date": str(old_date),
            "new_date": str(when),
            "reason": reason.strip(),
            "reversal_id": str(reversal.pk) if reversal else None,
        },
    )
    return {
        **opening_date_metadata(space, account),
        "changed": True,
        "previous_date": str(old_date),
        "new_source_id": str(replacement.pk),
        "reversal_id": str(reversal.pk) if reversal else None,
    }
