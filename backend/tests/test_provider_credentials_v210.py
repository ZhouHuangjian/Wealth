"""Platform token storage uses only synthetic secrets and isolated database state."""

import json
import uuid
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from wealth import provider_credentials as credentials
from wealth.platform_models import PlatformAudit, PlatformCommand, PlatformSetting

pytestmark = pytest.mark.django_db
TOKEN = "synthetic-provider-token-210-only"
PROVIDER = "tushare_fund"
ROUTE = f"/api/v1/admin/data-sources/{PROVIDER}/credential"


@pytest.fixture
def actors(settings):
    settings.SECRET_KEY = "synthetic-application-secret-v210-isolation"
    settings.SECRET_KEY_FALLBACKS = []
    User = get_user_model()
    admin = User.objects.create_superuser("credential-platform-admin")
    user = User.objects.create_user("credential-ordinary-user")
    ac, uc = Client(), Client()
    ac.force_login(admin)
    uc.force_login(user)
    return SimpleNamespace(admin=admin, user=user, ac=ac, uc=uc)


def send(client, body, *, route=ROUTE, method="put", key=None):
    return getattr(client, method)(
        route,
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
    )


def test_ciphertext_only_storage_and_no_api_audit_or_command_echo(actors):
    result = send(actors.ac, {"version": 0, "token": TOKEN})
    assert result.status_code == 200, result.content
    assert result.json() == {
        "provider": PROVIDER,
        "credential": {
            "required": True,
            "configured": True,
            "version": 1,
            "status": "configured",
        },
    }
    row = PlatformSetting.objects.get(pk=credentials.PREFIX + PROVIDER)
    assert set(row.data) == {
        "ciphertext",
        "schema_version",
    } and TOKEN not in json.dumps(row.data)
    assert credentials.get_provider_credentials(PROVIDER) == {"token": TOKEN}
    directory = actors.ac.get("/api/v1/admin/data-sources")
    assert directory.status_code == 200
    assert (
        TOKEN not in directory.content.decode()
        and row.data["ciphertext"] not in directory.content.decode()
    )
    assert TOKEN not in str(list(PlatformAudit.objects.values()))
    assert TOKEN not in str(list(PlatformCommand.objects.values()))
    assert row.data["ciphertext"] not in str(list(PlatformCommand.objects.values()))
    audit = PlatformAudit.objects.get(action="data_source.credential.updated")
    assert audit.detail == {"version": 1} and audit.actor_id == actors.admin.pk


@pytest.mark.parametrize("method", ["put", "delete"])
def test_ordinary_and_anonymous_cannot_write_or_read_credentials(actors, method):
    for client, status in [(actors.uc, 403), (Client(), 401)]:
        response = send(
            client,
            {"version": 0, "token": TOKEN} if method == "put" else {"version": 0},
            method=method,
        )
        assert response.status_code == status
        assert client.get("/api/v1/admin/data-sources").status_code == status
    assert not PlatformSetting.objects.filter(pk=credentials.PREFIX + PROVIDER).exists()
    assert not PlatformAudit.objects.filter(
        action__startswith="data_source.credential"
    ).exists()


def test_disabled_admin_cannot_replay_successful_secret_command(actors):
    body = {"version": 0, "token": TOKEN}
    assert send(actors.ac, body, key="credential-once").status_code == 200
    actors.admin.is_active = False
    actors.admin.save(update_fields=["is_active"])
    assert send(actors.ac, body, key="credential-once").status_code in {401, 403}
    assert PlatformSetting.objects.get(pk=credentials.PREFIX + PROVIDER).version == 1


def test_optimistic_version_idempotency_and_rotation(actors):
    body = {"version": 0, "token": TOKEN}
    first = send(actors.ac, body, key="credential-once")
    second = send(actors.ac, body, key="credential-once")
    assert first.json() == second.json()
    assert (
        PlatformAudit.objects.filter(action="data_source.credential.updated").count()
        == 1
    )
    assert send(actors.ac, body).status_code == 412
    assert (
        send(
            actors.ac, {**body, "token": TOKEN + "different"}, key="credential-once"
        ).status_code
        == 409
    )
    assert send(actors.ac, {"token": TOKEN}).status_code == 428
    assert send(actors.ac, {"version": True, "token": TOKEN}).status_code == 412
    assert send(actors.ac, {"version": 1, "token": TOKEN + "new"}).status_code == 200
    assert credentials.get_provider_credentials(PROVIDER) == {"token": TOKEN + "new"}
    assert PlatformSetting.objects.get(pk=credentials.PREFIX + PROVIDER).version == 2


def test_secret_deletion_is_versioned_and_not_plaintext_backup(actors):
    assert send(actors.ac, {"version": 0, "token": TOKEN}).status_code == 200
    assert send(actors.ac, {"version": 0}, method="delete").status_code == 412
    response = send(actors.ac, {"version": 1}, method="delete")
    assert (
        response.status_code == 200
        and response.json()["credential"]["status"] == "unconfigured"
    )
    row = PlatformSetting.objects.get(pk=credentials.PREFIX + PROVIDER)
    assert row.version == 2 and row.data == {}
    assert credentials.get_provider_credentials(PROVIDER) is None
    assert TOKEN not in str(list(PlatformCommand.objects.values()))


@pytest.mark.parametrize(
    "token", [None, False, 123, "short", "space token", "newline\ntoken", "x" * 4097]
)
def test_invalid_secret_is_not_persisted(actors, token):
    assert send(actors.ac, {"version": 0, "token": token}).status_code == 422
    assert not PlatformSetting.objects.filter(pk=credentials.PREFIX + PROVIDER).exists()
    assert PlatformCommand.objects.count() == 0


def test_no_custom_endpoints_ciphertext_or_public_source_credentials(actors):
    assert (
        send(
            actors.ac, {"version": 0, "token": TOKEN, "url": "https://attacker.test"}
        ).status_code
        == 422
    )
    assert send(actors.ac, {"version": 0, "ciphertext": "fake"}).status_code == 422
    assert (
        send(
            actors.ac,
            {"version": 0, "token": TOKEN},
            route="/api/v1/admin/data-sources/gffunds_official/credential",
        ).status_code
        == 422
    )
    assert not PlatformSetting.objects.filter(
        key__startswith=credentials.PREFIX
    ).exists()


def test_encrypted_tokens_are_bound_to_provider_and_corruption_fails_closed(actors):
    assert send(actors.ac, {"version": 0, "token": TOKEN}).status_code == 200
    stored = PlatformSetting.objects.get(pk=credentials.PREFIX + PROVIDER)
    copied = PlatformSetting.objects.create(
        key=credentials.PREFIX + "lixinger_fund", data=stored.data, version=1
    )
    assert credentials.get_provider_credentials("lixinger_fund") is None
    assert credentials.credential_status("lixinger_fund")["status"] == "unreadable"
    copied.data = {"ciphertext": "corrupt-value"}
    copied.save(update_fields=["data"])
    assert credentials.get_provider_credentials("lixinger_fund") is None
    directory = actors.ac.get("/api/v1/admin/data-sources")
    assert directory.status_code == 200 and TOKEN not in directory.content.decode()


def test_application_key_rotation_reads_old_key_only_with_explicit_fallback(
    actors, settings
):
    assert send(actors.ac, {"version": 0, "token": TOKEN}).status_code == 200
    original = settings.SECRET_KEY
    settings.SECRET_KEY = "synthetic-new-application-secret-v210"
    assert credentials.get_provider_credentials(PROVIDER) is None
    settings.SECRET_KEY_FALLBACKS = [original]
    assert credentials.get_provider_credentials(PROVIDER) == {"token": TOKEN}
    settings.SECRET_KEY_FALLBACKS = []
    assert credentials.credential_status(PROVIDER)["status"] == "unreadable"


def test_credential_write_route_has_no_secret_get_endpoint(actors):
    assert send(actors.ac, {"version": 0, "token": TOKEN}).status_code == 200
    response = actors.ac.get(ROUTE)
    assert response.status_code == 404 and TOKEN not in response.content.decode()
