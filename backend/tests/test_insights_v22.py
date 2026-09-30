"""Threshold alerts observe prices, remain tenant-scoped and never create trades."""

import json
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from django.utils import timezone

from wealth import insights, models as m
from wealth.common import tenant_context
from wealth.ledger import post_event

pytestmark = pytest.mark.django_db


@pytest.fixture
def book(settings):
    settings.WEALTH_MARKET_DATA_ENABLED = False
    user = get_user_model().objects.create_user(
        "signals-owner", password="Synthetic-password-22"
    )
    viewer = get_user_model().objects.create_user(
        "signals-viewer", password="Synthetic-password-22"
    )
    space = m.Workspace.objects.create(name="观察测试")
    m.Membership.objects.create(workspace=space, user=user, role="owner")
    m.Membership.objects.create(workspace=space, user=viewer, role="viewer")
    with tenant_context(space.pk):
        inst = m.Instrument.objects.create(
            tenant=space, name="合成指数", kind="index", code="SYN", currency="USD"
        )
        fund = m.Instrument.objects.create(
            tenant=space, name="合成基金", kind="fund", code="111111", currency="CNY"
        )
        for p in [inst, fund]:
            m.Price.objects.bulk_create(
                [
                    m.Price(
                        tenant=space,
                        instrument=p,
                        value="100",
                        kind="close",
                        economic_date=timezone.localdate() - timedelta(days=d),
                        source="synthetic-history",
                    )
                    for d in range(1, 40)
                ]
            )
            set_quote(space, p, "90")
    client = Client()
    client.force_login(user)
    return SimpleNamespace(
        space=space,
        user=user,
        viewer=viewer,
        inst=inst,
        fund=fund,
        client=client,
        base=f"/api/v1/spaces/{space.pk}",
    )


def set_quote(space, inst, value, when=None, fetched=None):
    state = m.Resource.objects.filter(
        tenant=space, kind="market_quotes", data__instrument_id=str(inst.pk)
    ).first()
    data = {
        "instrument_id": str(inst.pk),
        "refresh_status": "ready",
        "fetched_at": (fetched or timezone.now()).isoformat(),
        "quote": {
            "status": "ok",
            "kind": "market",
            "price": value,
            "currency": inst.currency,
            "economic_date": str(when or timezone.localdate()),
            "source": "synthetic-quote",
            "change_percent": "-10",
        },
    }
    if state:
        state.data = data
        state.save()
    else:
        state = m.Resource.objects.create(tenant=space, kind="market_quotes", data=data)
    return state


def send(book, route, body, method="post", key=None):
    return getattr(book.client, method)(
        book.base + route,
        json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid4()),
    )


def condition(inst, **changes):
    return {
        "scope": "instrument",
        "instrument_id": str(inst.pk),
        "metric": "drawdown",
        "baseline": "rolling_high",
        "lookback_days": 30,
        "operator": "gte",
        "threshold": "10",
        **changes,
    }


def rule(book, **changes):
    response = send(
        book,
        "/signal-rules",
        {
            "name": "回撤10%",
            "enabled": True,
            "match": "all",
            "cooldown_hours": 24,
            "conditions": [condition(book.inst)],
            **changes,
        },
    )
    assert response.status_code == 200, response.content
    return response.json()


def test_tag_overlap_primary_allocation_targets_and_versions(book):
    a = send(
        book,
        "/investment-tags",
        {
            "name": "黄金",
            "target_weight": "60",
            "instrument_ids": [str(book.fund.pk)],
            "primary_instrument_ids": [str(book.fund.pk)],
        },
    ).json()
    assert a["primary_instrument_ids"] == [str(book.fund.pk)]
    assert (
        send(
            book, "/investment-tags", {"name": "超额", "target_weight": "50"}
        ).status_code
        == 422
    )
    b = send(
        book,
        "/investment-tags",
        {
            "name": "红利低波",
            "target_weight": "40",
            "instrument_ids": [str(book.fund.pk)],
        },
    ).json()
    with tenant_context(book.space.pk):
        book.fund.refresh_from_db()
        assert book.fund.specification["allocation_tag_id"] == a["id"]
    result = send(
        book,
        "/investment-tags/" + b["id"],
        {"version": b["version"], "primary_instrument_ids": [str(book.fund.pk)]},
        "patch",
    )
    assert result.status_code == 200, result.content
    tags = book.client.get(book.base + "/investment-tags").json()["items"]
    assert sum(len(t["primary_instrument_ids"]) for t in tags) == 1
    assert all(t["instrument_ids"] == [str(book.fund.pk)] for t in tags)
    assert (
        send(
            book,
            "/investment-tags/" + b["id"],
            {"version": b["version"], "name": "old write"},
            "patch",
        ).status_code
        == 412
    )


def test_cross_space_ids_viewer_writes_and_public_paths_are_protected(book):
    other = m.Workspace.objects.create(name="其他空间")
    with tenant_context(other.pk):
        foreign = m.Instrument.objects.create(
            tenant=other, name="外部产品", code="foreign"
        )
        tag = m.Resource.objects.create(
            tenant=other, kind="investment_tags", data={"name": "私有标签"}
        )
    assert (
        send(
            book,
            "/investment-tags",
            {"name": "越权", "instrument_ids": [str(foreign.pk)]},
        ).status_code
        == 404
    )
    assert (
        send(book, "/market-watchlist", {"instrument_id": str(foreign.pk)}).status_code
        == 404
    )
    assert (
        send(
            book,
            "/signal-rules",
            {
                "name": "越权",
                "conditions": [
                    {"scope": "tag", "tag_id": str(tag.pk), "threshold": "10"}
                ],
            },
        ).status_code
        == 404
    )
    with tenant_context(book.space.pk):
        book.fund.refresh_from_db()
        version = book.fund.version
    assert (
        send(
            book,
            "/instruments/" + str(book.fund.pk),
            {"version": version, "specification": {"allocation_tag_id": str(tag.pk)}},
            "patch",
        ).status_code
        == 404
    )
    book.client.force_login(book.viewer)
    assert send(book, "/signal-rules", {"name": "禁止"}).status_code == 403
    assert send(book, "/signals/evaluate", {}).status_code == 403
    assert book.client.get(book.base + "/signals").status_code == 200
    book.client.logout()
    for route in [
        "signals",
        "investment-tags",
        "market-watchlist",
        "dashboard-preferences",
        "portfolio-analysis",
        "net-worth-comparison",
    ]:
        assert book.client.get(book.base + "/" + route).status_code == 401


def test_threshold_crossing_is_latched_and_never_posts_money(book, monkeypatch):
    r = rule(book, cooldown_hours=0)
    first = send(book, "/signals/evaluate", {}).json()["items"][0]
    assert first["status"] == "triggered" and first["trigger_count"] == 1
    second = send(book, "/signals/evaluate", {}).json()["items"][0]
    assert second["trigger_count"] == 1
    assert send(book, f"/signals/{r['id']}/ack", {}).status_code == 200
    assert book.client.get(book.base + "/signals").json()["unread_count"] == 0
    with tenant_context(book.space.pk):
        set_quote(book.space, book.inst, "95")
    assert (
        send(book, "/signals/evaluate", {}).json()["items"][0]["status"]
        == "not_triggered"
    )
    with tenant_context(book.space.pk):
        set_quote(book.space, book.inst, "80")
    final = send(book, "/signals/evaluate", {}).json()["items"][0]
    assert final["trigger_count"] == 2
    assert final["conditions"][0]["value"] == "20.0"
    with tenant_context(book.space.pk):
        assert not m.Event.objects.filter(tenant=book.space).exists()
        assert not m.PositionMovement.objects.filter(tenant=book.space).exists()


def test_ten_and_twenty_percent_rules_trigger_independently(book):
    rule(book, name="10%")
    rule(book, name="20%", conditions=[condition(book.inst, threshold="20")])
    states = send(book, "/signals/evaluate", {}).json()["items"]
    assert {s["name"]: s["status"] for s in states} == {
        "10%": "triggered",
        "20%": "not_triggered",
    }
    with tenant_context(book.space.pk):
        set_quote(book.space, book.inst, "75")
    states = send(book, "/signals/evaluate", {}).json()["items"]
    assert all(s["trigger_count"] == 1 for s in states)


def test_combined_conditions_require_same_valid_date_and_fresh_values(book):
    r = rule(
        book,
        name="VIX与回撤",
        conditions=[
            condition(book.inst),
            condition(book.fund, metric="price", operator="gte", threshold="25"),
        ],
    )
    with tenant_context(book.space.pk):
        set_quote(
            book.space, book.fund, "30", when=timezone.localdate() - timedelta(days=1)
        )
    state = send(book, "/signals/evaluate", {}).json()["items"][0]
    assert state["status"] == "unavailable" and state["trigger_count"] == 0
    with tenant_context(book.space.pk):
        set_quote(book.space, book.fund, "30")
    state = send(book, "/signals/evaluate", {}).json()["items"][0]
    assert state["status"] == "triggered" and state["trigger_count"] == 1
    with tenant_context(book.space.pk):
        set_quote(
            book.space, book.inst, "80", fetched=timezone.now() - timedelta(hours=1)
        )
    state = send(book, "/signals/evaluate", {}).json()["items"][0]
    assert state["status"] == "unavailable" and state["trigger_count"] == 1
    # Source outage does not re-arm an already triggered threshold.
    with tenant_context(book.space.pk):
        set_quote(book.space, book.inst, "80")
    assert send(book, "/signals/evaluate", {}).json()["items"][0]["trigger_count"] == 1


def test_corporate_action_and_insufficient_history_never_invent_drawdown(book):
    rule(book, conditions=[condition(book.fund)])
    with tenant_context(book.space.pk):
        state = m.Resource.objects.get(
            tenant=book.space,
            kind="market_quotes",
            data__instrument_id=str(book.fund.pk),
        )
        state.data["corporate_actions"] = [
            {
                "date": str(timezone.localdate() - timedelta(days=2)),
                "description": "分红",
            }
        ]
        state.save()
    assert (
        send(book, "/signals/evaluate", {}).json()["items"][0]["status"]
        == "unavailable"
    )
    rule(book, name="更长历史", conditions=[condition(book.inst, lookback_days=365)])
    results = send(book, "/signals/evaluate", {}).json()["items"]
    assert all(
        r["status"] == "unavailable" and r["trigger_count"] == 0 for r in results
    )


def test_watch_index_creation_preferences_and_idempotent_retries(book):
    body = {
        "product": {
            "name": "波动率指数",
            "code": "VIX",
            "kind": "index",
            "market": "US",
            "currency": "USD",
            "specification": {"quote_unit": "点", "account_ids": ["private"]},
        },
        "show_on_home": False,
        "lookback_days": 365,
    }
    one = send(book, "/market-watchlist", body, key="watch-once")
    assert one.status_code == 200, one.content
    assert (
        send(book, "/market-watchlist", body, key="watch-once").json()["id"]
        == one.json()["id"]
    )
    items = book.client.get(book.base + "/market-watchlist").json()["items"]
    assert (
        len(items) == 1
        and items[0]["metric_status"] == "unavailable"
        and not items[0]["show_on_home"]
    )
    prefs = send(
        book, "/dashboard-preferences", {"show_market_environment": False}
    ).json()
    assert not prefs["show_market_environment"] and prefs["show_valuation"]
    assert (
        send(
            book,
            "/dashboard-preferences",
            {"version": prefs["version"], "show_market_environment": True},
        ).status_code
        == 200
    )
    with tenant_context(book.space.pk):
        inst = m.Instrument.objects.get(pk=one.json()["instrument_id"])
        assert "account_ids" not in inst.specification
        account = m.Account.objects.create(
            tenant=book.space, name="证券", kind="broker", currency="USD"
        )
    assert (
        send(
            book,
            "/holdings",
            {
                "instrument_id": str(inst.pk),
                "account_id": str(account.pk),
                "quantity": "1",
                "cost": "10",
                "purchase_date": str(timezone.localdate()),
            },
        ).status_code
        == 422
    )


def test_dca_list_is_scoped_to_holding_without_hiding_other_plans(book):
    with tenant_context(book.space.pk):
        a = m.Account.objects.create(tenant=book.space, name="基金", kind="fund")
        b = m.Account.objects.create(tenant=book.space, name="银行")
        for account in [a, b]:
            m.Resource.objects.create(
                tenant=book.space,
                kind="plans",
                data={
                    "kind": "dca",
                    "name": "定投",
                    "instrument_id": str(book.fund.pk),
                    "account_id": str(account.pk),
                },
            )
    response = book.client.get(
        book.base + "/plans",
        {"kind": "dca", "instrument_id": str(book.fund.pk), "account_id": str(a.pk)},
    )
    assert response.status_code == 200
    assert response.json()["count"] == 1
    assert book.client.get(book.base + "/plans").json()["count"] == 2


def test_stale_quote_never_becomes_a_drawdown_percentage(book):
    with tenant_context(book.space.pk):
        set_quote(
            book.space, book.inst, "30500", fetched=timezone.now() - timedelta(hours=2)
        )
        m.Resource.objects.create(
            tenant=book.space,
            kind="market_watchlist",
            data={
                "instrument_id": str(book.inst.pk),
                "lookback_days": 30,
                "enabled": True,
                "show_on_home": True,
            },
        )
        metric = insights.instrument_metric(book.space, book.inst.pk, lookback_days=30)
        assert metric["status"] == "unavailable" and metric["value"] is None
    response = book.client.get(book.base + "/market-watchlist")
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["drawdown_percent"] is None
    assert item["quote"]["price"] == "30500"


def holding(book, instrument, quantity="1", cost="100"):
    account = m.Account.objects.create(
        tenant=book.space,
        name="提醒验收持仓",
        kind="fund",
        currency=instrument.currency,
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(account.pk),
            "instrument_id": str(instrument.pk),
            "quantity": quantity,
            "cost": cost,
            "economic_date": str(timezone.localdate() - timedelta(days=40)),
        },
    )
    return account


@pytest.mark.parametrize("origin", ["provider", "dividend", "reinvest", "split"])
def test_daily_change_fallback_never_alerts_on_unadjusted_corporate_action(
    book, origin
):
    with tenant_context(book.space.pk):
        account = holding(book, book.fund)
        quote = set_quote(book.space, book.fund, "50")
        quote.data["quote"]["change_percent"] = None
        if origin == "provider":
            quote.data["corporate_actions"] = [
                {"date": str(timezone.localdate()), "description": "1 拆 2"}
            ]
        else:
            post_event(
                book.space,
                book.user,
                {
                    "kind": origin,
                    "account_id": str(account.pk),
                    "instrument_id": str(book.fund.pk),
                    "economic_date": str(timezone.localdate()),
                    **(
                        {"amount": "10"}
                        if origin == "dividend"
                        else {"quantity": "1", "price": "50"}
                        if origin == "reinvest"
                        else {"ratio": "2"}
                    ),
                },
            )
        quote.save()
        before = m.Event.objects.filter(tenant=book.space).count()
    rule(
        book,
        conditions=[
            condition(
                book.fund, metric="change_percent", operator="lte", threshold="-10"
            )
        ],
    )
    result = send(book, "/signals/evaluate", {}).json()["items"][0]
    assert result["status"] == "unavailable" and result["trigger_count"] == 0
    assert result["conditions"][0]["value"] is None
    assert "分红、再投或折算" in result["conditions"][0]["message"]
    with tenant_context(book.space.pk):
        assert m.Event.objects.filter(tenant=book.space).count() == before


@pytest.mark.parametrize("gap_days, expected", [(3, "-10.0"), (8, None)])
def test_daily_change_fallback_allows_weekend_gap_but_not_old_unrelated_price(
    book, gap_days, expected
):
    with tenant_context(book.space.pk):
        instrument = m.Instrument.objects.create(
            tenant=book.space,
            name="稀疏正式行情",
            kind="fund",
            code="GAP",
            currency="CNY",
        )
        m.Price.objects.create(
            tenant=book.space,
            instrument=instrument,
            value="100",
            kind="official_nav",
            economic_date=timezone.localdate() - timedelta(days=gap_days),
            source="synthetic",
        )
        quote = set_quote(book.space, instrument, "90")
        quote.data["quote"]["change_percent"] = None
        quote.save()
        result = insights.instrument_metric(
            book.space, instrument.pk, metric="change_percent"
        )
    if expected is None:
        assert result["status"] == "unavailable" and result["value"] is None
        assert "相隔超过 4 天" in result["message"]
    else:
        assert result["status"] == "ok" and result["value"] == Decimal(expected)


def test_daily_change_uses_the_selected_estimate_source_and_date(book):
    with tenant_context(book.space.pk):
        quote = set_quote(
            book.space, book.fund, "90", when=timezone.localdate() - timedelta(days=1)
        )
        quote.data["quote"]["estimate"] = {
            "price": "110",
            "change_percent": "10",
            "status": "ok",
            "economic_date": str(timezone.localdate()),
            "source": "synthetic-current-estimate",
        }
        quote.save()
        result = insights.instrument_metric(
            book.space, book.fund.pk, metric="change_percent"
        )
    assert result["value"] == Decimal("10")
    assert result["as_of"] == str(timezone.localdate())
    assert result["source"] == "synthetic-current-estimate"


@pytest.mark.parametrize("mixed_observation", ["price", "fx"])
def test_tag_and_rule_cannot_hide_mixed_observation_dates_behind_minimum_date(
    book, mixed_observation
):
    today = timezone.localdate()
    yesterday = today - timedelta(days=1)
    with tenant_context(book.space.pk):
        tag = m.Resource.objects.create(
            tenant=book.space,
            kind="investment_tags",
            data={"name": "混合有效日期标签", "instrument_ids": [str(book.fund.pk)]},
        )
        holding(book, book.fund)
        instrument = m.Instrument.objects.create(
            tenant=book.space,
            name="另一标签成分",
            code="MIXED-DATE",
            kind="fund",
            currency="USD" if mixed_observation == "fx" else "CNY",
            specification={"allocation_tag_id": str(tag.pk)},
        )
        holding(book, instrument)
        m.Price.objects.bulk_create(
            [
                m.Price(
                    tenant=book.space,
                    instrument=instrument,
                    value="100",
                    kind="official_nav",
                    economic_date=today - timedelta(days=offset),
                    source="synthetic",
                )
                for offset in range(1 if mixed_observation == "fx" else 0, 40)
            ]
        )
        if mixed_observation == "fx":
            m.FxRate.objects.bulk_create(
                [
                    m.FxRate(
                        tenant=book.space,
                        base="USD",
                        quote="CNY",
                        rate="7",
                        purpose="valuation",
                        economic_date=today - timedelta(days=offset),
                        source="synthetic",
                    )
                    for offset in range(40)
                ]
            )
        set_quote(book.space, book.inst, "90", when=yesterday)
    rule(
        book,
        conditions=[
            {
                "scope": "tag",
                "tag_id": str(tag.pk),
                "metric": "price",
                "operator": "gte",
                "threshold": "1",
            },
            condition(book.inst, metric="price", operator="gte", threshold="1"),
        ],
    )
    result = send(book, "/signals/evaluate", {}).json()["items"][0]
    assert all(row["matched"] is True for row in result["conditions"])
    assert {row["as_of"] for row in result["conditions"]} == {str(yesterday)}
    assert set(result["conditions"][0]["effective_dates"]) == {
        str(yesterday),
        str(today),
    }
    assert result["status"] == "unavailable" and result["trigger_count"] == 0
    assert "不同有效日期" in result["message"]


def test_tag_cost_drawdown_uses_the_same_deduplicated_basket_as_its_current_value(book):
    with tenant_context(book.space.pk):
        tag = m.Resource.objects.create(
            tenant=book.space,
            kind="investment_tags",
            data={"name": "相同成分篮子", "instrument_ids": [str(book.fund.pk)]},
        )
        book.fund.specification = {
            "allocation_tag_id": str(tag.pk),
            "tag_ids": [str(tag.pk)],
        }
        book.fund.save()
        holding(book, book.fund)
        other = m.Instrument.objects.create(
            tenant=book.space,
            name="仅观察标签关联",
            kind="fund",
            code="TAG-ONLY",
            currency="CNY",
            specification={"tag_ids": [str(tag.pk)]},
        )
        holding(book, other)
        m.Price.objects.bulk_create(
            [
                m.Price(
                    tenant=book.space,
                    instrument=other,
                    value="100",
                    kind="official_nav",
                    economic_date=timezone.localdate() - timedelta(days=offset),
                    source="synthetic",
                )
                for offset in range(1, 40)
            ]
        )
        result = insights._tag_metric(book.space, tag.pk, "drawdown", baseline="cost")
    assert result["status"] == "ok"
    assert result["baseline_price"] == result["current_price"] == Decimal("200")
    assert result["value"] == 0
    assert len(result["quantity_basis"]) == 2
