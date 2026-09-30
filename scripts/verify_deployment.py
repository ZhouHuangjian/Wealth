#!/usr/bin/env python3
"""Read-only HTTPS smoke checks; credentials are read from a private local file."""

import argparse
import http.cookiejar
import json
import re
import ssl
from datetime import date, timedelta
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, HTTPSHandler, Request, build_opener


def verify(url, credential_file):
    url = url.rstrip("/")
    if urlsplit(url).scheme != "https":
        raise ValueError("Deployment verification requires trusted HTTPS")
    path = Path(credential_file)
    if path.stat().st_mode & 0o077:
        raise ValueError("Credential file must have mode 0600")
    credentials = json.loads(path.read_text())
    cookies = http.cookiejar.CookieJar()
    client = build_opener(
        HTTPSHandler(context=ssl.create_default_context()),
        HTTPCookieProcessor(cookies),
    )

    def request(route, payload=None, csrf=None):
        headers = {"Accept": "application/json", "Origin": url, "Referer": url + "/"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            if csrf:
                headers["X-CSRFToken"] = csrf
            data = json.dumps(payload).encode()
        with client.open(
            Request(url + route, data=data, headers=headers), timeout=20
        ) as response:
            body = response.read()
            if "application/json" in response.headers.get("Content-Type", ""):
                body = json.loads(body)
            return body, response.headers

    checks = {}
    html, headers = request("/")
    checks["https_verified"] = True
    assert headers["X-Frame-Options"] == "DENY"
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert "max-age=" in headers["Strict-Transport-Security"]
    checks["security_headers"] = True
    assets = re.findall(rb'<(?:script|link)[^>]+(?:src|href)="(/assets/[^\"]+)"', html)
    assert assets
    for asset in assets:
        content, _ = request(asset.decode())
        assert len(content) > 0
    checks["frontend_assets"] = len(assets)
    health, _ = request("/api/v1/health")
    assert health["status"] == "ok" and health["mode"] != "development"
    checks["production_health"] = True
    checks["version"] = health.get("version")
    auth, _ = request("/api/v1/auth/me")
    assert auth["user"] is None and auth["setup_required"] is False
    checks["public_setup_closed"] = True
    auth, _ = request(
        "/api/v1/auth/login",
        {"username": credentials["username"], "password": credentials["password"]},
        csrf=auth["csrf_token"],
    )
    assert auth["user"] and auth["spaces"]
    assert any(cookie.name == "sessionid" and cookie.secure for cookie in cookies)
    checks["csrf_login_and_secure_session"] = True
    if str(health.get("version", "")).startswith(("2.3", "2.4")):
        assert auth["user"].get("is_platform_admin") is True
        for endpoint in ("users", "spaces", "audit"):
            result, _ = request(f"/api/v1/admin/{endpoint}")
            assert isinstance(result.get("items"), list)
            checks[f"admin/{endpoint}"] = True
        sources, _ = request("/api/v1/admin/data-sources")
        assert sources.get("providers") and isinstance(sources.get("config"), dict)
        checks["admin/data-sources"] = True
        navigation, _ = request("/api/v1/me/navigation-preferences")
        assert isinstance(navigation.get("groups"), dict)
        checks["navigation_preferences"] = True
    if str(health.get("version", "")).startswith("2.4"):
        for endpoint in (
            "configuration-templates",
            "spaces/trash",
            "admin/configuration-templates",
        ):
            result, _ = request(f"/api/v1/{endpoint}")
            assert isinstance(result.get("items"), list)
            checks[endpoint] = True
    sid = auth["spaces"][0]["id"]
    assert auth["spaces"][0]["role"] == "owner"
    overview, _ = request(f"/api/v1/spaces/{sid}/overview")
    checks["real_overview"] = "net_assets" in overview
    if str(health.get("version", "")).startswith("2.4"):
        assert overview["calculation_version"] == "account-equity-v24"
        data, _ = request(f"/api/v1/spaces/{sid}/dividends")
        assert (
            isinstance(data.get("items"), list)
            and data["settings"]["mode"] == "review_before_posting"
        )
        checks["dividends_review_workflow"] = True
    for endpoint in ("accounts", "events", "jobs"):
        data, _ = request(f"/api/v1/spaces/{sid}/{endpoint}")
        assert "items" in data
        checks[endpoint] = len(data["items"])
    for endpoint in (
        "holdings",
        "market/quotes",
        "market/valuation",
        "investment-tags",
        "market-watchlist",
        "signal-rules",
        "signals",
    ):
        data, _ = request(f"/api/v1/spaces/{sid}/{endpoint}")
        assert isinstance(data.get("items"), list)
        checks[endpoint] = True
    comparison, _ = request(f"/api/v1/spaces/{sid}/net-worth-comparison")
    assert "previous" in comparison and "estimated" in comparison
    checks["net_worth_comparison"] = True
    allocation, _ = request(f"/api/v1/spaces/{sid}/portfolio-analysis")
    assert isinstance(allocation.get("groups"), list)
    checks["portfolio_analysis"] = True
    preferences, _ = request(f"/api/v1/spaces/{sid}/dashboard-preferences")
    assert isinstance(preferences.get("show_market_environment"), bool)
    checks["dashboard_preferences"] = True
    catalog, _ = request(
        f"/api/v1/spaces/{sid}/market/search?kind=index&market=US&q=NDX&remote=0"
    )
    assert any(item["code"] == "NDX" for item in catalog["items"])
    assert catalog["source"] == "local"
    checks["local_product_catalog"] = True
    if str(health.get("version", "")).startswith(("2.3", "2.4")):
        browse, _ = request(f"/api/v1/spaces/{sid}/market/catalog?kind=index&limit=50")
        assert len(browse.get("items", [])) >= 10
        checks["cached_market_candidates"] = True
        resolved, _ = request(
            f"/api/v1/spaces/{sid}/market/resolve?code=m2701-P-3300&kind=option"
        )
        assert resolved.get("exchange") == "DCE"
        checks["automatic_exchange"] = True
        dates, _ = request(
            f"/api/v1/spaces/{sid}/market/trade-dates?code=110022&kind=fund&application_at=2026-09-24T15%3A01%3A00%2B08%3A00"
        )
        assert (
            dates["trade_date"] == "2026-09-28"
            and dates["expected_confirmation_date"] == "2026-09-29"
        )
        assert dates["creates_ledger_event"] is False
        checks["trading_day_preview"] = True
    end = date.today()
    start = end - timedelta(days=30)
    calendar, _ = request(
        f"/api/v1/spaces/{sid}/profit-calendar?start={start}&end={end}"
    )
    assert isinstance(calendar.get("days"), list)
    checks["profit_calendar"] = True
    request("/api/v1/auth/logout", {}, csrf=auth["csrf_token"])
    state, _ = request("/api/v1/auth/me")
    assert state["user"] is None
    try:
        request(f"/api/v1/spaces/{sid}/overview")
    except HTTPError as error:
        assert error.code == 401
    else:
        raise AssertionError("Unauthenticated financial data access was permitted")
    checks["logout_and_unauthenticated_denial"] = True
    return checks


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--credentials-file", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = verify(args.url, args.credentials_file)
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).write_text(encoded)
    print(encoded, end="")
