"""Read-only fund subscriptions awaiting shares, derived from journal balances.

The money already lives in fund_transit on the funding account. Attribution to a
holding account is presentation metadata and must never move or add that money.
"""

from collections import defaultdict
from decimal import Decimal

from django.db.models import Q

from .common import DomainError, day
from .models import (
    Account,
    Event,
    FxRate,
    Instrument,
    JournalLine,
    Occurrence,
    PositionMovement,
    Resource,
)

ZERO = Decimal(0)
MESSAGE = "已记扣款，等待份额；与已确认市值分开列示，不另加到净资产。"


def _active_at(when, prefix=""):
    # A reversal dated later must not erase a balance that existed as of `when`.
    return Q(**{f"{prefix}reverses__isnull": True}) & (
        Q(**{f"{prefix}reversal__isnull": True})
        | Q(**{f"{prefix}reversal__economic_date__gt": when})
    )


class PendingPurchases:
    """Batch projection reusable for both source accounts and target positions."""

    def __init__(self, space, when=None):
        self.space = space
        self.when = day(when)
        self.accounts = {
            str(row.pk): row for row in Account.objects.filter(tenant=space)
        }
        self.instruments = {
            str(row.pk): row for row in Instrument.objects.filter(tenant=space)
        }
        debits = list(
            Event.objects.filter(
                _active_at(self.when),
                tenant=space,
                kind="fund_debit",
                economic_date__lte=self.when,
            ).order_by("economic_date", "created_at", "pk")
        )
        debit_ids = [row.pk for row in debits]
        funding_links = {
            str(row.related_id): row.payload.get("account_id")
            for row in Event.objects.filter(
                _active_at(self.when),
                tenant=space,
                kind="fund_funding",
                related_id__in=debit_ids,
                economic_date__lte=self.when,
            )
        }
        remaining = defaultdict(lambda: ZERO)
        original = defaultdict(lambda: ZERO)
        sources = defaultdict(set)
        currencies = defaultdict(set)
        # Use posted decimal amounts, including confirmations' exact tail
        # adjustments. Payload amount - quantity * NAV would lose those cents.
        for line in JournalLine.objects.filter(
            Q(event_id__in=debit_ids) | Q(event__related_id__in=debit_ids),
            _active_at(self.when, "event__"),
            tenant=space,
            code="fund_transit",
            event__economic_date__lte=self.when,
        ).select_related("event"):
            root = str(
                line.event_id
                if line.event.kind == "fund_debit"
                else line.event.related_id
            )
            remaining[root] += line.amount
            if line.event.kind == "fund_debit":
                original[root] += line.amount
                sources[root].add(str(line.account_id))
                currencies[root].add(line.currency)
        movements = defaultdict(list)
        for row in PositionMovement.objects.filter(
            _active_at(self.when, "event__"),
            tenant=space,
            event__kind="fund_confirm",
            event__related_id__in=debit_ids,
            event__economic_date__lte=self.when,
        ).select_related("event"):
            movements[str(row.event.related_id)].append(row)
        registries = defaultdict(list)
        for row in Resource.objects.filter(tenant=space, kind="dca_import_periods"):
            registries[row.data.get("debit_event_id")].append(row.data)
        occurrences = {
            str(row.event_id): row
            for row in Occurrence.objects.filter(tenant=space, event_id__in=debit_ids)
        }
        self.rates = {}
        for row in FxRate.objects.filter(
            tenant=space,
            purpose="valuation",
            economic_date__lte=self.when,
        ).order_by("-economic_date", "-created_at"):
            if row.rate > ZERO:
                self.rates.setdefault((row.base, row.quote), row)
        self.items = []
        for debit in debits:
            ident = str(debit.pk)
            amount = remaining[ident]
            if amount <= ZERO:
                continue
            source_id = next(iter(sources[ident])) if len(sources[ident]) == 1 else None
            currency = (
                next(iter(currencies[ident]))
                if len(currencies[ident]) == 1
                else debit.payload.get("currency", space.base_currency)
            )
            source = self.accounts.get(source_id)
            registered = registries[ident]
            confirmations = movements[ident]
            iid = debit.payload.get("instrument_id")
            instrument_ids = {iid} if iid else set()
            instrument_ids.update(
                row.get("instrument_id")
                for row in registered
                if row.get("instrument_id")
            )
            instrument_ids.update(str(row.instrument_id) for row in confirmations)
            iid = next(iter(instrument_ids)) if len(instrument_ids) == 1 else None
            instrument = self.instruments.get(iid)
            targets = set()
            if debit.payload.get("holding_account_id"):
                targets.add(debit.payload["holding_account_id"])
            invalid = len(instrument_ids) > 1 or len(sources[ident]) != 1
            for row in registered:
                if row.get("funding_account_id") not in (None, source_id) or row.get(
                    "instrument_id"
                ) not in (None, iid):
                    invalid = True
                if row.get("holding_account_id"):
                    targets.add(row["holding_account_id"])
            targets.update(str(row.account_id) for row in confirmations)
            holding_id = next(iter(targets)) if len(targets) == 1 else None
            holding = self.accounts.get(holding_id)
            if (
                invalid
                or len(targets) > 1
                or (holding_id and not holding)
                or (holding and holding.currency != currency)
                or (instrument and instrument.currency != currency)
            ):
                holding_id, holding, target_status = None, None, "conflict"
            else:
                target_status = "assigned" if holding and instrument else "unassigned"
                if not instrument:
                    holding_id, holding = None, None
            occurrence = occurrences.get(ident)
            data = registered[0] if len(registered) == 1 else {}
            scheduled = (
                debit.payload.get("dca_import_date")
                or data.get("scheduled_date")
                or (str(occurrence.due_date) if occurrence else None)
            )
            state = (occurrence.details.get("automation") or {}) if occurrence else {}
            expected = state.get("confirmation_date") or debit.payload.get(
                "expected_confirmation_date"
            )
            if not expected and instrument:
                # This is only a calendar forecast, never evidence of confirmed
                # shares. The date helper is local, bounded, and performs no IO.
                from .trading_calendar import preview_trade_dates

                try:
                    expected = preview_trade_dates(
                        {
                            "instrument": {
                                "name": instrument.name,
                                "code": instrument.code,
                                "kind": instrument.kind,
                                "market": instrument.market,
                                "currency": instrument.currency,
                                "specification": instrument.specification,
                            },
                            "application_date": str(debit.economic_date),
                        }
                    )["expected_confirmation_date"]
                except DomainError:
                    expected = None
            automatic = debit.payload.get("automatic_estimate") is True
            basis = debit.payload.get("entry_basis") or data.get("debit_entry_basis")
            is_dca = bool(
                debit.payload.get("dca_import_plan_id")
                or registered
                or (occurrence and occurrence.details.get("plan_kind") == "dca")
            )
            from .portfolio import _snapshot_account

            snapshot = bool(source and _snapshot_account(source))
            self.items.append(
                {
                    "id": ident,
                    "debit_event_id": ident,
                    "source_account_id": source_id,
                    "source_account_name": source.name if source else None,
                    "holding_account_id": holding_id,
                    "holding_account_name": holding.name if holding else None,
                    "instrument_id": str(instrument.pk) if instrument else None,
                    "instrument_name": instrument.name if instrument else None,
                    "code": instrument.code if instrument else None,
                    "kind": instrument.kind if instrument else None,
                    "amount": amount,
                    "original_amount": original[ident],
                    "currency": currency,
                    "debit_date": debit.economic_date,
                    "scheduled_date": scheduled,
                    "expected_confirmation_date": expected,
                    "confirmation_date_is_forecast": True,
                    "is_dca": is_dca,
                    "entry_basis": basis or "recorded",
                    "funding_source": "account"
                    if ident in funding_links
                    else debit.payload.get("funding_source", "account"),
                    "actual_funding_account_id": funding_links.get(ident)
                    or (None if debit.payload.get("untracked_funding") else source_id),
                    "funding_label": "账外资金（未扣本账簿账户）"
                    if debit.payload.get("untracked_funding")
                    and ident not in funding_links
                    else "本账簿账户扣款",
                    "automatic_estimate": automatic,
                    "target_status": target_status,
                    "valuation_scope": "institution_snapshot" if snapshot else "ledger",
                    "included_in_assets": None if snapshot else True,
                    "added_to_net_assets": False,
                    "message": "持仓账户或产品归属冲突，请核对原始扣款与补录登记。"
                    if target_status == "conflict"
                    else "未明确持仓账户或产品；保留在扣款账户的申购在途中。"
                    if target_status == "unassigned"
                    else "机构权益是否已覆盖该笔在途需核对，本明细不另行加总。"
                    if snapshot
                    else MESSAGE,
                }
            )

    def _exchange(self, currency, target):
        if currency == target:
            return Decimal(1), False
        direct = self.rates.get((currency, target))
        inverse = self.rates.get((target, currency))
        row = direct or inverse
        if not row:
            return None, False
        return (
            row.rate if direct else Decimal(1) / row.rate,
            (self.when - row.economic_date).days > 7,
        )

    def summary(
        self,
        *,
        currency=None,
        source_account_id=None,
        holding_account_id=None,
        instrument_id=None,
        kind=None,
        items=None,
    ):
        currency = currency or self.space.base_currency
        selected = [
            row
            for row in (self.items if items is None else items)
            if (
                source_account_id is None
                or row["source_account_id"] == str(source_account_id)
            )
            and (
                holding_account_id is None
                or row["holding_account_id"] == str(holding_account_id)
            )
            and (instrument_id is None or row["instrument_id"] == str(instrument_id))
            and (kind is None or row["kind"] == kind)
        ]
        known = ZERO
        complete = True
        by_currency = {}
        converted_items = []
        for item in selected:
            native = item["currency"]
            group = by_currency.setdefault(
                native, {"currency": native, "amount": ZERO, "count": 0}
            )
            group["amount"] += item["amount"]
            group["count"] += 1
            rate, stale = self._exchange(native, currency)
            value = item["amount"] * rate if rate is not None else None
            if value is None or stale:
                complete = False
            if value is not None:
                known += value
            converted_items.append(
                {**item, "base_amount": value, "base_currency": currency}
            )
        return {
            "as_of": self.when,
            "currency": currency,
            "amount": known if complete else None,
            "known_amount": known,
            "completeness": "complete" if complete else "partial",
            "count": len(selected),
            "unassigned_count": sum(
                row["target_status"] != "assigned" for row in selected
            ),
            "by_currency": list(by_currency.values()),
            "items": converted_items,
            "included_in_assets": None
            if any(row["included_in_assets"] is None for row in selected)
            else True,
            "added_to_net_assets": False,
            "message": MESSAGE
            if complete
            else MESSAGE + " 部分币种缺少有效汇率，折算金额尚不完整。",
        }


def plans_for_holding(space, queryset, holding_account_id):
    """Filter plans by destination, keeping their funding account independent."""
    targets = defaultdict(set)
    for row in Resource.objects.filter(tenant=space, kind="dca_import_periods"):
        if row.data.get("holding_account_id"):
            targets[row.data.get("plan_id")].add(row.data["holding_account_id"])
    matched = []
    for plan in queryset:
        target = (plan.data.get("automation") or {}).get("holding_account_id")
        if not target:
            historical = targets[str(plan.pk)]
            target = (
                next(iter(historical))
                if len(historical) == 1
                else plan.data.get("account_id")
                if not historical
                else None
            )
        if target == str(holding_account_id):
            matched.append(plan.pk)
    return queryset.filter(pk__in=matched)
