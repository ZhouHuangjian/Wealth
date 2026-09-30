"""Cash allocation when an institution's opening total is itemized into holdings.

This is bookkeeping of an existing balance, never a broker order or automatic
redemption of a cash-management fund. All writers hold the workspace lock.
"""

from decimal import Decimal

from django.db.models import Sum

from .common import DomainError, dec, get_obj, serial
from .models import Account, JournalLine

ZERO = Decimal(0)
CASH_ACCOUNT_KINDS = {"bank", "cash", "wallet", "fund", "broker", "securities"}


def available_funding_cash(space, account, when):
    """Reserve frozen money and every already-recorded later cash use.

    Checking today's balance alone would allow a backdated allocation to spend
    money that had not arrived yet, or make a later historical balance negative.
    """
    if (
        account.archived
        or account.valuation_mode != "detailed"
        or account.kind not in CASH_ACCOUNT_KINDS
    ):
        raise DomainError(
            "资金来源须为同币种、未归档的现金余额账户；现金宝等基金持仓请先按实际赎回记录处理",
            "funding_account_kind",
        )
    rows = JournalLine.objects.filter(tenant=space, account=account, code="cash")
    running = (
        rows.filter(event__economic_date__lte=when).aggregate(v=Sum("amount"))["v"]
        or ZERO
    )
    minimum = running
    later = (
        rows.filter(event__economic_date__gt=when)
        .values("event__economic_date")
        .annotate(value=Sum("amount"))
        .order_by("event__economic_date")
    )
    for point in later:
        running += point["value"]
        minimum = min(minimum, running)
    if minimum < 0:
        raise DomainError(
            "该账户在持仓日期或其后已有负现金余额，请先核对已有流水",
            "negative_funding_balance",
        )
    return max(ZERO, minimum - account.frozen)


def prepare_holding_funding(space, account, data, when, manual_value):
    mode = data.get("funding_mode", "external")
    if mode not in {"allocate", "external"}:
        raise DomainError(
            "已有持仓请选择从机构资金分配或另行补录；真实买入请使用记一笔中的买入或基金份额确认",
            "holding_funding_mode",
        )
    if data.get("funding_instrument_id") or data.get("source_instrument_id"):
        raise DomainError(
            "基金份额不能作为现金直接扣减；现金宝转购须关联实际赎回和申购记录",
            "funding_product_not_cash",
        )
    if mode == "external":
        if data.get("funding_account_id"):
            raise DomainError("另行补录已有持仓不扣资金，请清除补足资金账户")
        return {
            "mode": mode,
            "required": ZERO,
            "available": None,
            "shortfall": ZERO,
            "source_account_id": None,
            "transfer_event_id": None,
            "currency": account.currency,
        }
    if manual_value is None:
        raise DomainError(
            "从机构资金分配须填写当前市值或当前收益，以实际市值拆分机构总额",
            "holding_value_required",
        )
    required = dec(manual_value, nonnegative=True)
    available = available_funding_cash(space, account, when)
    shortfall = max(ZERO, required - available)
    source = None
    if data.get("funding_account_id"):
        source = get_obj(Account, space, data["funding_account_id"])
        if source.pk == account.pk:
            raise DomainError("补足资金账户须与持仓账户不同")
        if source.currency != account.currency:
            raise DomainError(
                "补足资金账户币种不一致，请先记录实际换汇", "funding_currency"
            )
        source_available = available_funding_cash(space, source, when)
        if shortfall > source_available:
            raise DomainError(
                "所选资金账户可用余额不足，未扣款；请核对余额或选择其他资金来源",
                "insufficient_source_cash",
                fields=serial(
                    {
                        "required": shortfall,
                        "available": source_available,
                        "shortfall": shortfall - source_available,
                        "account_id": source.pk,
                    }
                ),
            )
    if shortfall and source is None:
        raise DomainError(
            "机构可用余额不足，请明确选择补足资金账户；系统不会自动选择银行卡",
            "insufficient_institution_cash",
            fields=serial(
                {"required": required, "available": available, "shortfall": shortfall}
            ),
        )
    return {
        "mode": mode,
        "required": required,
        "available": available,
        "shortfall": shortfall,
        "source_account_id": str(source.pk) if source else None,
        "transfer_event_id": None,
        "currency": account.currency,
    }


def transfer_holding_shortfall(space, user, account, when, funding):
    if not funding["shortfall"]:
        return None
    from .ledger import post_event

    transfer = post_event(
        space,
        user,
        {
            "kind": "transfer",
            "account_id": funding["source_account_id"],
            "target_account_id": str(account.pk),
            "economic_date": str(when),
            "amount": str(funding["shortfall"]),
            "fee": "0",
            "description": "按选定资金来源补足机构持仓分配",
            "holding_funding_transfer": True,
        },
    )
    funding["transfer_event_id"] = str(transfer.pk)
    return transfer
