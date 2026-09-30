"""Opening-date changes replace facts and respect chronological dependencies."""

from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model

from wealth.account_opening import (
    CORRECTION_ACTION,
    correct_opening_date,
    effective_snapshots,
    initialize_account,
    opening_date_metadata,
    trusted_opening_ids,
)
from wealth.common import DomainError, tenant_context
from wealth.ledger import balance, post_event
from wealth.models import (
    Account,
    Audit,
    Event,
    Instrument,
    Membership,
    Snapshot,
    Workspace,
)
from wealth.portfolio import net_worth_comparison
from wealth.reporting import overview, performance

pytestmark = pytest.mark.django_db
D = Decimal
ORIGINAL = "2026-09-20"
EARLIER = "2026-09-18"
LATER = "2026-09-22"


@pytest.fixture
def book():
    user = get_user_model().objects.create_user("opening-edit-v255-owner")
    space = Workspace.objects.create(name="期初日期更正验收")
    Membership.objects.create(user=user, workspace=space, role="owner")
    with tenant_context(space.pk):
        yield SimpleNamespace(user=user, space=space)


def account(book, kind="bank", amount="1000", **kwargs):
    row = Account.objects.create(
        tenant=book.space,
        created_by=book.user,
        name="期初日期账户",
        kind=kind,
        **kwargs,
    )
    if amount is not None:
        initialize_account(
            book.space,
            book.user,
            row,
            {
                "opening_balance": amount,
                "opening_date": ORIGINAL,
                "opening_coverage": "全部客户权益，无期权持仓",
                "opening_coverage_confirmed": True,
                "opening_option_scope": "no_options",
                "opening_available": "500",
            },
        )
    return row


def correction(book, row, date, **overrides):
    metadata = opening_date_metadata(book.space, row)
    return correct_opening_date(
        book.space,
        book.user,
        row,
        {
            "version": metadata["version"],
            "expected_revision": metadata["data_revision"],
            "opening_date": date,
            "reason": "根据原机构记录核对日期",
            **overrides,
        },
    )


def flow(book, row, kind="expense", date=LATER, amount="200", **values):
    return post_event(
        book.space,
        book.user,
        {
            "kind": kind,
            "account_id": str(row.pk),
            "economic_date": date,
            "amount": amount,
            **values,
        },
    )


@pytest.mark.parametrize(
    "kind,amount", [("bank", "1000"), ("bank", "0"), ("loan", "1000")]
)
@pytest.mark.parametrize("new_date", [EARLIER, LATER])
def test_cash_opening_date_replaces_balanced_facts_without_income_or_duplicate_money(
    book, kind, amount, new_date
):
    row = account(book, kind, amount)
    old = Event.objects.get(tenant=book.space, kind="opening")
    initial_balance = balance(book.space, row)
    old_lines = list(old.lines.values_list("account_id", "code", "amount", "currency"))
    result = correction(book, row, new_date)
    assert result["changed"] is True and result["opening_date"] == new_date
    assert result["previous_date"] == ORIGINAL and result["version"] == 2
    old.refresh_from_db()
    assert str(old.economic_date) == ORIGINAL and old.payload["amount"] == amount
    assert (
        list(old.lines.values_list("account_id", "code", "amount", "currency"))
        == old_lines
    )
    assert str(old.reversal.pk) == result["reversal_id"]
    replacement = Event.objects.get(pk=result["new_source_id"])
    assert replacement.kind == "opening" and str(replacement.economic_date) == new_date
    assert sum(replacement.lines.values_list("amount", flat=True), D(0)) == 0
    assert balance(book.space, row) == initial_balance
    assert not Event.objects.filter(
        tenant=book.space, kind__in=["income", "expense"]
    ).exists()
    expected = -D(amount) if kind == "loan" else D(amount)
    assert D(overview(book.space, "2026-09-23")["net_assets"]) == expected
    before_effective = "2026-09-19" if new_date == LATER else "2026-09-17"
    assert balance(book.space, row, as_of=before_effective) == 0
    if new_date == LATER:
        assert balance(book.space, row, as_of=ORIGINAL) == 0
    else:
        assert balance(book.space, row, as_of=EARLIER) == expected
    result = performance(book.space, new_date, "2026-09-23", account_ids=[row.pk])
    assert D(result["net_profit"]) == 0


def test_later_transaction_stays_unchanged_and_allows_equal_day_opening(book):
    row = account(book)
    expense = flow(book, row)
    assert opening_date_metadata(book.space, row)["max_date"] == LATER
    result = correction(book, row, LATER)
    assert result["opening_date"] == LATER
    expense.refresh_from_db()
    assert expense.kind == "expense" and expense.payload["amount"] == "200"
    assert not hasattr(expense, "reversal")
    assert balance(book.space, row, as_of=LATER) == D("800")
    assert D(overview(book.space, LATER)["net_assets"]) == D("800")


def test_cannot_move_cash_opening_after_spending_or_create_unfunded_history(book):
    row = account(book)
    flow(book, row)
    original_events = Event.objects.filter(tenant=book.space).count()
    with pytest.raises(DomainError, match="不能晚于已有"):
        correction(book, row, "2026-09-23")
    assert Event.objects.filter(tenant=book.space).count() == original_events
    assert not Event.objects.filter(tenant=book.space, kind="reversal").exists()
    assert balance(book.space, row) == D("800")


def test_holding_dependency_also_bounds_the_cash_opening_date(book):
    row = account(book, "broker")
    product = Instrument.objects.create(
        tenant=book.space, name="日期依赖基金", code="EDIT255"
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(row.pk),
            "instrument_id": str(product.pk),
            "quantity": "10",
            "cost": "100",
            "economic_date": LATER,
        },
    )
    with pytest.raises(DomainError, match="不能晚于已有"):
        correction(book, row, "2026-09-23")
    assert (
        Event.objects.filter(
            tenant=book.space, kind="opening", reversal__isnull=True
        ).count()
        == 2
    )


def test_date_correction_can_be_repeated_without_reactivating_old_openings(book):
    row = account(book)
    first = correction(book, row, EARLIER)
    second = correction(book, row, LATER)
    assert second["version"] == 3
    assert (
        Event.objects.filter(
            tenant=book.space, kind="opening", reversal__isnull=True
        ).count()
        == 1
    )
    assert Event.objects.filter(tenant=book.space, kind="reversal").count() == 2
    assert hasattr(Event.objects.get(pk=first["new_source_id"]), "reversal")
    assert balance(book.space, row) == D("1000")
    assert balance(book.space, row, as_of=ORIGINAL) == 0
    assert (
        Audit.objects.filter(tenant=book.space, action=CORRECTION_ACTION).count() == 2
    )


@pytest.mark.parametrize("new_date", [EARLIER, LATER])
def test_institution_opening_date_appends_replacement_and_retains_original_evidence(
    book, new_date
):
    row = account(book, "futures", valuation_mode="snapshot")
    old = Snapshot.objects.get(tenant=book.space, account=row)
    result = correction(book, row, new_date)
    assert result["kind"] == "snapshot" and result["method"] == "append_snapshot"
    assert result["reversal_id"] is None
    old.refresh_from_db()
    assert str(old.economic_date) == ORIGINAL and old.equity == D("1000")
    active = effective_snapshots(book.space, row).get()
    assert str(active.pk) == result["new_source_id"]
    assert str(active.economic_date) == new_date
    assert (
        active.equity,
        active.currency,
        active.coverage,
        active.complete,
        active.includes_options,
        active.included_event_ids,
    ) == (
        old.equity,
        old.currency,
        old.coverage,
        old.complete,
        old.includes_options,
        old.included_event_ids,
    )
    assert active.details["available"] == "500"
    assert not Event.objects.filter(tenant=book.space).exists()
    assert D(overview(book.space, "2026-09-23")["net_assets"]) == D("1000")
    if new_date == LATER:
        assert overview(book.space, ORIGINAL)["accounts"][0]["value"] is None
        assert (
            net_worth_comparison(book.space, ORIGINAL)["estimated"][
                "known_account_count"
            ]
            == 0
        )
    else:
        assert D(overview(book.space, EARLIER)["accounts"][0]["value"]) == D("1000")


def test_user_supplied_snapshot_details_cannot_hide_other_equity(book):
    row = account(book, "futures", valuation_mode="snapshot")
    initial = Snapshot.objects.get(tenant=book.space)
    later = Snapshot.objects.create(
        tenant=book.space,
        account=row,
        economic_date=LATER,
        currency="CNY",
        equity="900",
        coverage="核对权益",
        complete=True,
        includes_options=True,
        details={"opening_date_supersedes": str(initial.pk)},
    )
    assert set(effective_snapshots(book.space, row).values_list("pk", flat=True)) == {
        initial.pk,
        later.pk,
    }


def test_corrected_snapshot_chain_does_not_erase_later_independent_statement(book):
    row = account(book, "futures", valuation_mode="snapshot")
    later = Snapshot.objects.create(
        tenant=book.space,
        account=row,
        economic_date=LATER,
        currency="CNY",
        equity="980",
        coverage="后续独立结算",
        complete=True,
        includes_options=True,
    )
    correction(book, row, EARLIER)
    correction(book, row, "2026-09-21")
    assert effective_snapshots(book.space, row).count() == 2
    assert effective_snapshots(book.space, row).filter(pk=later.pk).exists()
    assert D(overview(book.space, LATER)["net_assets"]) == D("980")
    with pytest.raises(DomainError, match="不能晚于已有"):
        correction(book, row, "2026-09-23")


@pytest.mark.parametrize("change", [{"version": 0}, {"expected_revision": 0}])
def test_versions_prevent_stale_correction(book, change):
    row = account(book)
    with pytest.raises(DomainError) as exc:
        correction(book, row, EARLIER, **change)
    assert exc.value.status == 412
    assert Event.objects.filter(tenant=book.space).count() == 1


def test_new_transaction_since_preview_invalidates_correction(book):
    row = account(book)
    metadata = opening_date_metadata(book.space, row)
    flow(book, row)
    with pytest.raises(DomainError) as exc:
        correct_opening_date(
            book.space,
            book.user,
            row,
            {
                "version": metadata["version"],
                "expected_revision": metadata["data_revision"],
                "opening_date": EARLIER,
                "reason": "旧预览提交",
            },
        )
    assert exc.value.status == 412
    assert not Event.objects.filter(tenant=book.space, kind="reversal").exists()


@pytest.mark.parametrize(
    "overrides",
    [
        {"reason": ""},
        {"opening_date": "2099-01-01"},
        {"opening_date": "invalid"},
        {"opening_balance": "9999"},
    ],
)
def test_invalid_or_amount_changing_request_leaves_every_fact_unchanged(
    book, overrides
):
    row = account(book)
    metadata = opening_date_metadata(book.space, row)
    body = {
        "version": metadata["version"],
        "expected_revision": metadata["data_revision"],
        "opening_date": EARLIER,
        "reason": "合法说明",
        **overrides,
    }
    with pytest.raises(DomainError):
        correct_opening_date(book.space, book.user, row, body)
    assert Event.objects.filter(tenant=book.space).count() == 1
    assert balance(book.space, row) == D("1000")


def test_same_date_does_not_post_reversal_or_change_revision(book):
    row = account(book)
    metadata = opening_date_metadata(book.space, row)
    result = correction(book, row, ORIGINAL)
    assert result["changed"] is False
    assert (
        result["version"] == metadata["version"]
        and result["data_revision"] == metadata["data_revision"]
    )
    assert Event.objects.filter(tenant=book.space).count() == 1


def test_no_opening_archived_and_foreign_account_are_not_editable(book):
    empty = account(book, amount=None)
    assert opening_date_metadata(book.space, empty)["editable"] is False
    with pytest.raises(DomainError, match="没有可更正"):
        correction(book, empty, EARLIER)
    row = account(book)
    row.archived = True
    row.save(update_fields=["archived"])
    assert opening_date_metadata(book.space, row)["editable"] is False
    with pytest.raises(DomainError, match="已归档"):
        correction(book, row, EARLIER)
    other = Workspace.objects.create(name="另一个隔离空间")
    with pytest.raises(DomainError) as exc:
        opening_date_metadata(other, row)
    assert exc.value.status == 404


def test_only_holding_opening_is_not_misidentified_as_account_cash_opening(book):
    row = account(book, "fund", amount=None)
    instrument = Instrument.objects.create(
        tenant=book.space, name="仅持仓", code="HOLDONLY255"
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(row.pk),
            "instrument_id": str(instrument.pk),
            "quantity": "10",
            "cost": "100",
            "economic_date": ORIGINAL,
        },
    )
    metadata = opening_date_metadata(book.space, row)
    assert metadata["available"] is False and metadata["editable"] is False


def test_snapshot_correction_audit_does_not_supersede_another_account(book):
    row = account(book, "futures", valuation_mode="snapshot")
    other = account(book, "futures", "2000", valuation_mode="snapshot")
    untouched = Snapshot.objects.get(tenant=book.space, account=other)
    correction(book, row, EARLIER)
    assert effective_snapshots(book.space, other).get().pk == untouched.pk
    assert effective_snapshots(book.space).count() == 2


def test_forged_manual_snapshot_flags_are_not_an_account_opening(book):
    row = account(book, "futures", amount=None, valuation_mode="snapshot")
    snapshot = Snapshot.objects.create(
        tenant=book.space,
        account=row,
        economic_date=ORIGINAL,
        currency="CNY",
        equity="1000",
        coverage="普通追加快照",
        complete=True,
        includes_options=True,
        details={"source": "manual_account_opening", "opening_account": True},
    )
    metadata = opening_date_metadata(book.space, row)
    assert metadata["available"] is False and metadata["editable"] is False
    assert trusted_opening_ids(book.space, row)["snapshot"] == set()
    with pytest.raises(DomainError):
        correction(book, row, EARLIER)
    assert effective_snapshots(book.space, row).get().pk == snapshot.pk


def test_forged_cash_payload_marker_is_not_a_created_account_opening(book):
    row = account(book, amount=None)
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(row.pk),
            "amount": "1000",
            "economic_date": ORIGINAL,
            "source": "manual_account_opening",
            "opening_account": True,
            "stage_key": f"{book.space.pk}:opening:{row.pk}",
        },
    )
    assert trusted_opening_ids(book.space, row)["cash"] == set()
    assert opening_date_metadata(book.space, row)["editable"] is False
    assert balance(book.space, row) == D("1000")


@pytest.mark.parametrize("kind", ["bank", "futures"])
def test_trusted_source_chain_includes_original_and_only_real_correction_descendants(
    book, kind
):
    row = account(book, kind)
    source_kind = "snapshot" if kind == "futures" else "cash"
    original = opening_date_metadata(book.space, row)["source_id"]
    first = correction(book, row, EARLIER)
    second = correction(book, row, LATER)
    assert trusted_opening_ids(book.space, row)[source_kind] == {
        original,
        first["new_source_id"],
        second["new_source_id"],
    }
