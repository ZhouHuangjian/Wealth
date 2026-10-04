"""Account-list amounts, keeping institution equity separate from ledger cash."""

from .common import day, serial
from .ledger import balance
from .portfolio import _institution_value, _snapshot_account


def account_balance_projection(space, account, when=None):
    """Read the account amount without posting an opening or valuing it twice.

    Detailed accounts keep their existing journal-based book amount. An
    institution statement already covers positions and margin, so it replaces
    that amount instead of being added to cash or individual holdings. The
    independent cash_balance field remains the sum of actual cash journal lines.
    """
    when = day(when)
    cash = balance(space, account, "cash", as_of=when)
    if not _snapshot_account(account):
        return serial(
            {
                "balance": balance(space, account, as_of=when),
                "cash_balance": cash,
                "balance_basis": "ledger",
                "balance_label": "账面金额",
                "balance_as_of": when,
                "balance_status": "complete",
                "balance_message": "按已记录分录合计，包含资金、在途及持仓账面成本；不等同于持仓实时市值或可提取金额。",
            }
        )
    value = _institution_value(space, account, when, prefer_reference=True)
    known_cash_only = value["basis"] == "recorded_cash"
    gaps = value["gaps"]
    status = (
        "missing" if value["local_value"] is None else "partial" if gaps else "complete"
    )
    return serial(
        {
            "balance": value["local_value"],
            "cash_balance": cash,
            "balance_basis": value["basis"],
            "balance_label": "已记录资金"
            if known_cash_only
            else "盘中权益"
            if value["basis"] == "institution_estimate"
            else "待核对权益"
            if value["basis"] == "institution_unknown"
            else "机构总权益",
            "balance_as_of": value["date"],
            "balance_status": status,
            "balance_message": "；".join(gaps)
            if gaps
            else "机构权益已包含持仓及保证金，结合之后可核对的资金收支列示；不是现金余额或可提取金额。",
        }
    )
