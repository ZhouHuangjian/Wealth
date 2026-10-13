"""Sina public fund reference observations, never accounting/return prices.

The endpoint exposes a reference value and its own NAV baseline. It does not
establish the fund's economic valuation date or coverage of undisclosed holdings.
Keep those limitations explicit instead of treating the Chinese publication date
of an overnight QDII observation as its NAV date. No external project code is used.
"""

import re
from datetime import date, timedelta
from decimal import Decimal
from urllib.parse import urlencode

from . import market_data as md

SOURCE = "新浪财经·基金参考估值"
ENDPOINT = (
    "https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/"
    "FdFundService.getEstimateNetworthPic"
)


def quote(instrument):
    inst = md._instrument(instrument)
    if (
        inst["kind"] != "fund"
        or inst["market"] != "CN"
        or inst["currency"] != "CNY"
        or not re.fullmatch(r"[0-9]{6}", inst["code"])
    ):
        raise md.MarketDataError("unsupported_fund", "参考估值仅支持境内人民币基金代码")
    payload = md._json(
        md._get(
            ENDPOINT + "?" + urlencode({"symbol": inst["code"]}),
            referer="https://finance.sina.com.cn/",
        )
    )
    fetched = md._now()
    result = payload.get("result") if isinstance(payload, dict) else None
    data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(data, dict) or (result.get("status") or {}).get("code") != 0:
        raise md.MarketDataError("estimate_unavailable", "新浪本次未提供该基金参考估值")
    raw_day = str(data.get("worth_date") or "")
    try:
        base_day = (
            date(int(raw_day[:4]), int(raw_day[4:6]), int(raw_day[6:8]))
            if re.fullmatch(r"[0-9]{8}", raw_day)
            else None
        )
    except ValueError:
        base_day = None
    base_nav = md._number(data.get("worth"), positive=True)
    points = data.get("networth")
    if not base_nav or not base_day or not isinstance(points, list) or not points:
        raise md.MarketDataError(
            "estimate_baseline_missing", "参考估值缺少净值基准或报价序列"
        )
    observations = []
    for point in points:
        if not isinstance(point, dict) or str(point.get("symbol")) != inst["code"]:
            raise md.MarketDataError(
                "identity_mismatch", "参考估值返回了其他基金的数据"
            )
        raw_date, raw_time = (
            str(point.get("pre_date") or ""),
            str(point.get("min_time") or ""),
        )
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_date) or not re.fullmatch(
            r"\d{2}:\d{2}:\d{2}", raw_time
        ):
            raise md.MarketDataError("invalid_timestamp", "参考估值缺少完整报价时间")
        stamp = md._timestamp(f"{raw_date} {raw_time}")
        price = md._number(point.get("pre_nav"), positive=True)
        if stamp is None or not price or stamp > fetched or base_day > stamp.date():
            raise md.MarketDataError("invalid_timestamp", "参考估值日期或价格无效")
        observations.append((stamp, point, price))
    observations.sort(key=lambda item: item[0])
    stamp, point, price = observations[-1]
    growth = md._number(point.get("growthrate"))
    # Check, never reconstruct, the supplied price/baseline/rate relationship.
    # Each published decimal may have been rounded independently. A mismatch
    # keeps the raw reference visible but cannot justify an interval return.
    ratio_consistent, ratio_tolerance = None, None
    if growth is not None:
        nav, base, rate = Decimal(price), Decimal(base_nav), Decimal(growth)

        def half_unit(number):
            return Decimal(1).scaleb(number.as_tuple().exponent) / 2

        tolerance = (
            half_unit(nav) + half_unit(base) * abs(1 + rate) + base * half_unit(rate)
        )
        ratio_tolerance = md._number(tolerance)
        ratio_consistent = abs(nav - base * (1 + rate)) <= tolerance
    reference = {
        "kind": "reference_estimate",
        "status": "reference_only",
        "data_state": "delayed"
        if fetched - stamp > timedelta(minutes=10)
        else "reference_only",
        "code": inst["code"],
        "currency": "CNY",
        "source": SOURCE,
        "provider_id": "sina",
        "price": price,
        "economic_date": None,
        "published_at": stamp.isoformat(),
        "fetched_at": fetched.isoformat(),
        "base_nav": base_nav,
        "base_nav_date": base_day.isoformat(),
        "source_change_percent": md._number(Decimal(growth) * 100)
        if growth is not None
        else None,
        "base_ratio_consistent": ratio_consistent,
        "base_ratio_tolerance": ratio_tolerance,
        "observation_window_start": observations[0][0].isoformat(),
        "observation_window_end": stamp.isoformat(),
        "usable_for_accounting": False,
        "usable_for_daily_return": False,
        "method": "provider_reference",
        "message": "来源参考值；收益归属日与完整持仓覆盖未核实，未纳入今日收益或资产估价。",
    }
    return {
        **md._failed(
            inst, md.MarketDataError("reference_only", "该来源仅提供基金参考估值")
        ),
        "reference_estimate": reference,
    }
