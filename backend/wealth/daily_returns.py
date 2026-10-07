"""Read-only, cashflow-adjusted daily observations, never cumulative P&L.

Batch-load the evidence once. Native-currency investment returns are converted
at the day's valuation rate; changes in FX and household cash balances are not
investment earnings. Dates remain market dates, including lagged QDII NAVs.
"""

from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .common import day, serial
from .market_quality import approved_prices, nav_quarantine
from .models import (
    Event,
    FxRate,
    JournalLine,
    PositionMovement,
    Price,
    Resource,
)
from .reporting import FORMAL_PRICE_KINDS
from .return_dates import analytical_movement

ZERO = Decimal(0)
CURRENCY_POLICY = "local_profit_converted_daily_excludes_fx"
EXTERNAL_FLOWS = {"transfer", "fx", "income", "expense", "refund"}


from .valuation_calendar import return_calendar
from .valuation_calendar import valuation_calendar as _calendar_id


def _continuous_baseline(start, end, calendar_id):
    """A missing intervening open day would turn a daily return into several days."""
    from .trading_calendar import is_trading_day

    cursor = start + timedelta(days=1)
    while cursor < end:
        if not calendar_id or is_trading_day(cursor, calendar_id) is not False:
            return False
        cursor += timedelta(days=1)
    return True


def _unavailable(item, message):
    return {
        **item,
        "amount": None,
        "return_rate": None,
        "basis": None,
        "status": "unavailable",
        "message": message,
    }


class ReturnEvidence:
    def __init__(self, space, when, *, account_id=None, instrument_id=None, kind=None):
        from .account_opening import effective_snapshots
        from .investments import _corporate_actions, _selected_rows

        self.space, self.when = space, when
        self.accounts, self.instruments = _selected_rows(
            space, account_id, instrument_id, kind
        )
        self.movements = defaultdict(list)
        self.movements_by_event = defaultdict(list)
        # Retrospective analytics can use confirmations already known now, with
        # their actual NAV dates. Cash/in-transit and future openings stay intact.
        known_on = timezone.localdate()
        for row in (
            PositionMovement.objects.filter(
                tenant=space,
                account_id__in=self.accounts,
                instrument_id__in=self.instruments,
                event__reversal__isnull=True,
                event__reverses__isnull=True,
            )
            .filter(
                Q(event__economic_date__lte=when)
                | Q(event__kind="fund_confirm", event__economic_date__lte=known_on)
            )
            .select_related("event__related")
            .order_by("event__economic_date", "event__created_at")
        ):
            event = row.event
            value = analytical_movement(
                row, self.instruments[str(row.instrument_id)], known_on=known_on
            )
            if value["date"] > when:
                continue
            self.movements[(str(row.account_id), str(row.instrument_id))].append(value)
            self.movements_by_event[str(event.pk)].append(value)
        self.formal, self.reference = defaultdict(list), defaultdict(list)
        from .investments import REFERENCE_KINDS

        self.nav_quarantines = nav_quarantine(space)
        for quote in approved_prices(
            Price.objects.filter(
                tenant=space,
                instrument_id__in=self.instruments,
                economic_date__lte=when,
                kind__in=FORMAL_PRICE_KINDS | REFERENCE_KINDS,
            ),
            space,
            quarantines=self.nav_quarantines,
        ).order_by("economic_date", "created_at"):
            target = self.formal if quote.kind in FORMAL_PRICE_KINDS else self.reference
            target[str(quote.instrument_id)].append(quote)
        self.states, self.actions, self.checks = {}, {}, defaultdict(list)
        self.option_versions = defaultdict(list)
        dividend_links = defaultdict(set)
        resources = list(
            Resource.objects.filter(
                tenant=space,
                kind__in=[
                    "market_quotes",
                    "holding_checks",
                    "dividend_candidates",
                    "option_positions",
                ],
            ).order_by("-created_at")
        )
        # Only option revisions need historical recall; this is a single query.
        from .models import ResourceRevision

        versions = defaultdict(list)
        for revision in ResourceRevision.objects.filter(
            tenant=space,
            resource_id__in=[r.pk for r in resources if r.kind == "option_positions"],
        ):
            versions[str(revision.resource_id)].append(
                (revision.version, revision.data)
            )
        for resource in resources:
            data = resource.data
            if resource.kind == "market_quotes":
                iid = data.get("instrument_id")
                self.states.setdefault(iid, data)
                self.actions.setdefault(iid, _corporate_actions(data))
            elif resource.kind == "holding_checks":
                self.checks[(data.get("account_id"), data.get("instrument_id"))].append(
                    data
                )
            elif (
                resource.kind == "dividend_candidates"
                and data.get("status") == "confirmed"
                and data.get("event_id")
            ):
                dividend_links[data["event_id"]].add(
                    (data.get("account_id"), data.get("instrument_id"))
                )
            elif resource.kind == "option_positions":
                self.option_versions[data.get("account_id")].append(
                    [*versions[str(resource.pk)], (resource.version, data)]
                )
        self.dividends = defaultdict(list)
        for event in Event.objects.filter(
            tenant=space,
            kind="dividend",
            economic_date__lte=when,
            reversal__isnull=True,
            reverses__isnull=True,
        ):
            aid, iid = (
                event.payload.get("account_id"),
                event.payload.get("instrument_id"),
            )
            links = dividend_links.get(str(event.pk), set())
            if not iid and len(links) == 1:
                linked_aid, linked_iid = next(iter(links))
                if aid == linked_aid:
                    iid = linked_iid
            if aid in self.accounts and iid in self.instruments:
                self.dividends[(aid, iid)].append(event)
                self.movements.setdefault((aid, iid), [])
        self.snapshots, self.flows = defaultdict(list), defaultdict(list)
        from .investments import DERIVATIVES

        self.snapshot_accounts = {
            aid: account
            for aid, account in self.accounts.items()
            if account.valuation_mode == "snapshot" or account.kind in DERIVATIVES
        }
        if not instrument_id and (not kind or kind in DERIVATIVES):
            for row in (
                effective_snapshots(space)
                .filter(
                    account_id__in=self.snapshot_accounts,
                    economic_date__lte=when,
                )
                .order_by("economic_date", "created_at")
            ):
                self.snapshots[str(row.account_id)].append(row)
            for line in (
                JournalLine.objects.filter(
                    tenant=space,
                    account_id__in=self.snapshot_accounts,
                    code="cash",
                    event__economic_date__lte=when,
                    event__reversal__isnull=True,
                    event__reverses__isnull=True,
                )
                .exclude(event__kind="opening")
                .select_related("event")
            ):
                self.flows[str(line.account_id)].append(line)
        else:
            self.snapshot_accounts = {}
        self.fx_rows = list(
            FxRate.objects.filter(
                tenant=space,
                purpose="valuation",
                economic_date__lte=when,
            ).order_by("-economic_date", "-created_at")
        )

    def read_check(self, space, account, instrument, quantity, when, opening=None):
        """Same unchanged-original-holding scope as read_holding_check, in memory."""
        key = (str(account.pk), str(instrument.pk))
        for data in self.checks[key]:
            eid = data.get("opening_event_id")
            if opening is not None and eid != str(getattr(opening, "pk", opening)):
                continue
            source_moves = self.movements_by_event[eid]
            if len(source_moves) != 1:
                continue
            move = source_moves[0]
            source = move["event"]
            if (
                source.kind != "opening"
                or source.payload.get("opening_source") != "existing_holding"
                or source.economic_date > when
                or move["quantity"] <= 0
                or move["quantity"] != quantity
                or source.payload.get("account_id") != key[0]
                or source.payload.get("instrument_id") != key[1]
                or day(data["as_of"]) != source.economic_date
            ):
                continue
            if any(
                row["event"].pk != source.pk
                and row["event"].economic_date <= when
                and (
                    row["created_at"] > source.created_at
                    or row["event"].economic_date >= source.economic_date
                )
                for row in self.movements[key]
            ):
                continue
            return data
        return None

    def option_active(self, account_id, when):
        for versions in self.option_versions[account_id]:
            eligible = [
                (version, data)
                for version, data in versions
                if day(
                    data.get("closed_date")
                    if data.get("status") == "closed" and data.get("closed_date")
                    else data["as_of"]
                )
                <= when
            ]
            if (
                eligible
                and max(eligible, key=lambda item: item[0])[1].get("status") == "active"
            ):
                return True
        return False

    def spot(self, key, when, *, estimated=False):
        from .investments import _calendar_item

        aid, iid = key
        account, instrument = self.accounts[aid], self.instruments[iid]
        formal = self.formal[iid]
        formal_today = next(
            (q for q in reversed(formal) if q.economic_date == when), None
        )
        reference = (
            next(
                (q for q in reversed(self.reference[iid]) if q.economic_date == when),
                None,
            )
            if estimated and not formal_today
            else None
        )
        quotes = [q for q in formal if q.economic_date <= when]
        if reference:
            quotes.append(reference)
        item = _calendar_item(
            self.space,
            account,
            instrument,
            self.movements[key],
            quotes,
            self.dividends[key],
            when,
            self.actions.get(iid, []),
            check_reader=self.read_check,
        )
        if item is None:
            return None
        if str(when) in self.nav_quarantines.get(iid, {}):
            return _unavailable(item, "本日正式净值来源存在差异，暂停收益计算")
        item.update(
            observation_kind="reference" if reference else "formal",
            price_basis="estimate" if reference else "formal",
            return_date=when,
        )
        observed_quote = reference or (quotes[-1] if quotes else None)
        if observed_quote:
            item.setdefault("price_date", observed_quote.economic_date)
            item["source"] = item.get("source") or observed_quote.source
            item["latest_observation_date"] = observed_quote.economic_date
            item["nav_date"] = (
                observed_quote.economic_date
                if not reference and instrument.kind == "fund"
                else None
            )
            item["published_at"] = observed_quote.published_at
            item["observed_at"] = observed_quote.created_at
        if any(
            move["date"] == when
            and move["event"].kind == "opening"
            and not move["reconstructed"]
            for move in self.movements[key]
        ):
            return _unavailable(item, "本日仅录入期初持仓，尚缺可核对的前一日持仓基准")
        if item["amount"] is None:
            return item
        if item.get("interval_start") and not _continuous_baseline(
            day(item["interval_start"]),
            when,
            return_calendar(instrument, estimated=bool(reference)),
        ):
            return _unavailable(
                item, "上一报价与本日之间缺少交易日行情，不能当作单日收益"
            )
        if reference:
            from .trading_calendar import is_trading_day

            if is_trading_day(when, _calendar_id(instrument)) is not True:
                return _unavailable(
                    item, "本日休市或交易日历未核实，估值不作为今日收益"
                )
            state = self.states.get(iid, {})
            if (
                state.get("refresh_status") == "failed"
                or (state.get("quote") or {}).get("status") == "stale"
            ):
                return _unavailable(item, "行情刷新失败或已经过期，待更新")
            stamp = state.get("fetched_at")
            try:
                observed = parse_datetime(stamp) if isinstance(stamp, str) else None
            except (TypeError, ValueError):
                observed = None
            if observed and timezone.is_naive(observed):
                observed = timezone.make_aware(observed)
            if (
                when == timezone.localdate()
                and observed
                and (timezone.now() - observed).total_seconds() > 600
            ):
                return _unavailable(item, "盘中行情超过更新时间，待更新")
            item["status"] = "estimated"
        return item

    def snapshot(self, aid, when, *, estimated=False):
        account, rows = self.snapshot_accounts[aid], self.snapshots[aid]
        base = {
            "account_id": aid,
            "account_name": account.name,
            "instrument_id": None,
            "name": account.name,
            "code": "",
            "kind": "account",
            "scope": "account",
            "currency": account.currency,
            "date": str(when),
            "return_date": when,
            "amount": None,
            "return_rate": None,
            "status": "unavailable",
            "source": "institution_snapshot",
            "message": "缺少该日与上一有效结算权益",
            "price_date": rows[-1].economic_date if rows else None,
            "latest_observation_date": rows[-1].economic_date if rows else None,
        }
        from .recording_coverage import coverage

        if coverage(self.space, account)["recording_mode"] == "balance":
            return _unavailable(
                base, "此账户只记录余额；余额变化可能包含追加资金，不能认定为收益"
            )
        formal = [
            s
            for s in rows
            if s.details.get("valuation_basis") not in {"intraday", "unknown"}
        ]
        current = next((s for s in reversed(formal) if s.economic_date == when), None)
        if current is None and estimated:
            current = next(
                (
                    s
                    for s in reversed(rows)
                    if s.economic_date == when
                    and s.details.get("valuation_basis") == "intraday"
                ),
                None,
            )
        previous = next((s for s in reversed(formal) if s.economic_date < when), None)
        if not current and previous and rows[-1].pk == previous.pk:
            # A verified, cash-only account needs no invented daily settlement.
            # Reuse the same exposure/flow checks as the account valuation; this
            # is explicitly an assumption, not an institution's new statement.
            from .availability import RESTRICTED_KEYS, _zero
            from .portfolio import _institution_value

            unrestricted = not account.frozen and all(
                _zero(previous.details.get(key)) for key in RESTRICTED_KEYS
            )
            if unrestricted and previous.currency == account.currency:
                carried = _institution_value(self.space, account, when)
                if carried.get("cash_only_carry_forward") and not carried["gaps"]:
                    changes = [
                        line
                        for line in self.flows[aid]
                        if line.event.economic_date == when
                    ]
                    capital = sum(
                        (
                            line.amount
                            for line in changes
                            if line.event.kind in EXTERNAL_FLOWS
                        ),
                        ZERO,
                    )
                    dividends = sum(
                        (
                            line.amount
                            for line in changes
                            if line.event.kind == "dividend"
                        ),
                        ZERO,
                    )
                    opening = carried["local_value"] - sum(
                        (line.amount for line in changes), ZERO
                    )
                    basis = opening + sum(
                        (
                            max(line.amount, ZERO)
                            for line in changes
                            if line.event.kind in EXTERNAL_FLOWS
                        ),
                        ZERO,
                    )
                    return {
                        **base,
                        "amount": dividends,
                        "basis": basis,
                        "return_rate": dividends / basis if basis > ZERO else None,
                        "capital_flow": capital,
                        "dividends": dividends,
                        "status": "estimated",
                        "source": "cash_only_carry_forward",
                        "price_basis": "estimate",
                        "observation_kind": "reference",
                        "quantity_source": "no_recorded_positions",
                        "cash_only_carry_forward": True,
                        "settlement_pnl": ZERO,
                        "published_at": None,
                        "observed_at": previous.details.get("valuation_observed_at")
                        or previous.created_at,
                        "interval_start": when - timedelta(days=1),
                        "message": "无已记录持仓，按资金流水延续；结算盈亏按 0 推算"
                        if not dividends
                        else "仅含已记录分红；无持仓期间的结算盈亏按 0 推算",
                    }
        if not current or not previous:
            return base
        base.update(
            price_date=current.economic_date,
            interval_start=previous.economic_date,
            observation_kind="reference"
            if current.details.get("valuation_basis") == "intraday"
            else "formal",
            published_at=current.details.get("published_at"),
            observed_at=current.details.get("valuation_observed_at")
            or current.created_at,
        )
        calendar_id = current.details.get("calendar_id") or previous.details.get(
            "calendar_id"
        )
        if not _continuous_baseline(previous.economic_date, when, calendar_id):
            return _unavailable(base, "结算权益之间缺少交易日记录，不能当作单日收益")
        for snapshot in (previous, current):
            if (
                not snapshot.complete
                or snapshot.currency != account.currency
                or snapshot.includes_options is None
                or (
                    snapshot.includes_options is False
                    and (
                        snapshot.details.get("no_option_positions") is not True
                        or self.option_active(aid, snapshot.economic_date)
                    )
                )
            ):
                return _unavailable(base, "机构权益包含范围尚未核实")
            relevant = [
                line
                for line in self.flows[aid]
                if rows[0].economic_date
                <= line.event.economic_date
                <= snapshot.economic_date
            ]
            if any(
                str(line.event_id) not in snapshot.included_event_ids
                for line in relevant
            ):
                return _unavailable(base, "机构权益未核对实际资金流水的包含范围")
        period = [
            line
            for line in self.flows[aid]
            if previous.economic_date < line.event.economic_date <= when
            and line.event.kind in EXTERNAL_FLOWS
        ]
        capital = sum((line.amount for line in period), ZERO)
        basis = previous.equity + sum((max(line.amount, ZERO) for line in period), ZERO)
        amount = current.equity - previous.equity - capital
        return {
            **base,
            "amount": amount,
            "basis": basis,
            "return_rate": amount / basis if basis > 0 else None,
            "capital_flow": capital,
            "message": "",
            "status": "estimated"
            if current.details.get("valuation_basis") == "intraday"
            else "confirmed",
        }

    def convert(self, item, currency):
        if item is None:
            return None
        item = dict(item)
        item["instrument_name"] = item["name"] if item.get("instrument_id") else None
        when, native = day(item["date"]), item["currency"]
        chosen, inverse = None, False
        if native == currency:
            rate, fx_date, source = Decimal(1), when, "same_currency"
        else:
            for base, quote, reverse in [
                (native, currency, False),
                (currency, native, True),
            ]:
                chosen = next(
                    (
                        r
                        for r in self.fx_rows
                        if r.base == base
                        and r.quote == quote
                        and r.economic_date <= when
                        and r.rate > 0
                    ),
                    None,
                )
                if chosen:
                    inverse = reverse
                    break
            rate = (
                (Decimal(1) / chosen.rate if inverse else chosen.rate)
                if chosen
                else None
            )
            fx_date, source = (
                (chosen.economic_date, chosen.source) if chosen else (None, None)
            )
        item.update(
            base_currency=currency,
            fx_date=fx_date,
            fx_source=source,
            base_amount=None,
            base_basis=None,
        )
        if item["amount"] is not None:
            if rate is None or (when - fx_date).days > 7:
                item["status"] = "unavailable"
                item["message"] = "缺少可用折算汇率；原币收益保留"
            else:
                item["base_amount"] = item["amount"] * rate
                item["base_basis"] = item.get("basis", ZERO) * rate
        return item


def daily_return_overview(
    space, when=None, currency=None, *, account_id=None, instrument_id=None, kind=None
):
    """Return a shared overview and per-holding observations with fixed query count."""
    when, currency = day(when), currency or space.base_currency
    evidence = ReturnEvidence(
        space, when, account_id=account_id, instrument_id=instrument_id, kind=kind
    )
    items, holding_items = [], {}
    for key in evidence.movements:
        aid, iid = key
        # Whole-account equity already contains these products; never double count.
        if (
            aid in evidence.snapshot_accounts
            or evidence.accounts[aid].valuation_mode == "snapshot"
        ):
            continue
        today = evidence.convert(evidence.spot(key, when, estimated=True), currency)
        dates = sorted({q.economic_date for q in evidence.formal[iid]}, reverse=True)
        latest = None
        for observed_day in dates:
            latest = evidence.convert(evidence.spot(key, observed_day), currency)
            if latest is not None:
                break
        holding_items[key] = {"daily_return": today, "latest_confirmed_return": latest}
        if today:
            # Latest formal NAV returns may be delayed. They are context only;
            # the summary below still aggregates the requested date exclusively.
            today["latest_formal_return"] = latest
            items.append(today)
    for aid in evidence.snapshot_accounts:
        if (
            evidence.snapshots[aid]
            or evidence.flows[aid]
            or evidence.option_active(aid, when)
        ):
            items.append(
                evidence.convert(evidence.snapshot(aid, when, estimated=True), currency)
            )
    from .investments import DERIVATIVES

    if not instrument_id and (not kind or kind in DERIVATIVES):
        for aid, account in evidence.accounts.items():
            if aid not in evidence.snapshot_accounts and evidence.option_active(
                aid, when
            ):
                items.append(
                    {
                        "account_id": aid,
                        "account_name": account.name,
                        "instrument_id": None,
                        "name": account.name + "期权参考持仓",
                        "scope": "option_reference",
                        "kind": "option",
                        "currency": account.currency,
                        "date": str(when),
                        "amount": None,
                        "base_amount": None,
                        "return_rate": None,
                        "status": "unavailable",
                        "source": "option_position_reference",
                        "message": "期权参考市值不是结算收益，尚缺包含期权的机构权益",
                    }
                )
    known = [item for item in items if item["base_amount"] is not None]
    complete = bool(items) and len(known) == len(items)
    amount = sum((item["base_amount"] for item in known), ZERO) if known else None
    basis = sum((item.get("base_basis") or ZERO for item in known), ZERO)
    summary = {
        "date": when,
        "currency": currency,
        "amount": amount if complete else None,
        "known_amount": amount,
        "return_rate": amount / basis if complete and basis > 0 else None,
        "status": (
            "estimated"
            if any(item["status"] == "estimated" for item in items)
            else "confirmed"
        )
        if complete
        else "partial"
        if known
        else "unavailable"
        if items
        else "no_position",
        "known_count": len(known),
        "total_count": len(items),
        "missing_count": len(items) - len(known),
        "items": items,
        "currency_policy": CURRENCY_POLICY,
        "knowledge_basis": "currently_recorded_facts",
        "message": "按今日有效行情与上一有效收盘或结算记录计算，扣除实际净投入；不含家庭收支、申购在途本金和独立汇兑损益。缺失行情不按零收益处理。",
    }
    return serial(summary), {key: serial(value) for key, value in holding_items.items()}
