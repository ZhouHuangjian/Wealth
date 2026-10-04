"""Due-only DCA scheduling and conservative removal of unused old projections.

An occurrence is an execution record. Future scenarios are generated from plan
rules in memory; deleting an untouched generated projection never posts money.
"""

from datetime import timedelta

from django.apps import apps
from django.db import transaction
from finance_math.calculations import add_months

from .common import DomainError, audit, bump, day, dec, record
from .models import Audit, Occurrence, Projection, ResourceRevision, Workspace

GENERATED_FIELDS = {
    "sequence",
    "due_date",
    "amount",
    "scheduled_date",
    "holiday_policy",
    "subscription_day",
    "auto_skip",
    "shifted_from",
    "account_id",
    "liability_account_id",
    "instrument_id",
    "plan_kind",
    "plan_version",
}


def is_dca_plan(resource):
    return resource.kind == "plans" and resource.data.get("kind") == "dca"


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _strings(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _strings(child)


def _protected_references(space, candidates):
    """Protect links in current data, revisions, import facts and audit history.

    Cached dashboard projections are disposable read models, not business links.
    Idempotency responses are retained so a retried old operation stays valid.
    """
    protected = set()
    for model in apps.get_app_config("wealth").get_models():
        names = {field.name for field in model._meta.fields}
        if "tenant" not in names or model is Projection:
            continue
        fields = [
            field.name
            for field in model._meta.fields
            if field.get_internal_type() == "JSONField"
        ]
        if model is Audit:
            fields.append("object_id")
        if not fields:
            continue
        manager = getattr(model, "all_objects", model.objects)
        for values in manager.filter(tenant=space).values_list(*fields).iterator():
            for value in values:
                protected.update(candidates.intersection(_strings(value)))
    return protected


def _original_generated_row(row, revisions, generation_audits, current_data):
    from .dca_automation import _excluded

    details = row.details
    if not isinstance(details, dict):
        return False
    version = details.get("plan_version")
    if type(version) is not int or version < 1:
        return False
    previous = revisions.get(version)
    if (
        not previous
        or not details
        or set(details) - GENERATED_FIELDS
        or row.version != 1
        or details.get("plan_kind") != "dca"
        or details.get("sequence") != row.sequence
        or details.get("account_id") != previous.get("account_id")
        or details.get("instrument_id") != previous.get("instrument_id")
        or row.currency != previous.get("currency")
    ):
        return False
    if row.status == "skipped":
        # Only an untouched market-closure projection qualifies. An intentional
        # skip, paused date, or later user edit must survive the transition.
        availability = details.get("subscription_day")
        if (
            details.get("auto_skip") is not True
            or not isinstance(availability, dict)
            or availability.get("is_open") is not False
        ):
            return False
    elif row.status != "scheduled" or details.get("auto_skip"):
        return False
    try:
        start = day(previous["start_date"])
        offset = (row.sequence - 1) * int(previous.get("interval", 1))
        frequency = previous.get("frequency", "monthly")
        anchor = (
            add_months(start, offset, previous.get("day_policy", "clamp"))
            if frequency == "monthly"
            else start + timedelta(days=offset * (7 if frequency == "weekly" else 1))
        )
        original = day(details.get("scheduled_date") or details["due_date"])
        for data in (previous, current_data):
            config = data.get("automation") or {}
            if (
                not isinstance(config, dict)
                or _excluded(config, anchor)
                or _excluded(config, row.due_date)
            ):
                return False
        if (
            anchor != original
            or day(details["due_date"]) != row.due_date
            or dec(details["amount"]) != row.amount
            or dec(previous["amount"]) != row.amount
            or row.due_date < anchor
            or row.due_date != anchor
            and (
                details.get("holiday_policy") != "next_open"
                or day(details.get("shifted_from")) != anchor
            )
        ):
            return False
        return any(
            item.created_at >= row.created_at
            and item.created_by_id == row.created_by_id
            and item.detail.get("plan_version") == version
            and item.detail.get("horizon")
            and day(item.detail.get("horizon")) >= anchor
            for item in generation_audits
        )
    except (DomainError, KeyError, TypeError, ValueError, ArithmeticError):
        return False


def future_occurrence_cleanup_preview(space, resource, as_of):
    """Read-only candidate check. A missing proof always preserves the row."""
    if not is_dca_plan(resource):
        return {"candidates": [], "preserved_count": 0}
    rows = list(
        Occurrence.objects.filter(
            tenant=space,
            plan=resource,
            due_date__gt=as_of,
            event__isnull=True,
        )
    )
    if not rows:
        return {"candidates": [], "preserved_count": 0}
    revisions = dict(
        ResourceRevision.objects.filter(tenant=space, resource=resource).values_list(
            "version", "data"
        )
    )
    generation_audits = list(
        Audit.objects.filter(
            tenant=space,
            action="schedule.generated",
            object_id=str(resource.pk),
        )
    )
    candidates = [
        row
        for row in rows
        if row.status in {"scheduled", "skipped"}
        and _original_generated_row(row, revisions, generation_audits, resource.data)
    ]
    if candidates:
        protected = _protected_references(space, {str(row.pk) for row in candidates})
        candidates = [row for row in candidates if str(row.pk) not in protected]
    return {
        "candidates": candidates,
        "preserved_count": len(rows) - len(candidates),
    }


@transaction.atomic
def prune_future_occurrences(space, user, resource, as_of):
    Workspace.objects.select_for_update().get(pk=space.pk)
    preview = future_occurrence_cleanup_preview(space, resource, as_of)
    candidates = preview["candidates"]
    if candidates:
        # Keep a complete snapshot before removing execution-list projections.
        # Original sequence numbers remain reproducible from the unchanged plan.
        audit(
            space,
            user,
            "dca.future_projections_retired",
            resource,
            {
                "as_of": str(as_of),
                "reason": "定投改为按到期日生成；未来计划由规则即时预测",
                "count": len(candidates),
                "occurrences": [record(row) for row in candidates],
            },
        )
        Occurrence.objects.filter(
            tenant=space, pk__in=[row.pk for row in candidates]
        ).delete()
        bump(space, user, invalidate_reconciliations=False)
    return {
        "removed_count": len(candidates),
        "preserved_count": preview["preserved_count"],
    }
