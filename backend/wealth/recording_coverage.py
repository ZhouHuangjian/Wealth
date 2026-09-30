"""Describe explicitly selected recording scope; balances alone are not returns."""

from .common import DomainError
from .models import Event, Resource, Snapshot
from .planning import _remember


def coverage(space, account):
    row = Resource.objects.filter(
        tenant=space, kind="account_recording", data__account_id=str(account.pk)
    ).first()
    first_event = (
        Event.objects.filter(
            tenant=space,
            lines__account=account,
            reversal__isnull=True,
            reverses__isnull=True,
        )
        .order_by("economic_date")
        .first()
    )
    first_snapshot = (
        Snapshot.objects.filter(tenant=space, account=account)
        .order_by("economic_date")
        .first()
    )
    dates = [obj.economic_date for obj in (first_event, first_snapshot) if obj]
    data = row.data if row else {}
    return {
        "recording_mode": data.get(
            "recording_mode",
            "transactions",
        ),
        "history_status": data.get("history_status", "unknown"),
        "recording_start_date": str(min(dates)) if dates else None,
    }


def save_coverage(space, user, account, body):
    if not any(k in body for k in ("recording_mode", "history_status")):
        return
    row = Resource.objects.filter(
        tenant=space, kind="account_recording", data__account_id=str(account.pk)
    ).first()
    existing = row.data if row else {}
    mode = body.get(
        "recording_mode",
        existing.get("recording_mode")
        or (
            "transactions"
            if account.valuation_mode == "detailed"
            or account.kind in {"future", "futures", "option", "options"}
            else "balance"
        ),
    )
    history = body.get("history_status", existing.get("history_status", "unknown"))
    if mode not in {"balance", "transactions"} or history not in {
        "unknown",
        "partial",
        "complete_since_start",
    }:
        raise DomainError("请选择有效的记录方式和历史完整程度")
    if mode == "balance" and account.valuation_mode != "snapshot":
        raise DomainError("余额记录请使用机构余额 / 权益计值方式")
    data = {
        "account_id": str(account.pk),
        "recording_mode": mode,
        "history_status": history,
    }
    if row:
        _remember(row, user)
        row.data = data
        row.version += 1
        row.save(update_fields=["data", "version"])
    else:
        Resource.objects.create(
            tenant=space, created_by=user, kind="account_recording", data=data
        )
