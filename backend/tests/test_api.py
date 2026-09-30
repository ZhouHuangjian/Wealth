import io
import json
import uuid
import zipfile
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client
from wealth import models as m
from wealth.common import tenant_context

pytestmark = pytest.mark.django_db


@pytest.fixture
def app():
    owner = get_user_model().objects.create_user(
        "api-owner", password="Example-strong-test-only-5839"
    )
    editor = get_user_model().objects.create_user(
        "api-editor", password="Example-strong-test-only-5839"
    )
    viewer = get_user_model().objects.create_user(
        "api-viewer", password="Example-strong-test-only-5839"
    )
    space = m.Workspace.objects.create(name="API合成验收")
    for u, r in [(owner, "owner"), (editor, "editor"), (viewer, "viewer")]:
        m.Membership.objects.create(workspace=space, user=u, role=r)
    client = Client()
    client.force_login(owner)
    base = f"/api/v1/spaces/{space.pk}"
    with tenant_context(space.pk):
        account = m.Account.objects.create(tenant=space, name="银行", currency="CNY")
    return SimpleNamespace(
        owner=owner,
        editor=editor,
        viewer=viewer,
        space=space,
        client=client,
        base=base,
        account=account,
    )


def send(app, path, body, method="post", key=None):
    return getattr(app.client, method)(
        app.base + path,
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
    )


def test_snapshot_option_scope_requires_explicit_boolean_confirmation(app):
    payload = {
        "account_id": str(app.account.pk),
        "economic_date": "2026-01-01",
        "currency": "CNY",
        "equity": "10000",
        "coverage": "期货客户权益，已核实无期权持仓",
        "coverage_confirmed": True,
        "includes_options": False,
        "no_option_positions": True,
    }
    response = send(app, "/snapshots", payload)
    assert response.status_code == 200, response.content
    assert response.json()["details"]["no_option_positions"] is True
    for field in ("coverage_confirmed", "includes_options", "no_option_positions"):
        invalid = send(app, "/snapshots", {**payload, field: "false"})
        assert invalid.status_code == 422, invalid.content
    conflict = send(app, "/snapshots", {**payload, "includes_options": True})
    assert conflict.status_code == 422, conflict.content


def expense(app, amount="20", **extra):
    return {
        "kind": "expense",
        "amount": amount,
        "account_id": str(app.account.pk),
        "economic_date": "2026-01-01",
        **extra,
    }


def upload(app, body=None, source="generic"):
    content = body or "日期,金额,类型,流水号,备注\n2026-01-01,20,支出,A1,午餐\n"
    result = app.client.post(
        app.base + "/imports",
        {
            "file": SimpleUploadedFile("bill.csv", content.encode()),
            "source": source,
            "account_id": str(app.account.pk),
        },
    )
    assert result.status_code == 200, result.content
    batch = result.json()
    preview = send(app, f"/imports/{batch['id']}/preview", {})
    assert preview.status_code == 200, preview.content
    return preview.json()


def commit(app, batch, **extra):
    return send(
        app,
        f"/imports/{batch['id']}/commit",
        {
            "preview_version": batch["preview_version"],
            "ledger_revision": batch["ledger_revision"],
            **extra,
        },
    )


def test_idempotency_and_optimistic_version(app):
    body = expense(app)
    one = send(app, "/events", body, key="same-command")
    two = send(app, "/events", body, key="same-command")
    assert one.status_code == 200, one.content
    assert two.json()["id"] == one.json()["id"]
    assert (
        send(app, "/events", expense(app, "21"), key="same-command").status_code == 409
    )
    assert app.client.get(app.base + "/events").json()["count"] == 1
    assert (
        send(
            app, f"/accounts/{app.account.pk}", {"name": "新名称"}, method="patch"
        ).status_code
        == 428
    )
    assert (
        send(
            app,
            f"/accounts/{app.account.pk}",
            {"name": "新名称", "version": 1},
            method="patch",
        ).status_code
        == 200
    )
    assert (
        send(
            app,
            f"/accounts/{app.account.pk}",
            {"name": "覆盖", "version": 1},
            method="patch",
        ).status_code
        == 412
    )


def test_tenant_isolation_and_viewer_raw_privilege(app):
    batch = upload(app)
    other = m.Workspace.objects.create(name="另一个家庭")
    with tenant_context(other.pk):
        foreign = m.Account.objects.create(tenant=other, name="外部私密银行")
    assert app.client.get(f"/api/v1/spaces/{other.pk}/accounts").status_code == 404
    assert (
        send(
            app,
            "/events",
            expense(app, target_account_id=str(foreign.pk), kind="transfer"),
        ).status_code
        == 404
    )
    app.client.force_login(app.viewer)
    assert app.client.get(app.base + "/overview").status_code == 200
    assert app.client.get(app.base + f"/imports/{batch['id']}").status_code == 403
    assert app.client.get(app.base + f"/imports/{batch['id']}/file").status_code == 403
    assert send(app, "/events", expense(app)).status_code == 403
    assert send(app, "/exports", {}).status_code == 403


def test_editor_cannot_manage_members_or_download_originals(app):
    batch = upload(app)
    app.client.force_login(app.editor)
    assert send(app, "/events", expense(app)).status_code == 200
    assert app.client.get(app.base + f"/imports/{batch['id']}/file").status_code == 403
    assert send(app, "/invitations", {"role": "owner"}).status_code == 403
    assert send(app, "/exports", {}).status_code == 403


def test_last_owner_and_immediate_revocation(app):
    members = app.client.get(app.base + "/members").json()["items"]
    owner = next(x for x in members if x["role"] == "owner")
    viewer = next(x for x in members if x["role"] == "viewer")
    assert (
        send(
            app, f"/members/{owner['id']}", {"role": "viewer"}, method="patch"
        ).status_code
        == 422
    )
    separate = Client()
    separate.force_login(app.viewer)
    assert separate.get(app.base + "/overview").status_code == 200
    assert app.client.delete(app.base + f"/members/{viewer['id']}").status_code == 200
    assert separate.get(app.base + "/overview").status_code == 404


def test_invitation_preview_join_and_single_use(app):
    invite = send(app, "/invitations", {"role": "viewer"}).json()
    public = Client()
    preview = public.get("/api/v1/invitations/preview", {"token": invite["token"]})
    assert preview.status_code == 200, preview.content
    assert preview.json()["space_name"] == "API合成验收"
    response = public.post(
        "/api/v1/auth/join",
        data=json.dumps(
            {
                "token": invite["token"],
                "username": "joined-user",
                "password": "Strong-join-pass-7294",
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200, response.content
    assert response.json()["spaces"][0]["role"] == "viewer"
    assert (
        public.get(
            "/api/v1/invitations/preview", {"token": invite["token"]}
        ).status_code
        == 422
    )


def test_csrf_is_enforced_even_for_login(app):
    client = Client(enforce_csrf_checks=True)
    credentials = json.dumps(
        {"username": app.owner.username, "password": "Example-strong-test-only-5839"}
    )
    assert (
        client.post(
            "/api/v1/auth/login", data=credentials, content_type="application/json"
        ).status_code
        == 403
    )
    token = client.get("/api/v1/auth/me").json()["csrf_token"]
    assert (
        client.post(
            "/api/v1/auth/login",
            data=credentials,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        ).status_code
        == 200
    )


def test_overlapping_native_id_import_is_one_fact_two_evidence_rows(app):
    one = upload(app)
    assert commit(app, one).status_code == 200
    two = upload(
        app,
        "日期,金额,类型,流水号,备注\n2026-01-01,20,支出,A1,午餐\n2026-01-02,5,支出,A2,咖啡\n",
    )
    assert two["rows"][0]["duplicate"]
    result = commit(app, two)
    assert result.status_code == 200, result.content
    assert app.client.get(app.base + "/events").json()["count"] == 2
    with tenant_context(app.space.pk):
        assert m.EvidenceLink.objects.filter(tenant=app.space).count() == 3
    result = send(app, f"/imports/{one['id']}/reverse", {"reason": "撤销重复批次"})
    assert result.status_code == 200, result.content
    assert app.client.get(app.base + "/events").json()["count"] == 2


def test_source_content_revision_is_not_silently_overwritten(app):
    one = upload(app)
    assert commit(app, one).status_code == 200
    two = upload(app, "日期,金额,类型,流水号,备注\n2026-01-01,21,支出,A1,午餐\n")
    assert commit(app, two).status_code == 409
    assert app.client.get(app.base + "/events").json()["count"] == 1


def test_preview_expires_after_ledger_change_and_batch_is_atomic(app):
    batch = upload(app)
    assert send(app, "/events", expense(app)).status_code == 200
    assert commit(app, batch).status_code == 409
    bad = upload(
        app,
        "日期,金额,类型,流水号,备注\n2026-01-02,5,支出,B1,可读\n2026-01-03,no,支出,B2,错误\n",
    )
    assert commit(app, bad).status_code == 422
    assert app.client.get(app.base + "/events").json()["count"] == 1


def test_cross_source_link_checks_account_type_and_preserves_fact(app):
    event = send(app, "/events", expense(app)).json()
    batch = upload(app, source="wechat")
    row = batch["rows"][0]["id"]
    assert commit(app, batch, links={row: event["id"]}).status_code == 200
    assert app.client.get(app.base + "/events").json()["count"] == 1
    assert (
        send(
            app, f"/imports/{batch['id']}/reverse", {"reason": "来源文件有误"}
        ).status_code
        == 200
    )
    assert app.client.get(app.base + "/events").json()["count"] == 1
    wrong = upload(
        app,
        "日期,金额,类型,流水号,备注\n2026-01-01,20,收入,C1,方向不符\n",
        source="alipay",
    )
    assert (
        commit(app, wrong, links={wrong["rows"][0]["id"]: event["id"]}).status_code
        == 422
    )


def test_export_contains_facts_and_evidence_and_enforces_requestor(app):
    batch = upload(app)
    assert commit(app, batch).status_code == 200
    result = send(app, "/exports", {})
    assert result.status_code == 200, result.content
    response = app.client.get(result.json()["download_url"])
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(b"".join(response.streaming_content))) as archive:
        data = json.loads(archive.read("wealth.json"))
        assert len(data["tables"]["Event"]) == 1
        assert any(x.startswith("evidence/") for x in archive.namelist())
        assert "storage_key" not in json.dumps(data)
    app.client.force_login(app.editor)
    assert app.client.get(result.json()["download_url"]).status_code == 403


def test_app_routes_and_empty_real_overview(app):
    data = app.client.get(app.base + "/overview").json()
    assert Decimal(data["net_assets"]) == 0
    for resource in [
        "accounts",
        "positions",
        "events",
        "plans",
        "loans",
        "goals",
        "notes",
        "budgets",
        "reconciliations",
        "strategies",
        "adapters",
        "members",
        "jobs",
        "audit",
        "calendar",
        "performance",
        "forecast",
    ]:
        response = app.client.get(app.base + "/" + resource)
        assert response.status_code == 200, (resource, response.content[:500])


def test_partial_batch_can_resume_without_republishing_committed_rows(app):
    batch = upload(
        app,
        "日期,金额,类型,流水号,备注\n2026-01-01,20,支出,P1,第一笔\n2026-01-02,30,支出,P2,第二笔\n",
    )
    first = commit(app, batch, row_ids=[batch["rows"][0]["id"]])
    assert first.status_code == 200, first.content
    assert first.json()["status"] == "partially_committed"
    assert first.json()["diagnostics"]["remaining_rows"] == 1
    again = send(app, f"/imports/{batch['id']}/preview", {}).json()
    assert again["rows"][0]["committed"] is True
    assert again["rows"][1]["committed"] is False
    result = commit(app, again)
    assert result.status_code == 200, result.content
    assert result.json()["status"] == "committed"
    assert app.client.get(app.base + "/events").json()["count"] == 2


def test_changed_business_kind_is_a_source_revision(app):
    one = upload(app)
    assert commit(app, one).status_code == 200
    two = upload(app, "日期,金额,类型,流水号,备注\n2026-01-01,20,收入,A1,午餐\n")
    assert commit(app, two).status_code == 409
    assert app.client.get(app.base + "/events").json()["count"] == 1


def test_server_pagination_search_and_financial_filters(app):
    for i in range(5):
        assert (
            send(
                app, "/events", expense(app, str(i + 1), description=f"分页测试{i}")
            ).status_code
            == 200
        )
    result = app.client.get(
        app.base + "/events",
        {"offset": 2, "limit": 2, "q": "分页", "kind": "expense", "currency": "CNY"},
    ).json()
    assert (
        result["count"] == 5
        and len(result["items"]) == 2
        and result["has_more"] is True
    )
    assert app.client.get(app.base + "/events", {"kind": "income"}).json()["count"] == 0


def test_account_with_opening_is_idempotent_and_cache_invalidates(app):
    body = {
        "name": "开户含期初",
        "kind": "bank",
        "currency": "CNY",
        "opening_balance": "1000",
        "opening_date": "2026-01-01",
    }
    first = send(app, "/accounts", body, key="account-with-opening")
    assert first.status_code == 200, first.content
    second = send(app, "/accounts", body, key="account-with-opening")
    assert first.json()["id"] == second.json()["id"]
    result = app.client.get(app.base + "/overview").json()
    assert Decimal(result["net_assets"]) == 1000
    with tenant_context(app.space.pk):
        from wealth.tasks import recompute

        job = m.Outbox.objects.filter(tenant=app.space).latest("revision")
        recompute(str(app.space.pk), str(job.pk))
    assert app.client.get(app.base + "/overview").json()["cached"] is True
    assert send(app, "/events", expense(app)).status_code == 200
    result = app.client.get(app.base + "/overview").json()
    assert Decimal(result["net_assets"]) == 980
    assert not result.get("cached")


def test_unknown_transfer_direction_is_not_guessed_as_cash_debit(app):
    batch = upload(
        app, "日期,金额,类型,流水号,备注\n2026-01-01,20,不计收支,U1,方向未知\n"
    )
    assert batch["rows"][0]["errors"]
    assert commit(app, batch).status_code == 422
    assert app.client.get(app.base + "/events").json()["count"] == 0
    event = send(app, "/events", expense(app)).json()
    again = send(app, f"/imports/{batch['id']}/preview", {}).json()
    assert (
        commit(app, again, links={again["rows"][0]["id"]: event["id"]}).status_code
        == 200
    )
    assert app.client.get(app.base + "/events").json()["count"] == 1


def test_untrusted_tokens_and_export_filenames_have_safe_boundaries(app):
    client = Client()
    invalid = client.post(
        "/api/v1/invitations/preview",
        data=json.dumps({"token": {"bad": "shape"}}),
        content_type="application/json",
    )
    assert invalid.status_code == 422
    response = app.client.post(
        app.base + "/imports",
        {
            "file": SimpleUploadedFile(
                "..\\..\\escape.csv", "日期,金额,类型\n2026-01-01,10,支出\n".encode()
            ),
            "source": "generic",
            "account_id": str(app.account.pk),
        },
    )
    assert response.status_code == 200
    assert response.json()["filename"] == "escape.csv"
    exported = send(app, "/exports", {}).json()
    downloaded = app.client.get(exported["download_url"])
    with zipfile.ZipFile(io.BytesIO(b"".join(downloaded.streaming_content))) as archive:
        assert all(
            "\\" not in name and ".." not in name.split("/")
            for name in archive.namelist()
        )
