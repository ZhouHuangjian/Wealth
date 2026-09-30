"""Distribution discovery must never manufacture cash or historical entitlement."""

from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import RequestFactory
from django.utils import timezone

from wealth import dividends
from wealth.common import DomainError, tenant_context
from wealth.investments import record_holding
from wealth.ledger import balance, position, post_event, reverse_event
from wealth.market_data import MarketDataError
from wealth.models import Account, Event, Instrument, Membership, Resource, Workspace
from wealth.provider_policy import default_provider_config


HTML = """<html><title>华夏成长混合(000001)基金分红送配</title><table><tr>
<th>年份</th><th>权益登记日</th><th>除息日</th><th>每10份分红</th><th>分红发放日</th>
</tr><tr><td>2025年</td><td>2025-09-22</td><td>2025-09-22</td>
<td>每10份派现金0.1000元</td><td>2025-09-23</td></tr></table></html>"""


def notice():
    return dividends.parse_fund_distributions(HTML, "000001")[0]


def test_provider_rate_is_per_ten_and_cash_only():
    result = notice()
    assert result["amount_per_10"] == "0.1000"
    assert result["record_date"] == "2025-09-22"
    assert result["payment_date"] == "2025-09-23"
    assert result["source_verified"] is False
    assert "fundf10.eastmoney.com/fhsp_000001.html" in result["source_url"]


@pytest.mark.parametrize(
    "original,replacement",
    [
        ("(000001)", "(000002)"),
        ("权益登记日", "登记日"),
        ("每10份派现金0.1000元", "每份派现金0.1000元"),
        ("每10份派现金0.1000元", "每10份派现金NaN元"),
        ("每10份派现金0.1000元", "每份折算为2份"),
        ("2025-09-23", "2025-09-01"),
        ("2025-09-23", "9999-12-31"),
    ],
)
def test_provider_identity_units_and_dates_fail_closed(original, replacement):
    with pytest.raises(MarketDataError):
        dividends.parse_fund_distributions(
            HTML.replace(original, replacement), "000001"
        )


def test_provider_empty_table_is_distinct_from_bad_response():
    start = HTML.index("<tr><td>2025年")
    blank = HTML[:start] + "<tr><td colspan='5'>暂无分红信息!</td></tr></table>"
    assert dividends.parse_fund_distributions(blank, "000001") == []
    with pytest.raises(MarketDataError):
        dividends.parse_fund_distributions("<title>基金(000001)</title>", "000001")


def test_disabling_provider_prevents_network(monkeypatch):
    config = default_provider_config()
    config["enabled"]["eastmoney_fund"] = False
    monkeypatch.setattr(
        dividends, "_get", lambda *_: pytest.fail("disabled provider network")
    )
    with pytest.raises(MarketDataError, match="停用"):
        dividends.fetch_fund_distributions(
            {"kind": "fund", "market": "CN", "code": "000001", "currency": "CNY"},
            config,
        )


@pytest.fixture
def book(db, monkeypatch):
    user = get_user_model().objects.create_user(
        username="dividend-owner", password="synthetic-dividends-only"
    )
    space = Workspace.objects.create(name="分红测试")
    Membership.objects.create(workspace=space, user=user, role="owner")
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: True)
    with tenant_context(space.pk):
        account = Account.objects.create(
            tenant=space, created_by=user, name="基金账户", kind="fund"
        )
        inst = Instrument.objects.create(
            tenant=space, created_by=user, name="华夏成长", code="000001", kind="fund"
        )
        yield SimpleNamespace(user=user, space=space, account=account, inst=inst)


def opening(book, **overrides):
    return post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.inst.pk),
            "economic_date": "2025-08-01",
            "amount": "0",
            "quantity": "100",
            "cost": "100",
            **overrides,
        },
    )


def pending(book):
    data = {
        **notice(),
        "instrument_id": str(book.inst.pk),
        "identity": dividends._identity(book.inst),
    }
    dividends._match_notice(book.space, book.inst, data, book.user)
    return Resource.objects.get(tenant=book.space, kind=dividends.CANDIDATES)


def confirm(book, candidate, **overrides):
    return dividends.confirm_dividend(
        book.space,
        book.user,
        candidate.pk,
        {
            "version": candidate.version,
            "actual_confirmed": True,
            "mode": "cash",
            "economic_date": "2025-09-23",
            "amount": "1",
            **overrides,
        },
    )


def enable(book):
    return dividends.save_preferences(
        book.space, book.user, {"enabled": True, "version": 0}
    )


def test_default_off_and_optimistic_preferences(book):
    assert dividends.preferences(book.space)["enabled"] is False
    assert enable(book)["enabled"] is True
    with pytest.raises(DomainError, match="已改变"):
        dividends.save_preferences(
            book.space, book.user, {"enabled": False, "version": 0}
        )


def test_discovery_estimates_record_date_shares_without_posting_money(book):
    opening(book)
    candidate = pending(book)
    row = dividends.candidate_record(book.space, candidate)
    assert row["status"] == "pending"
    assert Decimal(row["estimated_amount"]) == Decimal("1")
    assert row["record_quantity"] == "100.000000000000000000"
    assert row["entitlement_confirmed"] is False
    assert Event.objects.filter(tenant=book.space).count() == 1
    assert balance(book.space, book.account, "cash") == 0
    assert pending(book).pk == candidate.pk
    assert (
        Resource.objects.filter(tenant=book.space, kind=dividends.CANDIDATES).count()
        == 1
    )


def test_later_snapshot_does_not_backfill_entitlement_even_if_unchanged(book):
    record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(book.inst.pk),
            "quantity": "100",
            "cost": "100",
            "purchase_date": "2025-08-01",
            "as_of": "2025-10-01",
            "history_mode": "unchanged_holding",
        },
    )
    candidate = pending(book)
    row = dividends.candidate_record(book.space, candidate)
    assert row["record_quantity"] is None
    assert row["estimated_amount"] is None
    assert row["entitlement_status"] == "quantity_unknown"


def test_no_candidate_for_shares_bought_after_record_date(book):
    opening(book, economic_date="2025-10-01")
    assert (
        dividends._match_notice(
            book.space,
            book.inst,
            {**notice(), "identity": dividends._identity(book.inst)},
        )
        == 0
    )


def test_actual_cash_overrides_estimate_and_duplicate_confirm_is_blocked(book):
    opening(book)
    candidate = pending(book)
    result = confirm(book, candidate, amount="2", fee="0.1", tax="0.2")
    assert balance(book.space, book.account, "cash") == Decimal("1.7")
    assert result["event"]["kind"] == "dividend"
    assert result["candidate"]["status"] == "confirmed"
    with pytest.raises(DomainError, match="已确认"):
        confirm(book, candidate, amount="2")
    assert Event.objects.filter(tenant=book.space, kind="dividend").count() == 1


def test_reinvest_adds_actual_shares_without_cash_dividend(book):
    opening(book)
    candidate = pending(book)
    result = confirm(
        book, candidate, mode="reinvest", quantity="0.5", price="2", amount="1"
    )
    assert result["event"]["kind"] == "reinvest"
    assert position(book.space, book.account, book.inst)[0] == Decimal("100.5")
    assert balance(book.space, book.account, "cash") == 0


def test_reinvest_keeps_existing_historical_dependency_guard(book):
    opening(book)
    candidate = pending(book)
    post_event(
        book.space,
        book.user,
        {
            "kind": "buy",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.inst.pk),
            "economic_date": "2025-10-01",
            "quantity": "1",
            "price": "1",
        },
    )
    with pytest.raises(DomainError, match="更晚的持仓"):
        confirm(book, candidate, mode="reinvest", quantity="1", price="1")
    assert Event.objects.filter(tenant=book.space, kind="reinvest").count() == 0


def test_manual_dividend_is_linked_instead_of_duplicate_cash(book):
    opening(book)
    candidate = pending(book)
    event = post_event(
        book.space,
        book.user,
        {
            "kind": "dividend",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.inst.pk),
            "economic_date": "2025-09-23",
            "amount": "1",
        },
    )
    with pytest.raises(DomainError, match="可能已记入"):
        confirm(book, candidate)
    result = confirm(book, candidate, event_id=str(event.pk))
    assert result["event"]["id"] == str(event.pk)
    assert balance(book.space, book.account, "cash") == Decimal("1")
    assert Event.objects.filter(tenant=book.space, kind="dividend").count() == 1


def test_reversal_reopens_review_and_reconfirmation_uses_new_stage(book):
    opening(book)
    candidate = pending(book)
    first = confirm(book, candidate)
    event = Event.objects.get(pk=first["event"]["id"])
    reverse_event(book.space, book.user, event, "机构金额更正")
    candidate.refresh_from_db()
    assert dividends.candidate_record(book.space, candidate)["status"] == "reversed"
    result = confirm(book, candidate, amount="2")
    assert result["event"]["id"] != str(event.pk)
    assert balance(book.space, book.account, "cash") == Decimal("2")


@pytest.mark.parametrize(
    "values",
    [
        {"actual_confirmed": False},
        {"amount": None},
        {"economic_date": "2025-09-01"},
        {"economic_date": "2099-01-01"},
        {"version": 100},
    ],
)
def test_invalid_confirmation_never_creates_fact(book, values):
    opening(book)
    candidate = pending(book)
    with pytest.raises(DomainError):
        confirm(book, candidate, **values)
    assert Event.objects.filter(tenant=book.space, kind="dividend").count() == 0


def test_foreign_space_candidate_and_event_are_inaccessible(book):
    opening(book)
    candidate = pending(book)
    other = Workspace.objects.create(name="另一空间")
    with tenant_context(other.pk):
        with pytest.raises(DomainError, match="不属于"):
            dividends.confirm_dividend(
                other, book.user, candidate.pk, {"actual_confirmed": True, "version": 1}
            )


def test_readonly_role_cannot_confirm(book):
    request = RequestFactory().post("/")
    request.user = book.user
    with pytest.raises(DomainError, match="只读"):
        dividends.dispatch_dividends(
            request, book.space, book.user, ["dividends", "refresh"], {}, "viewer"
        )


def test_provider_correction_updates_same_candidate_and_invalidates_stale_version(book):
    opening(book)
    candidate = pending(book)
    modified = {
        **notice(),
        "amount_per_10": "0.2",
        "identity": dividends._identity(book.inst),
        "instrument_id": str(book.inst.pk),
    }
    dividends._match_notice(book.space, book.inst, modified)
    assert (
        Resource.objects.filter(tenant=book.space, kind=dividends.CANDIDATES).count()
        == 1
    )
    with pytest.raises(DomainError, match="已改变"):
        confirm(book, candidate)


def test_refresh_http_outside_worker_transaction_preserves_facts_and_cache(
    book, monkeypatch
):
    opening(book)
    enable(book)
    calls = []

    def fetch(identity, config):
        assert connection.in_atomic_block is False
        calls.append(identity["code"])
        return [notice()]

    monkeypatch.setattr(dividends, "fetch_fund_distributions", fetch)
    result = dividends.refresh_space_dividends(book.space.pk)
    assert result["refreshed"] == 1
    assert result["candidates_added"] == 1
    assert calls == ["000001"]
    assert Event.objects.filter(tenant=book.space).count() == 1
    assert dividends.refresh_space_dividends(book.space.pk)["refreshed"] == 0
    assert calls == ["000001"]
    state = Resource.objects.get(tenant=book.space, kind=dividends.REFRESH)
    state.data["last_attempt_at"] = (timezone.now() - timedelta(days=2)).isoformat()
    state.save(update_fields=["data"])
    monkeypatch.setattr(
        dividends,
        "fetch_fund_distributions",
        lambda *_: (_ for _ in ()).throw(
            MarketDataError("provider_unavailable", "测试不可用")
        ),
    )
    assert dividends.refresh_space_dividends(book.space.pk)["failed"] == 1
    assert (
        Resource.objects.filter(tenant=book.space, kind=dividends.NOTICES).count() == 1
    )
    assert (
        Resource.objects.filter(tenant=book.space, kind=dividends.CANDIDATES).count()
        == 1
    )


def test_twenty_first_fund_is_processed_in_following_batch(book, monkeypatch):
    enable(book)
    Instrument.objects.bulk_create(
        [
            Instrument(
                tenant=book.space, name=f"测试基金{i}", code=f"{i:06}", kind="fund"
            )
            for i in range(2, 22)
        ]
    )
    calls = []

    def fetch(identity, config):
        calls.append(identity["code"])
        return []

    monkeypatch.setattr(dividends, "fetch_fund_distributions", fetch)
    first = dividends.refresh_space_dividends(book.space.pk)
    second = dividends.refresh_space_dividends(book.space.pk)
    assert first["has_more"] is True and first["refreshed"] == 20
    assert second["has_more"] is False and second["refreshed"] == 1
    assert len(set(calls)) == 21


def test_background_default_off_does_not_call_provider(book, monkeypatch):
    monkeypatch.setattr(
        dividends, "fetch_fund_distributions", lambda *_: pytest.fail("optin required")
    )
    assert dividends.refresh_space_dividends(book.space.pk)["status"] == "disabled"


def test_runtime_source_disable_does_not_access_network(book, monkeypatch):
    enable(book)
    config = default_provider_config()
    config["enabled"]["eastmoney_fund"] = False
    monkeypatch.setattr(dividends, "get_provider_config", lambda: config)
    monkeypatch.setattr(
        dividends,
        "fetch_fund_distributions",
        lambda *_: pytest.fail("provider disabled"),
    )
    assert (
        dividends.refresh_space_dividends(book.space.pk)["status"]
        == "provider_disabled"
    )


def test_periodic_inline_uses_cache_and_never_depends_on_broker(book, monkeypatch):
    enable(book)
    monkeypatch.setattr(dividends, "fetch_fund_distributions", lambda *_: [])
    monkeypatch.setattr(
        dividends, "_enqueue", lambda *_: pytest.fail("inline must not use broker")
    )
    assert dividends.refresh_due_dividends(inline=True)["queued"] == 1
    assert dividends.refresh_due_dividends(inline=True)["queued"] == 0


def test_deleted_space_is_not_scheduled_or_refreshed(book, monkeypatch):
    enable(book)
    book.space.deleted_at = timezone.now()
    book.space.save(update_fields=["deleted_at"])
    monkeypatch.setattr(
        dividends,
        "fetch_fund_distributions",
        lambda *_: pytest.fail("deleted space network"),
    )
    assert dividends.refresh_space_dividends(book.space.pk)["status"] == "not_found"
    assert dividends.refresh_due_dividends(inline=True)["queued"] == 0


def test_confirm_is_idempotent_at_dispatch_boundary(book):
    opening(book)
    candidate = pending(book)
    request = RequestFactory().post(
        "/", HTTP_IDEMPOTENCY_KEY="dividend-confirm-same-key"
    )
    request.user = book.user
    body = {
        "version": candidate.version,
        "actual_confirmed": True,
        "mode": "cash",
        "economic_date": "2025-09-23",
        "amount": "1",
    }
    path = ["dividends", str(candidate.pk), "confirm"]
    first = dividends.dispatch_dividends(
        request, book.space, book.user, path, body, "owner"
    )
    second = dividends.dispatch_dividends(
        request, book.space, book.user, path, body, "owner"
    )
    assert first == second
    assert Event.objects.filter(tenant=book.space, kind="dividend").count() == 1
    with pytest.raises(DomainError, match="同一幂等键"):
        dividends.dispatch_dividends(
            request, book.space, book.user, path, {**body, "amount": "2"}, "owner"
        )


def test_imported_cash_dividend_without_product_links_without_mutating_fact(book):
    opening(book)
    candidate = pending(book)
    event = post_event(
        book.space,
        book.user,
        {
            "kind": "dividend",
            "account_id": str(book.account.pk),
            "economic_date": "2025-09-23",
            "amount": "1",
            "description": "账单导入的现金分红",
        },
    )
    payload = dict(event.payload)
    assert (
        dividends.candidate_record(book.space, candidate)["matching_events"][0][
            "product_match"
        ]
        == "unassigned_product"
    )
    with pytest.raises(DomainError, match="可能已记入"):
        confirm(book, candidate)
    result = confirm(book, candidate, event_id=str(event.pk))
    event.refresh_from_db()
    assert event.payload == payload
    assert result["event"]["id"] == str(event.pk)
    assert balance(book.space, book.account, "cash") == Decimal("1")


def test_api_confirm_and_listing_use_the_same_candidate_and_idempotency(book):
    import json
    from django.test import Client

    opening(book)
    candidate = pending(book)
    client = Client()
    client.force_login(book.user)
    base = f"/api/v1/spaces/{book.space.pk}/dividends"
    listing = client.get(base)
    assert listing.status_code == 200, listing.content
    assert listing.json()["items"][0]["id"] == str(candidate.pk)
    payload = {
        "version": candidate.version,
        "actual_confirmed": True,
        "mode": "cash",
        "economic_date": "2025-09-23",
        "amount": "1",
    }
    for _ in range(2):
        response = client.post(
            base + f"/{candidate.pk}/confirm",
            data=json.dumps(payload),
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="same-dividend-api-key",
        )
        assert response.status_code == 200, response.content
    assert Event.objects.filter(tenant=book.space, kind="dividend").count() == 1


def test_api_refresh_only_queues_and_never_fetches_during_request(book, monkeypatch):
    import json
    from django.test import Client

    monkeypatch.setattr(
        dividends,
        "fetch_fund_distributions",
        lambda *_: pytest.fail("HTTP during request lock"),
    )
    client = Client()
    client.force_login(book.user)
    response = client.post(
        f"/api/v1/spaces/{book.space.pk}/dividends/refresh",
        data=json.dumps({}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="enqueue-dividend-api-key",
    )
    assert response.status_code == 200, response.content
    assert response.json()["status"] == "queued"


def test_api_viewer_and_foreign_user_cannot_confirm(book):
    import json
    from django.test import Client

    opening(book)
    candidate = pending(book)
    viewer = get_user_model().objects.create_user(username="dividend-viewer")
    Membership.objects.create(workspace=book.space, user=viewer, role="viewer")
    client = Client()
    client.force_login(viewer)
    base = f"/api/v1/spaces/{book.space.pk}/dividends"
    assert client.get(base).status_code == 200
    response = client.post(
        base + f"/{candidate.pk}/confirm",
        data=json.dumps({"actual_confirmed": True}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="no-viewer-dividend",
    )
    assert response.status_code == 403
    unrelated = get_user_model().objects.create_user(username="dividend-unrelated")
    client.force_login(unrelated)
    assert client.get(base).status_code == 404


def test_manual_batch_continues_past_twenty_with_automation_off(book, monkeypatch):
    Resource.objects.create(
        tenant=book.space,
        kind=dividends.SETTINGS,
        data={
            "enabled": False,
            "refresh_requested": True,
            "refresh_request_token": "manual-batch",
        },
    )
    Instrument.objects.bulk_create(
        [
            Instrument(
                tenant=book.space, name=f"手工检查{i}", code=f"{i:06}", kind="fund"
            )
            for i in range(2, 22)
        ]
    )
    monkeypatch.setattr(dividends, "fetch_fund_distributions", lambda *_: [])
    assert dividends.refresh_space_dividends(book.space.pk)["has_more"] is True
    assert (
        Resource.objects.get(tenant=book.space, kind=dividends.SETTINGS).data[
            "refresh_requested"
        ]
        is True
    )
    assert dividends.refresh_space_dividends(book.space.pk)["refreshed"] == 1
    assert (
        Resource.objects.get(tenant=book.space, kind=dividends.SETTINGS).data[
            "refresh_requested"
        ]
        is False
    )


def test_inflight_manual_lease_keeps_durable_request_until_worker_finishes(
    book, monkeypatch
):
    Resource.objects.create(
        tenant=book.space,
        kind=dividends.SETTINGS,
        data={
            "enabled": False,
            "refresh_requested": True,
            "refresh_request_token": "inflight-request",
        },
    )
    Resource.objects.create(
        tenant=book.space,
        kind=dividends.REFRESH,
        data={
            "instrument_id": str(book.inst.pk),
            "status": "fetching",
            "token": "another-worker",
            "last_attempt_at": timezone.now().isoformat(),
        },
    )
    monkeypatch.setattr(
        dividends,
        "fetch_fund_distributions",
        lambda *_: pytest.fail("must honor active lease"),
    )
    assert dividends.refresh_space_dividends(book.space.pk)["refreshed"] == 0
    assert (
        Resource.objects.get(tenant=book.space, kind=dividends.SETTINGS).data[
            "refresh_requested"
        ]
        is True
    )


def test_linked_import_attribution_reaches_calendar_without_duplicate_income(book):
    from wealth.investments import profit_calendar
    from wealth.models import Price

    opening(book)
    candidate = pending(book)
    for when in ["2025-09-22", "2025-09-23"]:
        Price.objects.create(
            tenant=book.space,
            instrument=book.inst,
            value="1",
            kind="official_nav",
            economic_date=when,
            source="test",
        )
    event = post_event(
        book.space,
        book.user,
        {
            "kind": "dividend",
            "account_id": str(book.account.pk),
            "economic_date": "2025-09-23",
            "amount": "1",
        },
    )
    before = profit_calendar(book.space, "2025-09-23", "2025-09-23")
    assert Decimal(before["days"][0]["amount"]) == 0
    confirm(book, candidate, event_id=str(event.pk))
    after = profit_calendar(book.space, "2025-09-23", "2025-09-23")
    assert Decimal(after["days"][0]["amount"]) == Decimal("1")
    assert Decimal(after["days"][0]["items"][0]["dividends"]) == Decimal("1")
    event.refresh_from_db()
    assert not event.payload.get("instrument_id")
    reverse_event(book.space, book.user, event, "冲正原始导入分红")
    reversed_report = profit_calendar(book.space, "2025-09-23", "2025-09-23")
    assert Decimal(reversed_report["days"][0]["amount"]) == 0


def test_one_import_event_cannot_be_linked_to_two_funds(book):
    opening(book)
    candidate = pending(book)
    event = post_event(
        book.space,
        book.user,
        {
            "kind": "dividend",
            "account_id": str(book.account.pk),
            "economic_date": "2025-09-23",
            "amount": "1",
        },
    )
    other = Instrument.objects.create(
        tenant=book.space, name="第二基金", code="000002", kind="fund"
    )
    other_candidate = Resource.objects.create(
        tenant=book.space,
        kind=dividends.CANDIDATES,
        data={
            **candidate.data,
            "instrument_id": str(other.pk),
            "identity": dividends._identity(other),
            "candidate_key": "other-fund",
        },
    )
    confirm(book, candidate, event_id=str(event.pk))
    with pytest.raises(DomainError):
        confirm(book, other_candidate, event_id=str(event.pk))
    assert balance(book.space, book.account, "cash") == Decimal("1")
