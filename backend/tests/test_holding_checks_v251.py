"""Institution discrepancy notes cannot rewrite recorded positions or money."""

import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from wealth.common import DomainError, tenant_context
from wealth.holding_checks import (
    apply_holding_check,
    holding_check_eligibility,
    read_holding_check,
    save_holding_check,
)
from wealth.ledger import post_event, reverse_event
from wealth.models import (
    Account,
    Audit,
    Event,
    Instrument,
    JournalLine,
    Membership,
    PositionMovement,
    Price,
    Resource,
    ResourceRevision,
    Snapshot,
    Workspace,
)

pytestmark = pytest.mark.django_db
D = Decimal
DATE = "2026-09-24"


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    user = get_user_model().objects.create_user("holding-check-owner")
    space = Workspace.objects.create(name="机构数据差异核对")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        account = Account.objects.create(tenant=space, kind="fund", name="基金直销")
        instrument = Instrument.objects.create(
            tenant=space, kind="fund", name="待核对基金", code="TEST_CHECK"
        )
        # Reproduce a legacy saved record independently of stricter new onboarding.
        opening = post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(account.pk),
                "instrument_id": str(instrument.pk),
                "amount": "0",
                "quantity": "337.67",
                "cost": "345",
                "economic_date": DATE,
                "opening_source": "existing_holding",
                "opening_market_value": "361.41",
                "purchase_date": "2026-09-01",
                "history_mode": "snapshot_only",
            },
        )
        Resource.objects.create(
            tenant=space,
            kind="holding_valuations",
            data={
                "opening_event_id": str(opening.pk),
                "account_id": str(account.pk),
                "instrument_id": str(instrument.pk),
                "quantity": "337.67",
                "value": "361.41",
                "economic_date": DATE,
                "valuation_basis": "formal",
                "valuation_date": DATE,
            },
        )
        yield SimpleNamespace(
            user=user,
            space=space,
            account=account,
            instrument=instrument,
            opening=opening,
        )


def save(book, **extra):
    return save_holding_check(
        book.space,
        book.user,
        book.opening.pk,
        {
            "version": 0,
            "institution_profit": "-3.60",
            "reference_nav": "1.0703",
            "reference_date": DATE,
            "available_quantity": "318.98",
            **extra,
        },
    )


def read(book, when=DATE):
    return read_holding_check(
        book.space, book.account, book.instrument, D("337.67"), when
    )


def financial_facts(book):
    return {
        model.__name__: list(
            model.objects.filter(tenant=book.space).order_by("pk").values()
        )
        for model in [
            Account,
            Instrument,
            Event,
            JournalLine,
            PositionMovement,
            Price,
            Snapshot,
        ]
    }


def test_conflict_records_both_profits_without_rewriting_any_money_or_shares(book):
    before = financial_facts(book)
    check = save(book)
    assert check["status"] == "unresolved"
    assert D(check["institution_profit"]) == D("-3.60")
    assert D(check["computed_profit"]) == D("16.41")
    assert D(check["profit_difference"]) == D("20.01")
    assert D(check["cost"]) == D("345")
    assert D(check["quantity"]) == D("337.67")
    assert D(check["current_value"]) == D("361.41")
    assert D(check["available_quantity"]) == D("318.98")
    assert check["available_quantity_is_information_only"] is True
    assert check["affects_cash_or_quantity"] is False
    assert check["is_realized_profit"] is False
    assert read(book) == check
    assert financial_facts(book) == before
    assert ResourceRevision.objects.filter(resource_id=check["id"], version=1).exists()
    assert Audit.objects.filter(
        tenant=book.space, action="holding.check_recorded", object_id=check["id"]
    ).exists()


def test_suppression_is_idempotent_and_does_not_destroy_estimate_or_valuation_basis(
    book,
):
    check = save(book)
    row = {
        "market_value": D("361.41"),
        "quantity": D("337.67"),
        "cost": D("345"),
        "unrealized_profit": D("16.41"),
        "status": "stale",
        "cost_status": "known",
    }
    first = apply_holding_check(row, check)
    assert "estimated_profit" not in first
    assert first["valuation_status"] == "stale"
    first["estimate_profit"] = D("18.21")
    final = apply_holding_check(first, check)
    assert final["estimated_profit"] == D("18.21")
    assert final == apply_holding_check(final, check)
    for name in ["profit", "unrealized_profit", "profit_rate", "estimate_profit"]:
        assert final[name] is None
    for name in ["market_value", "quantity", "cost"]:
        assert final[name] == row[name]
    assert final["status"] == "needs_reconciliation"
    assert final["cost_status"] == "unreconciled"
    assert row["status"] == "stale"


@pytest.mark.parametrize(
    "profit,status",
    [("16.43", "matched"), ("16.39", "matched"), ("16.431", "unresolved")],
)
def test_two_cent_tolerance_is_not_rounded_to_hide_material_difference(
    book, profit, status
):
    check = save(book, institution_profit=profit)
    assert check["status"] == status


def test_available_units_never_substitute_for_recorded_holding_quantity(book):
    check = save(book, institution_profit="16.41", available_quantity="0")
    assert check["status"] == "matched"
    assert D(check["quantity"]) == D("337.67")
    assert D(check["computed_profit"]) == D("16.41")


def test_nav_is_optional_but_inconsistent_nav_is_a_comparison_only(book):
    check = save(book, institution_profit="16.41", reference_nav=None)
    assert check["status"] == "matched"
    check = save(book, version=1, institution_profit="16.41", reference_nav="2")
    assert check["status"] == "unresolved"
    assert "nav_value_difference" in check["reasons"]
    assert not Price.objects.filter(tenant=book.space).exists()


def test_versioned_recheck_can_resolve_difference_with_history_retained(book):
    check = save(book)
    with pytest.raises(DomainError) as caught:
        save(book)
    assert caught.value.code == "version_conflict"
    updated = save(book, version=1, institution_profit="16.41", note="已向机构核对口径")
    assert updated["id"] == check["id"] and updated["version"] == 2
    assert updated["status"] == "matched"
    assert ResourceRevision.objects.filter(resource_id=check["id"]).count() == 2
    row = {"profit": D("16.41"), "profit_rate": D("0.1"), "status": "official"}
    assert apply_holding_check(row, updated)["profit"] == row["profit"]


@pytest.mark.parametrize(
    "extra",
    [
        {"version": None},
        {"version": True},
        {"version": "01"},
        {"institution_profit": float("inf")},
        {"institution_profit": "NaN"},
        {"institution_profit": None},
        {"reference_nav": "0"},
        {"reference_nav": "-1"},
        {"available_quantity": "-1"},
        {"available_quantity": False},
        {"as_of": "2026-09-25"},
        {"reference_date": "2026-09-25"},
        {"reference_date": "2999-01-01"},
        {"note": {}},
        {"quantity": "318.98"},
        {"cost": "365.01"},
        {"status": "matched"},
        {"computed_profit": "-3.60"},
        {"data": {"status": "matched"}},
    ],
)
def test_invalid_or_financial_override_fields_rejected_without_writes(book, extra):
    before = financial_facts(book)
    with pytest.raises(DomainError):
        save(book, **extra)
    assert not Resource.objects.filter(
        tenant=book.space, kind="holding_checks"
    ).exists()
    assert financial_facts(book) == before


def test_as_of_and_reference_date_default_to_original_holding_date(book):
    check = save_holding_check(
        book.space,
        book.user,
        book.opening.pk,
        {"version": 0, "institution_profit": "-3.60"},
    )
    assert check["as_of"] == DATE and check["reference_date"] == DATE
    assert holding_check_eligibility(book.space, book.opening)["as_of"] == DATE
    assert read(book, "2026-09-23") is None


def test_reversing_opening_deactivates_check_without_destroying_audit(book):
    check = save(book)
    reverse_event(book.space, book.user, book.opening, "实际更正原持仓")
    assert read(book) is None
    assert holding_check_eligibility(book.space, book.opening)["eligible"] is False
    assert Resource.objects.filter(tenant=book.space, pk=check["id"]).exists()
    with pytest.raises(DomainError, match="尚未更正"):
        save(book, version=1)


def test_actual_holding_change_invalidates_check_even_if_quantity_returns(book):
    save(book)
    event = post_event(
        book.space,
        book.user,
        {
            "kind": "split",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.instrument.pk),
            "ratio": "2",
            "economic_date": "2026-09-25",
        },
    )
    assert read(book, "2026-09-25") is None
    assert read(book, DATE) is not None
    assert holding_check_eligibility(book.space, book.opening)["eligible"] is False
    reverse_event(book.space, book.user, event, "撤销错误份额变更")
    assert read(book, "2026-09-25") is not None


def test_cross_workspace_event_and_forged_associations_are_rejected(book):
    other = Workspace.objects.create(name="另一空间")
    with tenant_context(other.pk):
        with pytest.raises(DomainError) as caught:
            save_holding_check(
                other,
                book.user,
                book.opening.pk,
                {"version": 0, "institution_profit": "0"},
            )
        assert caught.value.code == "not_found"
    with pytest.raises(DomainError, match="关联原持仓"):
        save(book, account_id=str(uuid.uuid4()))
    assert (
        read_holding_check(book.space, book.account, book.instrument, D("318.98"), DATE)
        is None
    )


def test_stale_workspace_revision_rejects_and_archived_account_cannot_write(book):
    with pytest.raises(DomainError) as caught:
        save(book, expected_revision=0)
    assert caught.value.code == "version_conflict"
    book.account.archived = True
    book.account.save(update_fields=["archived"])
    with pytest.raises(DomainError, match="归档"):
        save(book)


def test_generic_planning_cannot_write_or_override_check_resource(book):
    from wealth.planning import save_resource

    with pytest.raises(DomainError):
        save_resource(
            book.space, book.user, "holding_checks", {"institution_profit": "0"}
        )


def test_matching_numbers_cannot_resolve_explicitly_unconfirmed_scope(book):
    check = save(book, institution_profit="16.41", scope_unconfirmed=True)
    assert check["status"] == "unresolved"
    assert check["scope_unconfirmed"] is True
    assert "scope_unconfirmed" in check["reasons"]
    assert D(check["profit_difference"]) == 0
    assert apply_holding_check({"profit": D("16.41")}, check)["profit"] is None


def test_unconfirmed_scope_survives_edit_until_explicitly_confirmed(book):
    before = financial_facts(book)
    first = save(book, institution_profit="16.41", scope_unconfirmed=True)
    unchanged = save(book, version=1, institution_profit="16.41", note="仅补充备注")
    assert unchanged["status"] == "unresolved"
    assert unchanged["scope_unconfirmed"] is True
    matched = save(book, version=2, institution_profit="16.41", scope_unconfirmed=False)
    assert matched["id"] == first["id"]
    assert matched["status"] == "matched" and matched["scope_unconfirmed"] is False
    assert financial_facts(book) == before


@pytest.mark.parametrize("flag", ["true", "false", 0, 1, None])
def test_scope_confirmation_requires_real_boolean(book, flag):
    with pytest.raises(DomainError, match="布尔值"):
        save(book, scope_unconfirmed=flag)
    assert not Resource.objects.filter(
        tenant=book.space, kind="holding_checks"
    ).exists()
