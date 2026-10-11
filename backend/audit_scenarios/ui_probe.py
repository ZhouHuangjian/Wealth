"""Seed/observe the ordinary UI in an explicitly isolated, offline test book.

The plan and institution reconciliation are created through the browser. The
completed state is seeded separately: the current plan editor only exposes
active/paused. All accounts, holdings and prices here are synthetic fixtures.
"""

import csv
import io
import json
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from django.conf import settings
from django.contrib.auth import get_user_model

from wealth.common import tenant_context
from wealth.investments import record_holding
from wealth.ledger import balance, position, post_event
from wealth.models import (
    Account,
    Event,
    Instrument,
    Membership,
    Occurrence,
    Price,
    Resource,
    Workspace,
)
from wealth.planning import save_resource, today
from wealth.tasks import scan_all

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / ".runtime" / "audit-local" / "ui.json"


def main(action):
    if (
        settings.DATABASES["default"]["NAME"] != "wealth_ui_test"
        or settings.WEALTH_MARKET_DATA_ENABLED
    ):
        raise RuntimeError("UI probes require the offline synthetic audit database")
    if action == "ui-prepare":
        user = get_user_model().objects.create_user(
            "repair-ui-" + uuid4().hex[:8], password="Synthetic-repair-2026!"
        )
        space = Workspace.objects.create(
            name="修复验收合成账簿", timezone="Asia/Shanghai"
        )
        Membership.objects.create(workspace=space, user=user, role="owner")
        when, previous = today(space), today(space) - timedelta(days=1)
        with tenant_context(space.pk):
            bank = Account.objects.create(tenant=space, name="合成银行卡", kind="bank")
            fund = Account.objects.create(
                tenant=space, name="合成基金账户", kind="fund"
            )
            inst = Instrument.objects.create(
                tenant=space,
                name="合成净值型基金（仅测试）",
                code="020602",
                kind="fund",
                specification={
                    "confirmation_days": 0,
                    "share_precision": 2,
                    "subscription_calendar": "domestic",
                },
            )
            post_event(
                space,
                user,
                {
                    "kind": "opening",
                    "account_id": str(bank.pk),
                    "amount": "1000",
                    "economic_date": str(previous),
                },
            )
            record_holding(
                space,
                user,
                {
                    "account_id": str(fund.pk),
                    "instrument_id": str(inst.pk),
                    "quantity": "100",
                    "cost": "100",
                    "as_of": str(previous),
                    "purchase_date": str(previous),
                },
            )
            Price.objects.create(
                tenant=space,
                instrument=inst,
                economic_date=previous,
                kind="official_nav",
                value="1",
                source="synthetic UI baseline",
            )
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        stream = io.StringIO()
        writer = csv.writer(stream)
        writer.writerow(
            [
                "code",
                "payment_date",
                "confirmation_date",
                "nav_date",
                "amount",
                "quantity",
                "nav",
                "fee",
                "external_id",
            ]
        )
        writer.writerow(
            [
                inst.code,
                when,
                when,
                when,
                "102",
                "100",
                "1.02",
                "0",
                "synthetic-ui-order",
            ]
        )
        csv_path = MANIFEST.with_name("actual-confirmation.csv")
        csv_path.write_text(stream.getvalue())
        keys = {
            "space": str(space.pk),
            "user": user.username,
            "bank": str(bank.pk),
            "fund": str(fund.pk),
            "instrument": str(inst.pk),
            "date": str(when),
            "csv": str(csv_path),
        }
        MANIFEST.write_text(json.dumps(keys))
        print(json.dumps({"probe": action, **keys}, ensure_ascii=False))
        return
    keys = json.loads(MANIFEST.read_text())
    space = Workspace.objects.get(pk=keys["space"], name="修复验收合成账簿")
    with tenant_context(space.pk):
        bank, fund = (
            Account.objects.get(pk=keys["bank"]),
            Account.objects.get(pk=keys["fund"]),
        )
        inst = Instrument.objects.get(pk=keys["instrument"])
        if action == "ui-nav":
            Price.objects.get_or_create(
                tenant=space,
                instrument=inst,
                economic_date=keys["date"],
                kind="official_nav",
                value="1.02",
                source="synthetic UI fixture",
            )
        elif action == "ui-completed":
            plan = Resource.objects.get(tenant=space, kind="plans")
            save_resource(
                space,
                get_user_model().objects.get(username=keys["user"]),
                "plans",
                {"status": "completed"},
                plan,
            )
        elif action != "ui-facts":
            raise ValueError("unknown UI probe")
    if action == "ui-nav":
        scan_all()
        scan_all()
    with tenant_context(space.pk):
        print(
            json.dumps(
                {
                    "probe": action,
                    "cash": str(balance(space, bank, "cash")),
                    "shares": str(position(space, fund, inst)[0]),
                    "debit": Event.objects.filter(
                        tenant=space, kind="fund_debit"
                    ).count(),
                    "confirm": Event.objects.filter(
                        tenant=space, kind="fund_confirm", reversal__isnull=True
                    ).count(),
                    "occurrences": Occurrence.objects.filter(tenant=space).count(),
                    "plans": [
                        data["status"]
                        for data in Resource.objects.filter(
                            tenant=space, kind="plans"
                        ).values_list("data", flat=True)
                    ],
                }
            )
        )
