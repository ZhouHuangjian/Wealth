"""Atomic, idempotent-command friendly entry of already executed spot trades."""

from django.db import transaction
from decimal import Decimal, ROUND_HALF_UP, localcontext

from .common import DomainError, day, dec, get_obj, money_round
from .institution_funding import available_funding_cash
from .investments import is_derivative_instrument, validate_investment_account
from .ledger import event_detail, post_event
from .models import Account, Instrument, Workspace

FIELDS = {
    "instrument_id",
    "account_id",
    "cash_account_id",
    "side",
    "economic_date",
    "amount",
    "quantity",
    "price",
    "fee",
    "tax",
    "description",
    "pending",
    "settled",
    "funding_source",
}


@transaction.atomic
def record_trade(space, user, body):
    with localcontext() as context:
        context.prec = 160
        return _record_trade(space, user, body)


def _record_trade(space, user, body):
    if not isinstance(body, dict) or set(body) - FIELDS:
        raise DomainError("买卖记录含不支持的字段")
    Workspace.objects.select_for_update().get(pk=space.pk)
    instrument = get_obj(Instrument, space, body.get("instrument_id"))
    account = get_obj(Account, space, body.get("account_id"))
    validate_investment_account(account, instrument)
    if is_derivative_instrument(instrument):
        raise DomainError(
            "期货期权按机构权益和结算记录管理，不能按全额持仓扣款",
            "derivative_snapshot_required",
        )
    if body.get("side") not in {"buy", "sell"}:
        raise DomainError("请选择买入或卖出")
    when = day(body.get("economic_date"))
    if when > day():
        raise DomainError("请记录已发生的交易；未来买卖请使用计划")
    pending = body.get("pending", False)
    settled = body.get("settled", True)
    if type(pending) is not bool or type(settled) is not bool:
        raise DomainError("确认与到账状态须为是或否")
    fund = (
        instrument.kind == "fund"
        and instrument.specification.get("trading_channel") != "exchange"
    )
    buy = body["side"] == "buy"
    funding_source = body.get("funding_source", "account")
    if funding_source not in {"account", "untracked"}:
        raise DomainError("请选择本账簿账户或账外资金")
    if funding_source == "untracked" and not (fund and buy):
        raise DomainError("此入口的账外资金仅用于基金买入")
    if funding_source == "untracked" and body.get("cash_account_id"):
        raise DomainError("账外资金不能同时指定本账簿扣款账户")
    if pending and not (fund and buy):
        raise DomainError("待确认仅用于基金买入扣款")
    if fund and buy and not settled:
        raise DomainError("基金买入请记录实际扣款，尚未扣款请建立计划")
    cash = get_obj(Account, space, body.get("cash_account_id") or account.pk)
    if (
        cash.archived
        or cash.currency != account.currency
        or cash.kind
        in {
            "loan",
            "credit",
            "credit_card",
            "property",
            "future",
            "futures",
            "receivable",
        }
    ):
        raise DomainError("请选择相同币种的可用现金账户")
    fee, tax = (
        dec(body.get(key, "0"), nonnegative=True, places=2) for key in ("fee", "tax")
    )
    if fund and buy and tax:
        raise DomainError("基金申购费用请计入手续费")
    if pending:
        if any(
            body.get(key) not in (None, "", "0", 0)
            for key in ("quantity", "price", "fee", "tax")
        ):
            raise DomainError("待确认申购只记实际扣款，份额、净值和费用待确认后再填")
        amount = dec(body.get("amount"), nonnegative=True, places=2)
    else:
        quantity, price = (
            dec(body.get(key), nonnegative=True, places=18)
            for key in ("quantity", "price")
        )
        if quantity <= 0 or price <= 0:
            raise DomainError("成交份额与价格须大于零")
        gross = money_round(quantity * price)
        calculated = gross + fee + tax if buy else gross - fee - tax
        amount = (
            dec(body["amount"], nonnegative=True, places=2)
            if body.get("amount") not in (None, "")
            else calculated.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        )
    if amount <= 0:
        raise DomainError("交易金额须大于零")
    if (
        buy
        and settled
        and funding_source != "untracked"
        and available_funding_cash(space, cash, when) < amount
    ):
        raise DomainError(
            "付款账户可用资金不足，请选择实际付款账户或先记录转入资金",
            "insufficient_source_cash",
        )
    common = {
        "instrument_id": str(instrument.pk),
        "currency": account.currency,
        "economic_date": str(when),
        "description": str(body.get("description") or ""),
    }
    events = []
    if fund and buy:
        debit = post_event(
            space,
            user,
            {
                **common,
                "kind": "fund_debit",
                "account_id": str(cash.pk),
                "amount": str(amount),
                "holding_account_id": str(account.pk),
            },
            _untracked_funding=funding_source == "untracked",
        )
        events.append(debit)
        if not pending:
            events.append(
                post_event(
                    space,
                    user,
                    {
                        **common,
                        "kind": "fund_confirm",
                        "account_id": str(account.pk),
                        "related_event_id": str(debit.pk),
                        "quantity": str(quantity),
                        "price": str(price),
                        "fee": str(fee),
                        "rounding_confirmed": True,
                    },
                    _fund_confirmation={
                        "confirmed_amount": str(amount),
                        "rounding_adjustment": str(amount - calculated),
                    },
                )
            )
    else:
        trade = post_event(
            space,
            user,
            {
                **common,
                "kind": "buy" if buy else "fund_redeem" if fund else "sell",
                "account_id": str(account.pk),
                "quantity": str(quantity),
                "price": str(price),
                "fee": str(fee),
                "tax": str(tax),
            },
            _spot_confirmation=str(amount),
        )
        events.append(trade)
        if settled:
            events.append(
                post_event(
                    space,
                    user,
                    {
                        **common,
                        "kind": "settlement",
                        "account_id": str(cash.pk),
                        "related_event_id": str(trade.pk),
                    },
                )
            )
    return {
        "items": [event_detail(event) for event in events],
        "pending": pending,
        "data_revision": space.revision,
    }


@transaction.atomic
def confirm_fund_trade(space, user, body):
    """Confirm a paid order with its actual amount and a bounded share-rounding difference."""
    if body.get("kind") != "fund_confirm":
        raise DomainError("此入口仅用于基金份额确认")
    Workspace.objects.select_for_update().get(pk=space.pk)
    with localcontext() as context:
        context.prec = 160
        if day(body.get("economic_date")) > day():
            raise DomainError("请在机构实际确认后记录份额")
        qty = dec(body.get("quantity"), nonnegative=True, places=18)
        price = dec(body.get("price"), nonnegative=True, places=18)
        fee = dec(body.get("fee", "0"), nonnegative=True)
        calculated = money_round(qty * price + fee)
        amount = (
            dec(body["amount"], nonnegative=True)
            if body.get("amount") not in (None, "")
            else calculated
        )
        if amount == calculated:
            event = post_event(space, user, body)
        else:
            event = post_event(
                space,
                user,
                {**body, "rounding_confirmed": True},
                _fund_confirmation={
                    "confirmed_amount": str(amount),
                    "rounding_adjustment": str(amount - calculated),
                },
            )
        return event_detail(event)
