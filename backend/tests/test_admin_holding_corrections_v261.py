"""Admin holding corrections reallocate money atomically without widening user APIs."""

from decimal import Decimal as D
import json
from types import SimpleNamespace
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from wealth import models as m
from wealth.common import DomainError, tenant_context
from wealth.holding_corrections import correct_holding
from wealth.investments import record_holding
from wealth.ledger import balance, post_event
from wealth.reporting import overview, positions

pytestmark = pytest.mark.django_db
DATE = "2026-09-24"


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    admin = get_user_model().objects.create_superuser("holding-admin-v261")
    owner = get_user_model().objects.create_user("holding-owner-v261")
    space = m.Workspace.objects.create(name="管理员完整更正合成账簿")
    m.Membership.objects.create(workspace=space, user=owner, role="owner")
    clients = {}
    for name, user in (("admin", admin), ("owner", owner)):
        clients[name] = Client()
        clients[name].force_login(user)
    with tenant_context(space.pk):
        account = m.Account.objects.create(tenant=space, name="原基金账户", kind="fund")
        bank = m.Account.objects.create(tenant=space, name="原补资银行", kind="bank")
        instrument = m.Instrument.objects.create(
            tenant=space, name="合成存量基金", code="ADMIN-HOLDING", kind="fund"
        )
        yield SimpleNamespace(
            space=space,
            admin=admin,
            owner=owner,
            clients=clients,
            account=account,
            bank=bank,
            instrument=instrument,
        )


def cash(book, account, amount):
    return post_event(
        book.space,
        book.owner,
        {
            "kind": "opening",
            "account_id": str(account.pk),
            "amount": amount,
            "economic_date": "2026-09-01",
        },
    )


def holding(book, **extra):
    return record_holding(
        book.space,
        book.owner,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(book.instrument.pk),
            "as_of": DATE,
            "purchase_date": "2026-09-02",
            "quantity": "10",
            "cost": "90",
            "current_value": "100",
            "valuation_basis": "formal",
            "valuation_date": DATE,
            "funding_mode": "allocate",
            **extra,
        },
    )


def good(response):
    assert response.status_code == 200, response.content.decode()
    return response.json()


def metadata(book, event_id):
    return good(
        book.clients["admin"].get(
            f"/api/v1/spaces/{book.space.pk}/administration/events/{event_id}"
        )
    )["item"]


def revise(book, item, values, client="admin"):
    book.space.refresh_from_db()
    return book.clients[client].patch(
        f"/api/v1/spaces/{book.space.pk}/administration/events/{item['id']}",
        data=json.dumps(
            {
                "values": values,
                "version": item["version"],
                "expected_revision": book.space.revision,
                "reason": "按机构资料完整更正持仓",
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )


def test_admin_event_metadata_exposes_full_correction_values(book):
    cash(book, book.account, "1000")
    original = holding(book)
    item = metadata(book, original["event"]["id"])
    assert item["holding_correction"]["eligible"] is True
    assert item["values"] == item["holding_correction"]["initial_values"]
    assert item["values"]["account_id"] == str(book.account.pk)
    assert item["values"]["instrument_id"] == str(book.instrument.pk)
    assert item["values"]["as_of"] == DATE
    assert D(item["values"]["quantity"]) == 10
    assert D(item["values"]["cost"]) == 90
    assert D(item["values"]["current_value"]) == 100
    assert item["values"]["funding_mode"] == "allocate"


def test_admin_can_correct_quantity_cost_value_and_date_with_reallocation(book):
    cash(book, book.account, "1000")
    original = holding(book)
    assert balance(book.space, book.account, "cash") == D("900")
    item = metadata(book, original["event"]["id"])
    result = good(
        revise(
            book,
            item,
            {
                **item["values"],
                "quantity": "20",
                "cost": "180",
                "current_value": "200",
                "as_of": "2026-09-25",
                "valuation_date": "2026-09-25",
                "purchase_date": "2026-09-03",
            },
        )
    )["item"]
    assert result["id"] != original["event"]["id"]
    assert balance(book.space, book.account, "cash") == D("800")
    rows = positions(book.space, "2026-09-25")
    assert len(rows) == 1
    assert D(rows[0]["quantity"]) == 20
    assert D(rows[0]["cost"]) == 180
    assert D(rows[0]["market_value"]) == 200
    assert D(overview(book.space, "2026-09-25")["net_assets"]) == 1000
    old = m.Event.objects.get(pk=original["event"]["id"])
    assert old.payload["quantity"] == "10"
    assert old.payload["opening_market_value"] == "100"
    assert m.Event.objects.filter(reverses=old, created_by=book.admin).exists()
    replacement = m.Event.objects.get(pk=result["id"])
    assert replacement.economic_date.isoformat() == "2026-09-25"
    assert replacement.created_by_id == book.admin.pk
    assert m.Audit.objects.filter(
        action="holding.corrected", created_by=book.admin, object_id=str(old.pk)
    ).exists()
    assert m.Audit.objects.filter(
        action="administration.events.save",
        created_by=book.admin,
        object_id=result["id"],
    ).exists()


def test_admin_changes_account_and_funding_source_without_double_debit(book):
    other = m.Account.objects.create(tenant=book.space, name="新基金账户", kind="fund")
    source = m.Account.objects.create(tenant=book.space, name="新补资银行", kind="bank")
    for account, amount in (
        (book.account, "20"),
        (book.bank, "200"),
        (other, "30"),
        (source, "300"),
    ):
        cash(book, account, amount)
    original = holding(book, funding_account_id=str(book.bank.pk))
    old_transfer = m.Event.objects.get(pk=original["funding"]["transfer_event_id"])
    assert balance(book.space, book.bank, "cash") == D("120")
    item = metadata(book, original["event"]["id"])
    result = good(
        revise(
            book,
            item,
            {
                **item["values"],
                "account_id": str(other.pk),
                "funding_account_id": str(source.pk),
                "quantity": "15",
                "cost": "140",
                "current_value": "150",
            },
        )
    )["item"]
    assert balance(book.space, book.account, "cash") == D("20")
    assert balance(book.space, book.bank, "cash") == D("200")
    assert balance(book.space, other, "cash") == 0
    assert balance(book.space, source, "cash") == D("180")
    assert m.Event.objects.filter(reverses=old_transfer, created_by=book.admin).exists()
    replacement = m.Event.objects.get(pk=result["id"])
    assert replacement.payload["account_id"] == str(other.pk)
    assert replacement.payload["funding_account_id"] == str(source.pk)
    assert replacement.related_id != old_transfer.pk
    assert D(replacement.related.payload["amount"]) == 120
    assert replacement.related.payload["target_account_id"] == str(other.pk)
    assert replacement.related.payload["account_id"] == str(source.pk)
    rows = positions(book.space, DATE)
    assert len(rows) == 1 and rows[0]["account_id"] == str(other.pk)
    assert D(rows[0]["market_value"]) == 150
    assert D(overview(book.space, DATE)["net_assets"]) == 550


def test_failed_admin_funding_change_rolls_back_original_and_reversal(book):
    cash(book, book.account, "20")
    cash(book, book.bank, "200")
    insufficient = m.Account.objects.create(
        tenant=book.space, name="不足的补资账户", kind="bank"
    )
    cash(book, insufficient, "1")
    original = holding(book, funding_account_id=str(book.bank.pk))
    item = metadata(book, original["event"]["id"])
    before = m.Event.objects.count()
    response = revise(
        book,
        item,
        {
            **item["values"],
            "current_value": "300",
            "funding_account_id": str(insufficient.pk),
        },
    )
    assert response.status_code == 422
    assert m.Event.objects.count() == before
    assert not m.Event.objects.filter(reverses_id=original["event"]["id"]).exists()
    assert not m.Event.objects.filter(
        reverses_id=original["funding"]["transfer_event_id"]
    ).exists()
    assert balance(book.space, book.bank, "cash") == D("120")
    assert balance(book.space, insufficient, "cash") == 1
    assert D(positions(book.space, DATE)[0]["market_value"]) == 100


@pytest.mark.parametrize(
    "change",
    [
        {"current_value": "200"},
        {"as_of": "2026-09-25"},
        {"funding_mode": "external"},
    ],
)
def test_ordinary_correction_api_keeps_original_money_and_date_limits(book, change):
    cash(book, book.account, "1000")
    original = holding(book)
    item = metadata(book, original["event"]["id"])
    book.space.refresh_from_db()
    before = m.Event.objects.count()
    response = book.clients["owner"].post(
        f"/api/v1/spaces/{book.space.pk}/holdings/{item['id']}/correct",
        data=json.dumps(
            {
                **item["values"],
                **change,
                "expected_revision": book.space.revision,
                "reason": "普通入口不扩大范围",
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 422
    assert response.json()["code"] == "holding_correction_locked"
    assert m.Event.objects.count() == before
    assert balance(book.space, book.account, "cash") == 900


def test_owner_cannot_gain_admin_correction_through_route_or_internal_flag(book):
    cash(book, book.account, "1000")
    original = holding(book)
    item = metadata(book, original["event"]["id"])
    values = {**item["values"], "current_value": "200"}
    assert revise(book, item, values, client="owner").status_code == 403
    book.space.refresh_from_db()
    with pytest.raises(DomainError) as caught:
        correct_holding(
            book.space,
            book.owner,
            item["id"],
            {
                **values,
                "expected_revision": book.space.revision,
                "reason": "普通用户不能调用管理员模式",
            },
            administrative=True,
        )
    assert caught.value.status == 403
    assert not m.Event.objects.filter(reverses_id=item["id"]).exists()
