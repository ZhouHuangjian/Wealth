"""Product subscription calendars for plans; never evidence of executed orders.

Local fund application dates are kept as dates in the fund's market, rather than
shifted into the previous US civil day. A foreign holiday only applies to funds
whose rule or identified investment market calls for it, not every QDII/ETF.
"""

import re
from datetime import timedelta

from .common import DomainError
from .trading_calendar import calendar_info, is_trading_day, parse_date

JPM_NASDAQ = (
    "https://www.cifm.com/fund/019172/announce/202601/P020260108659599256222.pdf"
)
JPM_SP500 = (
    "https://www.cifm.com/fund/017641/announce/202601/P020260108660207486120.pdf"
)
GF_NASDAQ = "https://www.gffunds.com.cn/jjgg/flwj/202501/P020250127545385669645.pdf"
KNOWN_US_FUNDS = {
    **dict.fromkeys(["019172", "019173", "019174", "019175"], JPM_NASDAQ),
    **dict.fromkeys(["017641", "019305", "017642", "017643"], JPM_SP500),
    **dict.fromkeys(["270042", "006479", "021778", "000055", "006480"], GF_NASDAQ),
}
NAMES = {
    "CN_EXCHANGE": "境内市场",
    "CN_FUTURES": "境内期货",
    "HKEX": "香港市场",
    "US_EQUITIES": "美国市场",
}
MODES = {
    "domestic": (["CN_EXCHANGE"], "境内基金交易日"),
    "cn_us": (["CN_EXCHANGE", "US_EQUITIES"], "境内与美国共同开放日"),
    "cn_hk": (["CN_EXCHANGE", "HKEX"], "境内与香港共同开放日"),
}


def subscription_rule(instrument):
    get = (
        instrument.get
        if isinstance(instrument, dict)
        else lambda key, default=None: getattr(instrument, key, default)
    )
    spec = get("specification", {}) or {}
    mode = spec.get("subscription_calendar", "auto") or "auto"
    if mode not in {"auto", *MODES}:
        raise DomainError("申购日历请选择自动识别、境内、中美或中港共同开放日")
    kind, market = get("kind"), get("market", "CN")
    base = (
        (spec.get("metadata_overrides") or {}).get("calendar_id")
        or spec.get("calendar_id")
        or {
            "CN": "CN_EXCHANGE",
            "US": "US_EQUITIES",
            "HK": "HKEX",
        }.get(market, "UNKNOWN")
    )
    calendars, label, status, sources = (
        [base],
        NAMES.get(base, "待识别市场"),
        "market",
        [],
    )
    # Listed ETFs follow their listing exchange; a US underlying does not close
    # their Chinese secondary market. Only off-exchange fund orders intersect.
    if kind == "fund" and spec.get("trading_channel") != "exchange":
        if mode != "auto":
            calendars, label = MODES[mode]
            status = "manual"
        elif market == "CN":
            code = str(get("code", ""))
            name = re.sub(r"\s+", "", str(get("name", ""))).upper()
            known = KNOWN_US_FUNDS.get(code)
            if known or re.search(
                r"纳斯达克|纳指|标普500|S&P500|NASDAQ|美国|道琼斯", name
            ):
                calendars, label = MODES["cn_us"]
                status = "product_rule" if known else "inferred"
                sources = [known] if known else []
    for calendar_id in calendars:
        sources.extend(calendar_info(calendar_id)["sources"])
    return {
        "mode": mode,
        "calendar_ids": calendars,
        "label": label,
        "status": status,
        "sources": list(dict.fromkeys(sources)),
        "scope": "scheduled_subscriptions_not_execution",
        "message": "休市日自动跳过，下一开放日继续；临时暂停、限购和扣款失败仍按基金公告或实际记录排除。",
    }


def subscription_day(value, instrument=None, *, rule=None):
    rule = rule or subscription_rule(instrument)
    checks = [(key, is_trading_day(value, key)) for key in rule["calendar_ids"]]
    closed = [key for key, opened in checks if opened is False]
    unknown = [key for key, opened in checks if opened is None]
    return {
        "is_open": False if closed else None if unknown else True,
        "status": "closed" if closed else "unknown" if unknown else "open",
        "reason": "、".join(NAMES.get(key, key) for key in closed) + "休市，自动跳过"
        if closed
        else "日历尚未核实，待确认"
        if unknown
        else "",
        "calendar_ids": rule["calendar_ids"],
    }


def next_subscription_day(value, rule, include_current=True):
    when = parse_date(value) + timedelta(days=0 if include_current else 1)
    for _ in range(370):
        opened = subscription_day(when, rule=rule)["is_open"]
        if opened is True:
            return when
        if opened is None:
            return None
        when += timedelta(days=1)
    return None
