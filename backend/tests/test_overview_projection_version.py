"""Overview structure upgrades reject old caches without changing saved facts."""

from copy import deepcopy
from datetime import date

import pytest
from django.db import connection
from test_api import app as shared_app
from wealth.common import tenant_context
from wealth.ledger import post_event
from wealth.models import (
    Account,
    Event,
    Instrument,
    JournalLine,
    Occurrence,
    Outbox,
    PositionMovement,
    Projection,
    Resource,
    Workspace,
)
from wealth.reporting import overview

pytestmark = pytest.mark.django_db
app = shared_app
LEGACY_VERSION = "account-equity-v24"
TODAY = date(2026, 10, 9)


@pytest.fixture
def pending_home(app, monkeypatch):
    monkeypatch.setattr("django.utils.timezone.localdate", lambda: TODAY)
    monkeypatch.setattr("wealth.planning.today", lambda space: TODAY)
    with tenant_context(app.space.pk):
        holding = Account.objects.create(
            tenant=app.space, name="合成持仓账户", kind="fund"
        )
        product = Instrument.objects.create(
            tenant=app.space, name="合成产品", kind="fund", code="TEST-CACHE"
        )
        post_event(
            app.space,
            app.owner,
            {
                "kind": "opening",
                "account_id": str(app.account.pk),
                "amount": "100",
                "economic_date": "2026-09-01",
            },
        )
        plan = Resource.objects.create(
            tenant=app.space,
            kind="plans",
            data={
                "name": "合成自动定投",
                "kind": "dca",
                "status": "active",
                "account_id": str(app.account.pk),
                "instrument_id": str(product.pk),
                "automation": {"enabled": True, "holding_account_id": str(holding.pk)},
            },
        )
        occurrence = Occurrence.objects.create(
            tenant=app.space,
            plan=plan,
            sequence=1,
            due_date=TODAY,
            amount="20",
            currency="CNY",
            details={
                "account_id": str(app.account.pk),
                "holding_account_id": str(holding.pk),
                "instrument_id": str(product.pk),
                "automation": {
                    "status": "waiting_cash",
                    "message": "可用资金不足，等待核对余额",
                },
            },
        )
    app.client.force_login(app.viewer)
    return app, occurrence


def saved_state(space):
    return {
        model.__name__: list(model.objects.filter(tenant=space).order_by("pk").values())
        for model in (
            Account,
            Instrument,
            Event,
            JournalLine,
            PositionMovement,
            Occurrence,
            Resource,
            Outbox,
            Projection,
        )
    } | {"revision": Workspace.objects.get(pk=space.pk).revision}


def reject_writes(execute, sql, params, many, context):
    assert (
        not sql.lstrip()
        .upper()
        .startswith(
            ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "ALTER", "DROP", "CREATE")
        )
    ), sql
    return execute(sql, params, many, context)


@pytest.mark.parametrize(
    ("status", "message"),
    [
        ("waiting_cash", "可用资金不足，等待核对余额"),
        ("needs_review", "正式净值来源存在差异，请核对"),
    ],
)
def test_legacy_overview_cache_is_recomputed_read_only(pending_home, status, message):
    app, occurrence = pending_home
    with tenant_context(app.space.pk):
        occurrence.details["automation"] = {"status": status, "message": message}
        occurrence.save(update_fields=["details"])
        legacy_payload = deepcopy(overview(app.space))
        legacy_payload["calculation_version"] = LEGACY_VERSION
        # The actual 2.11.0 build (0103fc8) emitted this limited todo shape.
        # Its automation.message is generic, so the original reason is lost.
        for todo in legacy_payload["todos"]:
            for field in (
                "occurrence_id",
                "details",
                "account_id",
                "holding_account_id",
                "instrument_id",
            ):
                todo.pop(field, None)
        cached = Projection.objects.create(
            tenant=app.space,
            revision=app.space.revision,
            as_of=TODAY,
            payload=legacy_payload,
        )
        before = saved_state(app.space)
        # Same-day repeated GETs must remain correct without replacing old rows.
        for _ in range(2):
            with connection.execute_wrapper(reject_writes):
                response = app.client.get(app.base + "/overview")
            assert response.status_code == 200, response.content
            payload = response.json()
            todo = next(
                row for row in payload["todos"] if row["id"] == str(occurrence.pk)
            )
            assert todo.get("account_id") == occurrence.details["account_id"]
            assert (
                todo.get("holding_account_id")
                == occurrence.details["holding_account_id"]
            )
            assert todo.get("instrument_id") == occurrence.details["instrument_id"]
            assert todo.get("occurrence_id") == str(occurrence.pk)
            assert todo["details"]["automation"]["message"] == message
            assert payload["calculation_version"] != LEGACY_VERSION
            assert not payload.get("cached", False)
            assert saved_state(app.space) == before
        cached.refresh_from_db()
        assert cached.payload == legacy_payload


def test_current_overview_cache_remains_usable_and_read_only(pending_home):
    app, _ = pending_home
    with tenant_context(app.space.pk):
        payload = overview(app.space)
        assert payload["calculation_version"] != LEGACY_VERSION
        Projection.objects.create(
            tenant=app.space,
            revision=app.space.revision,
            as_of=TODAY,
            payload=payload,
        )
        before = saved_state(app.space)
        with connection.execute_wrapper(reject_writes):
            response = app.client.get(app.base + "/overview")
        assert response.status_code == 200, response.content
        assert response.json() == {**payload, "cached": True}
        assert saved_state(app.space) == before
