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
