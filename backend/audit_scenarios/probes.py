"""Real connections/process boundaries in a synthetic audit DB, no live network."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import date, datetime, timezone
import json
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
import uuid

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import close_old_connections

from wealth.common import tenant_context
from wealth.dca_automation import run_plan
from wealth.ledger import balance, position, post_event
from wealth.models import (
    Account,
    Event,
    Instrument,
    Membership,
    Price,
    Workspace,
)
from wealth.planning import save_resource
from wealth.tasks import scan_all

DAY = date(2026, 9, 29)
STAMP = datetime(2026, 9, 29, 7, tzinfo=timezone.utc)
MANIFEST = (
    Path(__file__).resolve().parents[2] / ".runtime" / "audit-local" / "restart.json"
)


def controlled(stack):
    assert settings.DATABASES["default"]["NAME"] == "wealth_ui_test"
    from wealth import market_data

    def forbidden(*args, **kwargs):
        raise AssertionError("audit probes must never request live market data")

    stack.enter_context(patch("wealth.planning.today", return_value=DAY))
    stack.enter_context(patch("django.utils.timezone.localdate", return_value=DAY))
    stack.enter_context(patch("django.utils.timezone.now", return_value=STAMP))
    for module in ("trading_calendar", "subscription_calendar", "valuation_calendar"):
        stack.enter_context(
            patch(
                f"wealth.{module}.is_trading_day",
                side_effect=lambda value, calendar_id="CN_EXCHANGE": (
                    date.fromisoformat(str(value)).weekday() < 5
                    if str(value).startswith("2026-")
                    else None
                ),
            )
        )
    for name in ("_get", "_post"):
        stack.enter_context(patch.object(market_data, name, side_effect=forbidden))
    stack.enter_context(patch("wealth.akshare_provider._invoke", side_effect=forbidden))


def seed():
    user = get_user_model().objects.create_user("probe-" + uuid.uuid4().hex[:16])
    space = Workspace.objects.create(name="synthetic audit probe")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        bank = Account.objects.create(tenant=space, name="synthetic bank", kind="bank")
        fund = Account.objects.create(
            tenant=space, name="synthetic fund account", kind="fund"
        )
        inst = Instrument.objects.create(
            tenant=space,
            name="synthetic fund",
            code="020602",
            kind="fund",
            specification={"confirmation_days": 0, "share_precision": 2},
        )
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(bank.pk),
                "amount": "1000",
                "economic_date": str(DAY),
            },
        )
        plan = save_resource(
            space,
            user,
            "plans",
            {
                "name": "synthetic once",
                "kind": "dca",
                "account_id": str(bank.pk),
                "instrument_id": str(inst.pk),
                "start_date": str(DAY),
                "end_date": str(DAY),
                "frequency": "daily",
                "amount": "102",
                "status": "active",
                "automation": {
                    "enabled": True,
                    "holding_account_id": str(fund.pk),
                    "fee_mode": "zero",
                },
            },
            run_automatic=False,
        )
    return space, user, bank, fund, inst, plan


def facts(space, bank, fund, inst):
    result = {
        "debit": Event.objects.filter(tenant=space, kind="fund_debit").count(),
        "confirm": Event.objects.filter(tenant=space, kind="fund_confirm").count(),
        "cash": str(balance(space, bank, "cash")),
        "shares": str(position(space, fund, inst)[0]),
    }
    assert (result["debit"], result["confirm"]) == (1, 1), result
    assert balance(space, bank, "cash") == 898, result
    assert position(space, fund, inst)[0] == 100, result
    return result


def main(action):
    with ExitStack() as stack:
        controlled(stack)
        if action == "concurrency":
            space, user, bank, fund, inst, plan = seed()
            with tenant_context(space.pk):
                Price.objects.create(
                    tenant=space,
                    instrument=inst,
                    kind="official_nav",
                    economic_date=DAY,
                    value="1.02",
                )
            start = Barrier(2)

            def worker():
                close_old_connections()
                try:
                    start.wait(timeout=10)
                    with tenant_context(space.pk):
                        return run_plan(
                            Workspace.objects.get(pk=space.pk), user, plan.pk
                        )["completed_count"]
                finally:
                    close_old_connections()

            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: worker(), range(2)))
            with tenant_context(space.pk):
                print(
                    json.dumps(
                        {
                            "probe": action,
                            "workers": results,
                            **facts(space, bank, fund, inst),
                        }
                    )
                )
        elif action in {"restart-prepare", "restart-completed-prepare"}:
            space, user, bank, fund, inst, plan = seed()
            with tenant_context(space.pk):
                assert (
                    run_plan(space, user, plan.pk)["items"][0]["status"]
                    == "waiting_nav"
                )
                assert (
                    Event.objects.filter(tenant=space, kind="fund_debit").count() == 1
                )
                assert not Event.objects.filter(
                    tenant=space, kind="fund_confirm"
                ).exists()
                if action == "restart-completed-prepare":
                    plan = save_resource(
                        space, user, "plans", {"status": "completed"}, plan
                    )
            MANIFEST.parent.mkdir(parents=True, exist_ok=True)
            MANIFEST.write_text(
                json.dumps(
                    {
                        "space": str(space.pk),
                        "bank": str(bank.pk),
                        "fund": str(fund.pk),
                        "instrument": str(inst.pk),
                        "plan": str(plan.pk),
                        "plan_status": plan.data["status"],
                    }
                )
            )
            print(
                json.dumps(
                    {
                        "probe": action,
                        "state": "waiting_nav",
                        "plan_status": plan.data["status"],
                        "debit": 1,
                        "confirm": 0,
                    }
                )
            )
        elif action == "restart-recover":
            keys = json.loads(MANIFEST.read_text())
            space = Workspace.objects.get(
                pk=keys["space"], name="synthetic audit probe"
            )
            with tenant_context(space.pk):
                bank, fund = (
                    Account.objects.get(pk=keys["bank"]),
                    Account.objects.get(pk=keys["fund"]),
                )
                inst = Instrument.objects.get(pk=keys["instrument"])
                Price.objects.create(
                    tenant=space,
                    instrument=inst,
                    kind="official_nav",
                    economic_date=DAY,
                    value="1.02",
                )
            scan_all()
            scan_all()
            with tenant_context(space.pk):
                print(json.dumps({"probe": action, **facts(space, bank, fund, inst)}))
        else:
            raise ValueError("unknown probe")
