"""A later institutional file must not silently duplicate an estimated debit."""

from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from wealth.common import DomainError, tenant_context
from wealth.imports import create_batch, preview, commit_batch, reverse_batch
from wealth.ledger import post_event, balance
from wealth.models import Workspace, Account, Event, EvidenceLink

pytestmark = pytest.mark.django_db


@pytest.fixture
def book():
    user = get_user_model().objects.create_user("auto-import-matching")
    space = Workspace.objects.create(name="自动补录账单匹配")
    with tenant_context(space.pk):
        account = Account.objects.create(tenant=space, name="扣款卡", kind="bank")
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(account.pk),
                "amount": "100",
                "economic_date": "2026-09-01",
            },
        )
        debit = post_event(
            space,
            user,
            {
                "kind": "fund_debit",
                "account_id": str(account.pk),
                "amount": "10.00",
                "economic_date": "2026-09-23",
                "automatic_estimate": True,
            },
            stage_key=f"{space.pk}:dca:synthetic:2026-09-23:debit",
        )
        file = SimpleUploadedFile(
            "later.csv", b"date,amount,type,id\n2026-09-23,10,fund_debit,real-1\n"
        )
        batch = create_batch(space, user, file, "generic", account.pk)
        result = preview(
            space,
            user,
            batch,
            {
                "mapping": {
                    "date": "date",
                    "amount": "amount",
                    "type": "type",
                    "external_id": "id",
                }
            },
        )
        yield SimpleNamespace(
            user=user,
            space=space,
            account=account,
            debit=debit,
            batch=batch,
            preview=result,
        )


def body(book):
    return {
        "preview_version": book.batch.version,
        "ledger_revision": book.space.revision,
    }


def test_numeric_matching_blocks_duplicate_then_links_evidence_without_new_debit(book):
    row = book.preview["rows"][0]
    assert row["automatic_match"] and row["candidates"][0]["id"] == str(book.debit.pk)
    with pytest.raises(DomainError, match="自动定投记录"):
        commit_batch(book.space, book.user, book.batch, body(book))
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 1
    commit_batch(
        book.space,
        book.user,
        book.batch,
        {**body(book), "links": {row["id"]: str(book.debit.pk)}},
    )
    assert balance(book.space, book.account, "cash") == 90
    assert EvidenceLink.objects.get(tenant=book.space).introduced is False
    reverse_batch(book.space, book.user, book.batch, "撤销重复来源")
    assert balance(book.space, book.account, "cash") == 90


def test_explicit_independent_trade_can_be_recorded_and_wrong_rows_rejected(book):
    with pytest.raises(DomainError, match="不属于提交行"):
        commit_batch(
            book.space,
            book.user,
            book.batch,
            {**body(book), "distinct_rows": ["not-in-batch"]},
        )
    row = book.preview["rows"][0]
    commit_batch(
        book.space, book.user, book.batch, {**body(book), "distinct_rows": [row["id"]]}
    )
    assert Event.objects.filter(tenant=book.space, kind="fund_debit").count() == 2
    assert balance(book.space, book.account, "cash") == 80
