"""Reconcile intended holds against actual cash payments without posting money."""

from collections import defaultdict
from decimal import Decimal

from .common import DomainError, audit, dec, get_obj
from .models import Event, Occurrence, Resource

ZERO = Decimal(0)


def sync_reservation_payments(space, user):
    """Called under the space writer lock; links are idempotent and reversible.

    Direct payment commands and later plan links are evidence of the same use.
    The private allocation map records how much was already removed from each
    reservation, so edits and reversals apply only the change in consumption.
    """
    from .planning import _remember

    reserves = {
        str(row.pk): row
        for row in Resource.objects.filter(tenant=space, kind="reservations")
    }
    active = Event.objects.filter(
        tenant=space, reversal__isnull=True, reverses__isnull=True
    )
    events = {}
    direct = {}
    linked = defaultdict(Decimal)

    def payment(event, reserve):
        return -sum(
            (
                line.amount
                for line in event.lines.all()
                if str(line.account_id) == reserve.data.get("account_id")
                and line.currency == reserve.data.get("currency")
                and line.code == "cash"
                and line.amount < ZERO
            ),
            ZERO,
        )

    for event in active.filter(payload__has_key="reservation_id").prefetch_related(
        "lines"
    ):
        rid = event.payload.get("reservation_id")
        if not rid:
            continue
        reserve = reserves.get(rid) or get_obj(
            Resource, space, rid, kind="reservations"
        )
        paid = payment(event, reserve)
        if paid <= ZERO:
            raise DomainError("预留须关联该账户和币种的实际现金付款")
        events[str(event.pk)] = event
        direct[(rid, str(event.pk))] = paid

    def link(rid, eid, amount):
        if not rid or not eid:
            return
        if rid not in reserves:
            raise DomainError("付款关联的预留不存在")
        event = events.get(eid)
        if event is None:
            event = active.filter(pk=eid).prefetch_related("lines").first()
            if event is None:
                return  # Reversed evidence never consumes a hold.
            events[eid] = event
        paid = payment(event, reserves[rid])
        value = dec(amount, nonnegative=True)
        if paid <= ZERO or value > paid:
            raise DomainError("付款节点须使用预留账户同币种的真实现金支出")
        linked[(rid, eid)] += value

    for resource in Resource.objects.filter(
        tenant=space, kind__in={"goals", "scenarios"}
    ):
        for node in resource.data.get("payment_nodes", []):
            link(
                node.get("reservation_id"),
                node.get("event_id") or node.get("payment_event_id"),
                node.get("amount"),
            )
    for occurrence in Occurrence.objects.filter(
        tenant=space, event__isnull=False
    ).select_related("plan"):
        link(
            occurrence.plan.data.get("reservation_id"),
            str(occurrence.event_id),
            occurrence.amount,
        )

    allocations = defaultdict(dict)
    cash_allocated = defaultdict(Decimal)
    for rid, eid in direct.keys() | linked.keys():
        used = max(direct.get((rid, eid), ZERO), linked.get((rid, eid), ZERO))
        reserve = reserves[rid]
        identity = (eid, reserve.data["account_id"], reserve.data["currency"])
        cash_allocated[identity] += used
        if cash_allocated[identity] > payment(events[eid], reserve):
            raise DomainError("同一实际现金付款不能重复消耗多笔预留或付款节点")
        allocations[rid][eid] = str(used)

    for rid, reserve in reserves.items():
        old = reserve.data.get("_payment_allocations", {})
        new = allocations[rid]
        if old == new:
            continue
        prior = sum((dec(value) for value in old.values()), ZERO)
        consumed = sum((dec(value) for value in new.values()), ZERO)
        remaining = dec(reserve.data["amount"]) + prior - consumed
        if remaining < ZERO:
            raise DomainError("实际付款超过预留，请明确调整预留金额后关联")
        freeze_base = dec(reserve.data.get("linked_freeze_amount", "0")) + dec(
            reserve.data.get("_payment_freeze_released", "0")
        )
        frozen = min(freeze_base, remaining)
        _remember(reserve, user)
        reserve.data.update(
            amount=str(remaining),
            linked_freeze_amount=str(frozen),
            _payment_freeze_released=str(freeze_base - frozen),
            _payment_allocations=new,
        )
        if remaining == ZERO:
            reserve.data["status"] = "consumed"
        elif reserve.data.get("status") == "consumed":
            reserve.data["status"] = "active"
        reserve.version += 1
        reserve.save(update_fields=["data", "version"])
        _remember(reserve, user)
        audit(space, user, "reservation.payment_linked", reserve, {"payments": new})


def unlink_reversed_goal_payment(space, user, event):
    from .planning import _remember

    for resource in Resource.objects.filter(
        tenant=space, kind__in={"goals", "scenarios"}
    ):
        nodes = resource.data.get("payment_nodes", [])
        affected = [
            node
            for node in nodes
            if str(event.pk) in {node.get("event_id"), node.get("payment_event_id")}
        ]
        if not affected:
            continue
        _remember(resource, user)
        for node in affected:
            node.pop("event_id", None)
            node.pop("payment_event_id", None)
            node["status"] = "pending"
        resource.version += 1
        resource.save(update_fields=["data", "version"])
        _remember(resource, user)
        audit(space, user, "goal.payment_reversed", resource, {"event": str(event.pk)})
