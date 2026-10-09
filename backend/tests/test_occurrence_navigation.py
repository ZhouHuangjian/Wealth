"""Precise exception links read historical identities without posting money."""

from copy import deepcopy
from datetime import date

import pytest
from test_api import app as shared_app
from wealth.common import tenant_context
from wealth.ledger import post_event
from wealth.models import (
    Account,
    Event,
    Instrument,
    JournalLine,
    Occurrence,
    Resource,
    Workspace,
)

pytestmark = pytest.mark.django_db
app = shared_app


@pytest.mark.parametrize("identity_source", ["plan", "details", "debit"])
def test_occurrence_links_keep_precise_historical_identity_and_get_is_read_only(
    app, monkeypatch, identity_source
):
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 10, 9))
    with tenant_context(app.space.pk):
        old_source = Account.objects.create(
            tenant=app.space, name="原扣款账户", kind="bank"
        )
        holding = Account.objects.create(
            tenant=app.space, name="当前持仓账户", kind="fund"
        )
        old_holding = Account.objects.create(
            tenant=app.space, name="原持仓账户", kind="fund"
        )
        product = Instrument.objects.create(
            tenant=app.space, name="当前产品", kind="fund", code="TEST-CURRENT"
        )
        old_product = Instrument.objects.create(
            tenant=app.space, name="原产品", kind="fund", code="TEST-OLD"
        )
        plan = Resource.objects.create(
            tenant=app.space,
            kind="plans",
            data={
                "name": "无需查询计划列表的定位",
                "kind": "dca",
                "status": "active",
                "account_id": str(app.account.pk),
                "instrument_id": str(product.pk),
                "automation": {"enabled": False, "holding_account_id": str(holding.pk)},
            },
        )
        old_identity = {
            "account_id": str(old_source.pk),
            "instrument_id": str(old_product.pk),
            "holding_account_id": str(old_holding.pk),
        }
        debit = None
        if identity_source == "debit":
            post_event(
                app.space,
                app.owner,
                {
                    "kind": "opening",
                    "account_id": str(old_source.pk),
                    "amount": "100",
                    "economic_date": "2026-09-01",
                },
            )
            debit = post_event(
                app.space,
                app.owner,
                {
                    "kind": "fund_debit",
                    **old_identity,
                    "amount": "10",
                    "economic_date": "2026-09-23",
                },
            )
        occurrence = Occurrence.objects.create(
            tenant=app.space,
            plan=plan,
            event=debit,
            sequence=1,
            due_date="2026-09-23",
            amount="10",
            currency="CNY",
            details=old_identity if identity_source == "details" else {},
        )
        before = (
            list(Event.objects.values()),
            list(JournalLine.objects.values()),
            list(Occurrence.objects.values()),
            list(Resource.objects.values()),
            Workspace.objects.get(pk=app.space.pk).revision,
        )
        plan_data = deepcopy(plan.data)
        app.client.force_login(app.viewer)
        response = app.client.get(app.base + "/occurrences")
        assert response.status_code == 200, response.content
        row = next(
            row for row in response.json()["items"] if row["id"] == str(occurrence.pk)
        )
        expected = (
            old_identity
            if identity_source != "plan"
            else {
                "account_id": str(app.account.pk),
                "instrument_id": str(product.pk),
                "holding_account_id": str(holding.pk),
            }
        )
        assert {field: row[field] for field in expected} == expected
        assert row["plan_id"] == str(plan.pk)
        assert row["automation"]["status"] == "disabled"
        assert (
            list(Event.objects.values()),
            list(JournalLine.objects.values()),
            list(Occurrence.objects.values()),
            list(Resource.objects.values()),
            Workspace.objects.get(pk=app.space.pk).revision,
        ) == before
        plan.refresh_from_db()
        assert plan.data == plan_data
        # Explicit fixture opt-in exposes an attention period on the Home list.
        # This change belongs to setup; both GET requests below remain read-only.
        plan.data["automation"]["enabled"] = True
        plan.save(update_fields=["data"])
        occurrence.details = {
            **occurrence.details,
            "automation": {"status": "needs_review", "message": "测试原记录差异"},
        }
        occurrence.save(update_fields=["details"])
        before_home = (
            list(Event.objects.values()),
            list(JournalLine.objects.values()),
            list(Occurrence.objects.values()),
            list(Resource.objects.values()),
            Workspace.objects.get(pk=app.space.pk).revision,
        )
        response = app.client.get(app.base + "/overview", {"as_of": "2026-10-09"})
        assert response.status_code == 200, response.content
        home_row = next(
            row for row in response.json()["todos"] if row["id"] == str(occurrence.pk)
        )
        assert {field: home_row[field] for field in expected} == expected
        assert home_row["plan_id"] == str(plan.pk)
        assert home_row["automation"]["status"] == "needs_review"
        assert (
            list(Event.objects.values()),
            list(JournalLine.objects.values()),
            list(Occurrence.objects.values()),
            list(Resource.objects.values()),
            Workspace.objects.get(pk=app.space.pk).revision,
        ) == before_home


def test_occurrence_identity_projection_does_not_expose_another_space(app, monkeypatch):
    monkeypatch.setattr("wealth.planning.today", lambda space: date(2026, 10, 9))
    other = Workspace.objects.create(name="另一空间")
    with tenant_context(other.pk):
        account = Account.objects.create(tenant=other, name="私有账户")
        plan = Resource.objects.create(
            tenant=other,
            kind="plans",
            data={
                "kind": "expense",
                "name": "私有计划",
                "status": "active",
                "account_id": str(account.pk),
                "automation": {"enabled": False},
            },
        )
        occurrence = Occurrence.objects.create(
            tenant=other,
            plan=plan,
            sequence=1,
            due_date="2026-09-23",
            amount="10",
            currency="CNY",
        )
    app.client.force_login(app.viewer)
    for path in ("/occurrences", "/overview?as_of=2026-10-09"):
        response = app.client.get(app.base + path)
        assert response.status_code == 200, response.content
        assert str(account.pk) not in response.content.decode()
        assert str(plan.pk) not in response.content.decode()
        assert str(occurrence.pk) not in response.content.decode()
