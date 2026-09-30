"""At-least-once jobs; opt-in DCA records estimated bookkeeping, never bank orders."""

from datetime import timedelta

from celery import shared_task
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from .common import DomainError, bump, tenant_context
from .models import Membership, Occurrence, Outbox, Projection, Resource, Workspace
from .reporting import overview


DELIVERY_LEASE = timedelta(minutes=5)


@shared_task(name="wealth.tasks.refresh_market_instrument")
def refresh_market_instrument(space_id, instrument_id, token):
    from .market_sync import refresh_one

    result = refresh_one(space_id, instrument_id, token)
    if result.get("status") in {"ready", "failed"}:
        evaluate_signals_for_space(space_id)
    return result


@shared_task(name="wealth.tasks.refresh_market_all")
def refresh_market_all():
    from .market_sync import refresh_due

    return refresh_due()


def evaluate_signals_for_space(space_id):
    from .insights import evaluate_rules

    with tenant_context(space_id):
        space = (
            Workspace.objects.select_for_update()
            .filter(pk=space_id, deleted_at__isnull=True)
            .first()
        )
        if not space:
            return {"items": []}
        owner = (
            Membership.objects.filter(workspace=space, role="owner")
            .select_related("user")
            .first()
        )
        return evaluate_rules(space, owner.user if owner else None)


@shared_task(name="wealth.tasks.evaluate_signals_all")
def evaluate_signals_all():
    evaluated = 0
    for sid in Workspace.objects.filter(deleted_at__isnull=True).values_list(
        "pk", flat=True
    ):
        evaluated += len(evaluate_signals_for_space(str(sid))["items"])
    return {"evaluated": evaluated}


@shared_task(name="wealth.tasks.refresh_market_catalog")
def refresh_market_catalog():
    from .catalog import refresh_catalog
    from .market_sync import enabled

    return refresh_catalog() if enabled() else {"status": "disabled"}


@shared_task(name="wealth.tasks.recompute")
def recompute(space_id, job_id):
    from .planning import today

    with tenant_context(space_id):
        # All writers acquire workspace then child locks in the same order.
        space = (
            Workspace.objects.select_for_update()
            .filter(pk=space_id, deleted_at__isnull=True)
            .first()
        )
        if not space:
            return {"status": "not_found"}
        job = (
            Outbox.objects.select_for_update()
            .filter(tenant_id=space_id, pk=job_id)
            .first()
        )
        if not job:
            return {"status": "not_found"}
        if job.status in {"done", "superseded"}:
            return {"status": job.status}
        if job.revision != space.revision:
            job.status = "superseded"
            job.error = ""
            job.save(update_fields=["status", "error"])
            return {"status": "superseded"}
        latest = Projection.objects.filter(tenant=space).order_by("-revision").first()
        if latest and latest.revision > job.revision:
            job.status = "superseded"
            job.error = ""
            job.save(update_fields=["status", "error"])
            return {"status": "superseded"}
        as_of = today(space)
        try:
            # The savepoint permits persisting a durable failure even if the
            # projection query itself fails; never overwrite a newer projection.
            with transaction.atomic():
                payload = overview(space, when=as_of)
                Projection.objects.get_or_create(
                    tenant=space,
                    revision=job.revision,
                    as_of=as_of,
                    defaults={"payload": payload},
                )
        except Exception:
            job.status = "failed"
            job.error = "projection_failed"
            job.save(update_fields=["status", "error"])
            return {"status": "failed", "code": "projection_failed"}
        job.status = "done"
        job.error = ""
        job.save(update_fields=["status", "error"])
        return {"status": "done", "revision": job.revision}


@shared_task(name="wealth.tasks.dispatch_all")
def dispatch_all(inline=False):
    from .platform_cleanup import retry_pending_file_cleanup

    retry_pending_file_cleanup()
    delivered = 0
    failed = 0
    for sid in Workspace.objects.filter(deleted_at__isnull=True).values_list(
        "pk", flat=True
    ):
        with tenant_context(sid):
            space = Workspace.objects.select_for_update().get(pk=sid)
            if space.deleted_at:
                continue
            expired = timezone.now() - DELIVERY_LEASE
            ready = (
                Q(status__in=["pending", "failed"])
                | Q(status="queued", dispatched_at__lte=expired)
                | Q(status="queued", dispatched_at__isnull=True)
            )
            jobs = list(
                Outbox.objects.select_for_update(skip_locked=True)
                .filter(ready, tenant_id=sid)
                .order_by("created_at")[:100]
            )
            for job in jobs:
                job.attempts += 1
                job.save(update_fields=["attempts"])
                if inline:
                    result = recompute(str(sid), str(job.pk))
                    if result.get("status") == "failed":
                        failed += 1
                    else:
                        delivered += 1
                    continue
                try:
                    recompute.delay(str(sid), str(job.pk))
                except Exception:
                    job.status = "failed"
                    job.error = "broker_unavailable"
                    job.save(update_fields=["status", "error"])
                    failed += 1
                    continue
                job.status = "queued"
                job.error = ""
                job.dispatched_at = timezone.now()
                job.save(update_fields=["status", "error", "dispatched_at"])
                delivered += 1
    return {"dispatched": delivered, "failed": failed}


@shared_task(name="wealth.tasks.scan_all")
def scan_all():
    from .planning import generate_schedule, today

    count = 0
    for sid in Workspace.objects.filter(deleted_at__isnull=True).values_list(
        "pk", flat=True
    ):
        with tenant_context(sid):
            space = Workspace.objects.select_for_update().get(pk=sid)
            if space.deleted_at:
                continue
            owner = (
                Membership.objects.filter(workspace=space, role="owner")
                .select_related("user")
                .first()
            )
            if not owner:
                continue
            active = Q(data__status="active") | Q(data__status__isnull=True)
            plans = Resource.objects.filter(
                active, tenant=space, kind__in=["plans", "loans"]
            )
            current_day = today(space)
            from .fund_orders import scan_orders

            scan_orders(space, owner.user)
            for plan in plans:
                generate_schedule(
                    space, owner.user, plan, current_day + timedelta(days=365)
                )
            due = Occurrence.objects.filter(
                tenant=space,
                plan__in=plans,
                due_date__lte=current_day,
                event__isnull=True,
            )
            advanced = due.filter(status="scheduled").update(
                status="pending", version=F("version") + 1
            )
            if advanced:
                bump(space, owner.user, invalidate_reconciliations=False)
            from .dca_automation import run_plan

            automatic_plans = Resource.objects.filter(
                tenant=space,
                kind="plans",
                data__kind="dca",
                data__automation__enabled=True,
            )
            for plan in automatic_plans:
                try:
                    with transaction.atomic():
                        run_plan(space, owner.user, plan.pk)
                except DomainError:
                    # Invalid/deleted plan dependencies do not prevent other
                    # spaces from scanning; the explicit check exposes the error.
                    continue
            # Count all actionable due intentions, including newly generated rows.
            count += due.filter(status="pending").count()
    return {"pending": count}


@shared_task(name="wealth.tasks.refresh_dividends_for_space")
def refresh_dividends_for_space(space_id):
    from .dividends import refresh_space_dividends

    result = refresh_space_dividends(space_id)
    if result.get("has_more"):
        refresh_dividends_for_space.delay(space_id)
    return result


@shared_task(name="wealth.tasks.refresh_dividends_all")
def refresh_dividends_all():
    from .dividends import refresh_due_dividends

    return refresh_due_dividends()
