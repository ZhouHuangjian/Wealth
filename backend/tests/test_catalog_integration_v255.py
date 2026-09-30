"""API, valuation and background refresh agree on recoverable catalog deletion."""

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from wealth.account_opening import initialize_account
from wealth.common import tenant_context
from wealth.ledger import balance
from wealth.market_sync import quote_list, refresh_one
from wealth.models import (
    Account,
    Event,
    Instrument,
    Membership,
    Price,
    Resource,
    Workspace,
)
from wealth.reporting import overview, performance

pytestmark = pytest.mark.django_db


@pytest.fixture
def book():
    user = get_user_model().objects.create_user("catalog-api-v255")
    space = Workspace.objects.create(name="账户删除集成验收")
    Membership.objects.create(workspace=space, user=user, role="owner")
    client = Client()
    client.force_login(user)
    with tenant_context(space.pk):
        account = Account.objects.create(tenant=space, kind="bank", name="待更正开户")
        initialize_account(
            space,
            user,
            account,
            {"opening_balance": "1000", "opening_date": "2026-09-20"},
        )
        yield SimpleNamespace(user=user, space=space, client=client, account=account)


def api(book, method, path, body=None, key=None):
    return getattr(book.client, method)(
        f"/api/v1/spaces/{book.space.pk}/{path}",
        data=json.dumps(body or {}) if method != "get" else None,
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
    )


def preview(book, kind="accounts", ident=None):
    result = api(book, "get", f"{kind}/{ident or book.account.pk}/deletion")
    assert result.status_code == 200, result.content
    return result.json()


def command(data):
    return {
        "version": data["object"]["version"],
        "expected_revision": data["data_revision"],
        "confirm": True,
    }


def test_date_correction_api_changes_history_once_and_survives_delete_restore(book):
    path = f"accounts/{book.account.pk}/opening-date"
    meta = api(book, "get", path).json()
    assert meta["opening_date"] == "2026-09-20"
    body = {
        "version": meta["version"],
        "expected_revision": meta["data_revision"],
        "opening_date": "2026-09-18",
        "reason": "核对开户日期",
    }
    key = str(uuid.uuid4())
    result = api(book, "post", path, body, key)
    assert result.status_code == 200, result.content
    assert api(book, "post", path, body, key).json() == result.json()
    assert Event.objects.count() == 3
    assert balance(book.space, book.account, as_of="2026-09-18") == Decimal("1000")
    pre = preview(book)
    assert pre["can_delete"], pre
    assert (
        api(book, "delete", f"accounts/{book.account.pk}", command(pre)).status_code
        == 200
    )
    assert Decimal(overview(book.space)["net_assets"]) == 0
    deleted = preview(book)
    assert (
        api(
            book, "post", f"accounts/{book.account.pk}/restore", command(deleted)
        ).status_code
        == 200
    )
    assert Decimal(overview(book.space)["net_assets"]) == 1000
    assert Event.objects.count() == 3
    assert api(book, "get", path).json()["opening_date"] == "2026-09-18"


def test_delete_hides_active_account_but_retains_facts_and_restores_exact_balance(book):
    pre = preview(book)
    assert Decimal(pre["impact"]["net_asset_change"]) == -1000
    path = f"accounts/{book.account.pk}"
    key = str(uuid.uuid4())
    result = api(book, "delete", path, command(pre), key)
    assert result.status_code == 200, result.content
    assert api(book, "delete", path, command(pre), key).json() == result.json()
    assert not api(book, "get", "accounts").json()["items"]
    assert len(api(book, "get", "accounts?status=deleted").json()["items"]) == 1
    assert not api(book, "get", "search?q=待更正").json()["items"]
    assert Decimal(overview(book.space)["net_assets"]) == 0
    assert balance(book.space, book.account) == 1000
    assert Event.objects.count() == 1
    rejected = api(
        book,
        "post",
        "events",
        {
            "kind": "expense",
            "account_id": str(book.account.pk),
            "amount": "1",
            "economic_date": "2026-09-25",
        },
    )
    assert rejected.status_code == 409, rejected.content
    assert (
        api(book, "post", path + "/restore", command(preview(book))).status_code == 200
    )
    assert len(api(book, "get", "accounts").json()["items"]) == 1
    assert not api(book, "get", "accounts?status=deleted").json()["items"]
    assert Decimal(overview(book.space)["net_assets"]) == 1000
    assert Event.objects.count() == 1


def test_product_quotes_preserved_but_deleted_product_not_refreshed(book, monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: True)
    instrument = Instrument.objects.create(
        tenant=book.space, kind="fund", code="019172", name="可恢复产品"
    )
    Price.objects.create(
        tenant=book.space,
        instrument=instrument,
        economic_date="2026-09-23",
        kind="official_nav",
        value="1.8",
    )
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(instrument.pk),
            "request_token": "pending-token",
            "refresh_status": "pending",
        },
    )
    pre = preview(book, "instruments", instrument.pk)
    assert pre["can_delete"], pre
    result = api(book, "delete", f"instruments/{instrument.pk}", command(pre))
    assert result.status_code == 200, result.content
    assert not api(book, "get", "instruments").json()["items"]
    assert not quote_list(book.space)["items"]
    assert (
        refresh_one(str(book.space.pk), str(instrument.pk), "pending-token")["status"]
        == "not_found"
    )
    assert Price.objects.count() == 1
    assert (
        api(
            book,
            "post",
            f"instruments/{instrument.pk}/restore",
            command(preview(book, "instruments", instrument.pk)),
        ).status_code
        == 200
    )
    assert len(api(book, "get", "instruments").json()["items"]) == 1
    assert Price.objects.count() == 1


@pytest.mark.parametrize(
    "method,path", [("delete", ""), ("post", "/restore"), ("post", "/opening-date")]
)
def test_viewer_cannot_modify_catalog_or_dates(book, method, path):
    Membership.objects.filter(user=book.user, workspace=book.space).update(
        role="viewer"
    )
    response = api(book, method, f"accounts/{book.account.pk}{path}", {})
    assert response.status_code == 403
    assert Decimal(overview(book.space)["net_assets"]) == 1000


def test_stale_revision_does_not_delete_or_change_balance(book):
    body = command(preview(book))
    body["expected_revision"] -= 1
    response = api(book, "delete", f"accounts/{book.account.pk}", body)
    assert response.status_code == 412, response.content
    assert Decimal(overview(book.space)["net_assets"]) == 1000


def test_internal_tombstones_not_writable_as_generic_resources(book):
    response = api(
        book,
        "post",
        "catalog_deletions",
        {
            "data": {
                "target_kind": "accounts",
                "target_id": str(book.account.pk),
                "status": "deleted",
            }
        },
    )
    assert response.status_code == 404, response.content
    assert preview(book)["can_delete"]


def test_cross_space_preflight_does_not_expose_account(book):
    other = Workspace.objects.create(name="另一空间")
    Membership.objects.create(workspace=other, user=book.user, role="owner")
    result = book.client.get(
        f"/api/v1/spaces/{other.pk}/accounts/{book.account.pk}/deletion"
    )
    assert result.status_code == 404


def test_deleted_explicit_performance_filter_does_not_create_false_loss(book):
    assert (
        api(
            book, "delete", f"accounts/{book.account.pk}", command(preview(book))
        ).status_code
        == 200
    )
    report = performance(
        book.space, "2026-09-18", "2026-09-25", account_ids=[book.account.pk]
    )
    assert Decimal(report["net_profit"]) == 0
