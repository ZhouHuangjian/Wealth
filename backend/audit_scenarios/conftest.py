"""Explicit audit scenarios must use a pre-migrated synthetic runtime database."""

import pytest
from django.conf import settings


@pytest.fixture(scope="session")
def django_db_setup():
    name = settings.DATABASES["default"]["NAME"]
    if not (name.endswith("_test") or name.startswith("test_")):
        raise RuntimeError("Audit scenarios require an isolated test database")


@pytest.fixture(autouse=True)
def private_files_and_no_network(tmp_path, settings, monkeypatch):
    settings.PRIVATE_MEDIA_ROOT = tmp_path / "private"
    from wealth import akshare_provider, market_data

    def unavailable(*args, **kwargs):
        raise market_data.MarketDataError(
            "provider_unavailable", "Audit has no live network"
        )

    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    monkeypatch.setattr(market_data, "_get", unavailable)
    monkeypatch.setattr(market_data, "_post", unavailable)
    monkeypatch.setattr(akshare_provider, "_invoke", unavailable)
