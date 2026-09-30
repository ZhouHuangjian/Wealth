import json
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from wealth.common import DomainError
from wealth.glossary import read_glossary, validate_overrides, write_glossary
from wealth.platform_models import PlatformAudit, PlatformSetting

pytestmark = pytest.mark.django_db


def entry(term="留存资金", **kwargs):
    return dict(
        term=term,
        category="机构资金",
        explanation="机构内尚未分配到具体产品的资金。",
        aliases=["机构闲置现金"],
        **kwargs,
    )


def test_glossary_override_reset_and_optimistic_version():
    admin = get_user_model().objects.create_superuser("v25-glossary-admin")
    assert read_glossary() == {"version": 0, "overrides": []}
    result = write_glossary(
        admin, {"version": 0, "overrides": [entry(), {"term": "旧词", "hidden": True}]}
    )
    assert result["version"] == 1 and result["overrides"][1] == {
        "term": "旧词",
        "hidden": True,
    }
    with pytest.raises(DomainError) as error:
        write_glossary(admin, {"version": 0, "overrides": []})
    assert error.value.status == 412
    assert len(read_glossary()["overrides"]) == 2
    assert write_glossary(admin, {"version": 1, "overrides": []}) == {
        "version": 2,
        "overrides": [],
    }
    assert (
        PlatformAudit.objects.filter(action="glossary.updated", actor=admin).count()
        == 2
    )


@pytest.mark.parametrize(
    "overrides",
    [
        None,
        {},
        [entry()] * 501,
        [entry(), entry()],
        [entry(), {**entry("另一个词"), "aliases": ["留存资金"]}],
        [{"term": "x", "hidden": "true"}],
        [{"term": "x", "hidden": False}],
        [{**entry(), "explanation": ""}],
        [{**entry(), "explanation": "x" * 4001}],
        [{**entry(), "aliases": ["a", "Ａ"]}],
        [{**entry(), "unexpected": "field"}],
    ],
)
def test_invalid_glossary_payloads(overrides):
    with pytest.raises(DomainError):
        validate_overrides(overrides)


def test_glossary_routes_require_login_admin_and_idempotency():
    admin = get_user_model().objects.create_superuser("v25-glossary-route-admin")
    user = get_user_model().objects.create_user("v25-glossary-reader")
    anonymous, reader, editor = Client(), Client(), Client()
    reader.force_login(user)
    editor.force_login(admin)
    assert anonymous.get("/api/v1/glossary").status_code == 401
    assert reader.get("/api/v1/glossary").json() == {"version": 0, "overrides": []}
    assert reader.get("/api/v1/admin/glossary").status_code == 403
    body = json.dumps({"version": 0, "overrides": [entry()]})
    key = str(uuid.uuid4())
    assert (
        reader.put(
            "/api/v1/admin/glossary",
            body,
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=key,
        ).status_code
        == 403
    )
    assert (
        editor.put(
            "/api/v1/admin/glossary", body, content_type="application/json"
        ).status_code
        == 400
    )
    first = editor.put(
        "/api/v1/admin/glossary",
        body,
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    assert first.status_code == 200, first.content
    repeated = editor.put(
        "/api/v1/admin/glossary",
        body,
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    assert repeated.json() == first.json()
    assert PlatformSetting.objects.get(pk="glossary").version == 1
    assert reader.get("/api/v1/glossary").json()["overrides"][0]["term"] == "留存资金"


def test_ordinary_user_cannot_write_even_without_route_wrapper():
    user = get_user_model().objects.create_user("v25-glossary-non-admin")
    with pytest.raises(DomainError) as error:
        write_glossary(user, {"version": 0, "overrides": [entry()]})
    assert error.value.status == 403
    assert not PlatformSetting.objects.filter(pk="glossary").exists()


def test_hiding_a_configured_term_preserves_its_explanation_for_restore():
    admin = get_user_model().objects.create_superuser("v25-glossary-hide-admin")
    hidden = {**entry(), "hidden": True}
    saved = write_glossary(admin, {"version": 0, "overrides": [hidden]})
    assert saved["overrides"][0]["explanation"] == hidden["explanation"]
    restored = {**saved["overrides"][0], "hidden": False}
    shown = write_glossary(admin, {"version": 1, "overrides": [restored]})
    assert shown["overrides"][0]["explanation"] == hidden["explanation"]
    assert not shown["overrides"][0].get("hidden")
