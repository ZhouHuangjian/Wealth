from urllib.parse import urlsplit

import pytest
from django.conf import settings


@pytest.fixture(scope="session")
def django_db_setup():
    """Use an explicitly migrated isolated DB, never the developer's live ledger."""
    name = settings.DATABASES["default"]["NAME"]
    if not (name.endswith("_test") or name.startswith("test_")):
        raise RuntimeError(
            "Tests require an isolated wealth_test database. Run scripts/local_backend.py test migrate first."
        )


@pytest.fixture(autouse=True)
def private_test_files(tmp_path, settings):
    settings.PRIVATE_MEDIA_ROOT = tmp_path / "private"


@pytest.fixture(autouse=True)
def no_live_akshare(monkeypatch):
    """Provider fallback tests must never invoke a live SDK/network worker."""
    from wealth import akshare_provider, market_data

    def unavailable(*args, **kwargs):
        raise market_data.MarketDataError(
            "provider_unavailable", "测试中不请求实时行情"
        )

    akshare_provider._CACHE.clear()
    monkeypatch.setattr(akshare_provider, "_invoke", unavailable)


@pytest.fixture(autouse=True)
def no_live_sina_fund(monkeypatch):
    """Default fallback must not depend on today's public fund responses.

    Dedicated adapter scenarios override _get with their deterministic samples;
    the existing security/response-limit tests retain their captured real helper.
    """
    from wealth import market_data

    original = market_data._get

    def offline(url, **kwargs):
        if urlsplit(url).hostname == "stock.finance.sina.com.cn":
            raise market_data.MarketDataError(
                "provider_unavailable", "测试中不请求新浪实时基金参考行情"
            )
        return original(url, **kwargs)

    monkeypatch.setattr(market_data, "_get", offline)
