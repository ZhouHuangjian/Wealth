"""Read-only public market feeds. Never execute provider JavaScript or post ledger events.

All money/price fields are decimal strings; absent/invalid prices remain None.
The caller owns tenant-scoped persistence, refresh scheduling and accounting policy.
"""

import csv
import io
import json
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, localcontext
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
NEW_YORK = ZoneInfo("America/New_York")
MAX_BYTES = 2_000_000
TIMEOUT = 8
HOSTS = frozenset(
    {
        "fundsuggest.eastmoney.com",
        "fund.eastmoney.com",
        "fundf10.eastmoney.com",
        "fundcomapi.tiantianfunds.com",
        "searchapi.eastmoney.com",
        "qt.gtimg.cn",
        "web.ifzq.gtimg.cn",
        "hq.sinajs.cn",
        "query1.finance.yahoo.com",
        "push2.eastmoney.com",
        "push2his.eastmoney.com",
        "cdn-api.cboe.com",
        "api.nasdaq.com",
    }
)


class MarketDataError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise MarketDataError("provider_redirect", "行情源重定向，已停止请求")


def _now():
    return datetime.now(timezone.utc)


def _get(
    url, *, encoding="utf-8", referer="https://fund.eastmoney.com/", max_bytes=MAX_BYTES
):
    if not isinstance(max_bytes, int) or not 1 <= max_bytes <= 8_000_000:
        raise MarketDataError("invalid_limit", "行情响应限制无效")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in HOSTS
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        raise MarketDataError("unsafe_url", "行情源地址不在允许列表中")
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 Wealth/2.1",
            "Referer": referer,
            "Accept": "application/json,text/plain,*/*",
            "Accept-Encoding": "identity",
        },
    )
    try:
        with build_opener(_NoRedirect()).open(request, timeout=TIMEOUT) as response:
            raw = response.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise MarketDataError("response_too_large", "行情源响应超出大小限制")
        return raw.decode(encoding).lstrip("\ufeff")
    except MarketDataError:
        raise
    except (
        HTTPError,
        URLError,
        TimeoutError,
        OSError,
        UnicodeError,
        ValueError,
    ) as exc:
        raise MarketDataError(
            "provider_unavailable", "行情源暂时不可用，请稍后刷新"
        ) from exc


def _json(text):
    try:
        return json.loads(text, parse_float=Decimal, parse_constant=lambda x: None)
    except (ValueError, TypeError) as exc:
        raise MarketDataError("invalid_response", "行情源返回了无法识别的数据") from exc


def _js_value(text, variable):
    """Extract just one JSON literal following an exact JS variable assignment."""
    match = re.search(r"\bvar\s+" + re.escape(variable) + r"\s*=\s*", text)
    if not match:
        raise MarketDataError("missing_field", "行情源未提供所需数据")
    try:
        value, end = json.JSONDecoder(parse_float=Decimal).raw_decode(
            text[match.end() :]
        )
        suffix = text[match.end() + end :].lstrip()
        if suffix and not suffix.startswith(";"):
            raise ValueError("not a JSON literal assignment")
        return value
    except (ValueError, TypeError) as exc:
        raise MarketDataError("invalid_response", "行情源字段格式已变化") from exc


def _number(value, *, positive=False):
    if (
        value is None
        or isinstance(value, bool)
        or str(value).strip() in ("", "--", "-", "null")
    ):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if (
        not number.is_finite()
        or abs(number) >= Decimal("1e20")
        or (positive and number <= 0)
    ):
        return None
    # Public feeds sometimes emit binary-float tails; retain up to the model precision.
    if number.as_tuple().exponent < -18:
        with localcontext() as ctx:
            ctx.prec = 60
            number = number.quantize(Decimal("1e-18"))
    return format(number, "f")


def _date(value):
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _timestamp(value, market="CN"):
    if not value:
        return None
    text = str(value).strip().replace("/", "-")
    try:
        if re.fullmatch(r"\d{14}", text):
            result = datetime.strptime(text, "%Y%m%d%H%M%S").replace(
                tzinfo=NEW_YORK if market == "US" else SHANGHAI
            )
        else:
            result = datetime.fromisoformat(text)
        if result.tzinfo is None:
            result = result.replace(tzinfo=NEW_YORK if market == "US" else SHANGHAI)
        return result
    except ValueError:
        return None


def _instrument(value):
    def field(name, fallback=""):
        return (
            value.get(name, fallback)
            if isinstance(value, dict)
            else getattr(value, name, fallback)
        )

    market = str(field("market", "CN")).upper()
    market = {
        "SH": "CN",
        "SZ": "CN",
        "SSE": "CN",
        "SZSE": "CN",
        "SHFE": "CN",
        "DCE": "CN",
        "CZCE": "CN",
        "CFFEX": "CN",
        "INE": "CN",
        "GFEX": "CN",
        "NYSE": "US",
        "NASDAQ": "US",
        "HKEX": "HK",
    }.get(market, market)
    return {
        "code": str(field("code")).strip(),
        "name": str(field("name")),
        "kind": str(field("kind", "fund")).lower(),
        "market": market,
        "currency": str(
            field("currency", {"US": "USD", "HK": "HKD"}.get(market, "CNY"))
        ).upper(),
        "specification": field("specification", {}) or {},
    }


def _quote(
    instrument,
    *,
    price=None,
    kind="market",
    source="",
    economic_date=None,
    published_at=None,
    change_percent=None,
    name=None,
    historical=False,
    **extra,
):
    inst = _instrument(instrument)
    economic = _date(economic_date)
    stamp = (
        published_at
        if isinstance(published_at, datetime)
        else _timestamp(published_at, inst["market"])
    )
    if economic is None and stamp is not None:
        economic = stamp.date()
    price = _number(price, positive=True)
    now = _now()
    status, state, message = "ok", "latest_available", ""
    if price is None or economic is None:
        status, state, message = (
            "unavailable",
            "missing",
            "行情源未提供有效价格或交易日期",
        )
    elif economic > now.astimezone(SHANGHAI).date() + timedelta(days=1):
        status, state, message = (
            "unavailable",
            "invalid_date",
            "行情源返回了异常交易日期",
        )
        price = None
    elif not historical:
        lag = (
            now.astimezone(NEW_YORK if inst["market"] == "US" else SHANGHAI).date()
            - economic
        ).days
        if lag > (7 if kind == "official_nav" else 4):
            status, state, message = "stale", "stale", "价格较旧，请核对行情日期"
        elif lag > 0:
            state = "previous_session"
        elif stamp and now - stamp.astimezone(timezone.utc) > timedelta(minutes=20):
            state = "delayed"
    return {
        "status": status,
        "price": price,
        "kind": kind,
        "source": source,
        "currency": inst["currency"],
        "code": inst["code"],
        "name": name or inst["name"],
        "economic_date": economic.isoformat() if economic else None,
        "published_at": stamp.isoformat() if stamp else None,
        "fetched_at": now.isoformat(),
        "change_percent": _number(change_percent),
        "data_state": state,
        "message": message,
        **extra,
    }


def _failed(inst, error):
    result = _quote(inst)
    result.update(
        status="unsupported" if error.code.startswith("unsupported") else "unavailable",
        message=error.message,
        error_code=error.code,
    )
    return result


def _fund_history(inst):
    if inst["currency"] != "CNY":
        raise MarketDataError(
            "unsupported_currency", "当前自动基金净值支持人民币份额，请核对份额币种"
        )
    if inst["market"] != "CN" or not re.fullmatch(r"\d{6}", inst["code"]):
        raise MarketDataError("unsupported_code", "场外基金请输入六位国内基金代码")
    text = _get("https://fund.eastmoney.com/pingzhongdata/" + inst["code"] + ".js")
    if str(_js_value(text, "fS_code")) != inst["code"]:
        raise MarketDataError("identity_mismatch", "行情源返回了其他产品的数据")
    if re.search(r"\bvar\s+ishb\s*=\s*true\s*;", text):
        raise MarketDataError(
            "unsupported_money_fund",
            "货币基金使用万份收益，不能按单位净值自动估价，请录入实际收益",
        )
    name = _js_value(text, "fS_name")
    trend = _js_value(text, "Data_netWorthTrend")
    if not isinstance(trend, list):
        raise MarketDataError(
            "unsupported_fund", "此基金未提供单位净值历史，暂不支持自动计算"
        )
    rows = []
    for point in trend:
        if not isinstance(point, dict):
            continue
        try:
            economic = datetime.fromtimestamp(int(point["x"]) / 1000, SHANGHAI).date()
        except (KeyError, ValueError, TypeError, OverflowError, OSError):
            continue
        row = _quote(
            inst,
            price=point.get("y"),
            kind="official_nav",
            source="天天基金·单位净值",
            name=str(name),
            economic_date=economic,
            change_percent=point.get("equityReturn"),
            historical=True,
            corporate_action=str(point.get("unitMoney") or ""),
        )
        if row["price"] is not None:
            rows.append(row)
    if not rows:
        raise MarketDataError("history_unavailable", "基金单位净值历史暂不可用")
    return sorted(rows, key=lambda row: row["economic_date"])


def _fund_quote(inst):
    if inst["currency"] != "CNY":
        raise MarketDataError(
            "unsupported_currency", "当前自动基金净值支持人民币份额，请核对份额币种"
        )
    if inst["market"] != "CN" or not re.fullmatch(r"\d{6}", inst["code"]):
        raise MarketDataError("unsupported_code", "场外基金请输入六位国内基金代码")
    try:
        payload = _json(
            _get(
                "https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast?"
                + urlencode(
                    {
                        "FCODES": inst["code"],
                        "FIELDS": "FCODE,SHORTNAME,GSZZL,GZTIME,GSZ,NAV,PDATE,FUNDTYPE",
                    }
                )
            )
        )
        items = payload.get("data", []) if isinstance(payload, dict) else []
        item = next((x for x in items if str(x.get("FCODE")) == inst["code"]), {})
        if str(item.get("FUNDTYPE")) == "005" or "货币" in str(
            item.get("SHORTNAME", "")
        ):
            raise MarketDataError(
                "unsupported_money_fund",
                "货币基金使用万份收益，不能按单位净值自动估价，请录入实际收益",
            )
        result = _quote(
            inst,
            price=item.get("NAV"),
            kind="official_nav",
            source="天天基金·单位净值",
            economic_date=item.get("PDATE"),
            name=item.get("SHORTNAME"),
        )
        if result["price"] is None or result["economic_date"] is None:
            raise MarketDataError("missing_nav", "行情源未返回正式净值")
        estimate = _quote(
            inst,
            price=item.get("GSZ"),
            kind="estimate",
            source="天天基金·盘中估值",
            published_at=item.get("GZTIME"),
            name=item.get("SHORTNAME"),
            change_percent=item.get("GSZZL"),
        )
        result["estimate"] = estimate
        return result
    except MarketDataError as exc:
        if exc.code.startswith("unsupported"):
            raise
        row = _fund_history(inst)[-1]
        return _quote(
            inst,
            price=row["price"],
            kind="official_nav",
            source=row["source"],
            economic_date=row["economic_date"],
            name=row["name"],
            change_percent=row["change_percent"],
            estimate=_failed(
                inst, MarketDataError("estimate_unavailable", "该基金暂无盘中估值")
            ),
        )


def _stock_symbol(inst):
    expected_currency = {"CN": "CNY", "HK": "HKD", "US": "USD"}.get(inst["market"])
    if expected_currency != inst["currency"]:
        raise MarketDataError("unsupported_currency", "产品币种与市场报价币种不一致")
    code = inst["code"]
    if inst["market"] == "CN":
        if re.fullmatch(r"(?:sh|sz|bj)\d{6}", code.lower()):
            return code.lower()
        if re.fullmatch(r"\d{6}", code):
            return (
                "sh" if code[0] in "569" else "bj" if code[0] in "48" else "sz"
            ) + code
    if inst["market"] == "HK" and re.fullmatch(r"\d{1,5}", code):
        return "hk" + code.zfill(5)
    if inst["market"] == "US" and re.fullmatch(r"[A-Za-z][A-Za-z0-9.\-]{0,14}", code):
        return "us" + code.upper()
    raise MarketDataError("unsupported_code", "该市场或证券代码暂不支持自动行情")


def _assignment(text, prefix, symbol):
    match = re.search(
        r"(?:^|[;\n])\s*(?:var\s+)?"
        + re.escape(prefix + symbol)
        + r'\s*=\s*"([^"\r\n]*)"\s*;',
        text,
    )
    if not match or not match.group(1):
        raise MarketDataError(
            "quote_unavailable", "未查询到该代码的行情，请核对代码及合约月份"
        )
    return match.group(1)


def _stock_quote(inst):
    symbol = _stock_symbol(inst)
    text = _get(
        "https://qt.gtimg.cn/q=" + symbol,
        encoding="gb18030",
        referer="https://gu.qq.com/",
    )
    fields = _assignment(text, "v_", symbol).split("~")
    if len(fields) < 33:
        raise MarketDataError("invalid_response", "证券行情字段不完整")
    expected = (
        inst["code"].removeprefix("sh").removeprefix("sz").removeprefix("bj").upper()
    )
    if inst["market"] == "HK":
        expected = expected.zfill(5)
    actual = fields[2].upper()
    if actual != expected and not (
        inst["market"] == "US" and actual.startswith(expected + ".")
    ):
        raise MarketDataError("identity_mismatch", "行情源返回了其他证券的数据")
    return _quote(
        inst,
        price=fields[3],
        source="腾讯财经·参考行情",
        name=fields[1],
        published_at=fields[30],
        change_percent=fields[32],
        quote_unit="每股/份",
        feed_delay="公开参考行情，可能延迟",
    )


def _sina_quote_raw(inst):
    code, kind = inst["code"].upper(), inst["kind"]
    if kind == "gold" and code in ("XAU", "XAUUSD"):
        if inst["currency"] != "USD":
            raise MarketDataError(
                "unsupported_currency", "伦敦金 XAU 报价单位为美元/金衡盎司，请使用 USD"
            )
        symbol, mode = "hf_XAU", "spot_gold"
    elif inst["market"] != "CN" or inst["currency"] != "CNY":
        raise MarketDataError(
            "unsupported_market", "当前衍生品行情支持境内合约，黄金现货支持 XAU/USD"
        )
    elif kind == "option" and re.fullmatch(r"[19]\d{7}", code):
        symbol, mode = "CON_OP_" + code, "option"
    elif kind in ("future", "futures", "gold") and re.fullmatch(
        r"[A-Z]{1,3}(?:\d{3,4}|0)", code
    ):
        symbol = "nf_" + code
        mode = (
            "financial_future"
            if re.match(r"^(?:IF|IH|IC|IM|T|TF|TS|TL)\d", code)
            else "future"
        )
    else:
        raise MarketDataError(
            "unsupported_code",
            "请输入境内期货完整代码、已支持商品期权完整代码、八位 ETF 期权代码或 XAU",
        )
    text = _get(
        "https://hq.sinajs.cn/list=" + symbol,
        encoding="gb18030",
        referer="https://finance.sina.com.cn/",
    )
    fields = _assignment(text, "hq_str_", symbol).split(",")
    try:
        if mode == "option":
            return _quote(
                inst,
                price=fields[2],
                source="新浪财经·ETF期权参考行情",
                name=fields[37],
                published_at=fields[32],
                change_percent=fields[6],
                quote_unit="每份权利金",
            )
        if mode == "financial_future":
            return _quote(
                inst,
                price=fields[3],
                source="新浪财经·期货参考行情",
                name=fields[49],
                published_at=fields[36] + " " + fields[37],
                quote_unit="合约报价",
            )
        if mode == "spot_gold":
            return _quote(
                inst,
                price=fields[0],
                source="新浪财经·伦敦金参考行情",
                name=fields[13],
                # Sina's offshore quote clock is Beijing time, regardless of
                # the instrument's market/currency (including XAU/USD).
                published_at=_timestamp(fields[12] + " " + fields[6], "CN"),
                quote_unit="USD/金衡盎司",
            )
        clock = fields[1]
        if re.fullmatch(r"\d{6}", clock):
            clock = clock[:2] + ":" + clock[2:4] + ":" + clock[4:]
        return _quote(
            inst,
            price=fields[8],
            source="新浪财经·期货参考行情",
            name=fields[0],
            economic_date=fields[17],
            published_at=fields[17] + " " + clock,
            quote_unit="CNY/克" if code.startswith("AU") else "合约报价",
        )
    except IndexError as exc:
        raise MarketDataError("invalid_response", "衍生品行情字段不完整") from exc


def _sina_quote(inst):
    quote = _sina_quote_raw(inst)
    quote["is_derivative"] = inst["kind"] in ("future", "futures", "option") or bool(
        re.fullmatch(r"AU(?:\d{3,4}|0)", inst["code"].upper())
    )
    if inst["code"].upper().startswith("AU"):
        quote["asset_class"] = "gold"
    return quote


def _legacy_fetch_quote(instrument):
    """Return latest quote, with explicit unavailable/unsupported status on failure."""
    inst = _instrument(instrument)
    try:
        if inst["kind"] == "index":
            return _index_quote(inst)
        if inst["kind"] == "option" and normalize_commodity_contract(inst["code"]):
            return _commodity_option_quote(inst)
        if inst["kind"] == "fund":
            return _fund_quote(inst)
        if inst["kind"] in ("stock", "etf") or (
            inst["kind"] == "gold" and re.fullmatch(r"\d{6}", inst["code"])
        ):
            return _stock_quote(inst)
        return _sina_quote(inst)
    except MarketDataError as exc:
        return _failed(inst, exc)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return _failed(
            inst, MarketDataError("invalid_response", "行情源数据格式已变化")
        )


def _completed_stock_session(inst, economic_date):
    """A day-bar still changes intraday; it is not yet a formal closing price.

    Use a conservative one-hour buffer after regular close. Early-close days are
    deliberately accepted later rather than inventing an exchange calendar.
    """
    economic = _date(economic_date)
    local_now = _now().astimezone(NEW_YORK if inst["market"] == "US" else SHANGHAI)
    if economic is None or economic > local_now.date():
        return False
    if economic < local_now.date():
        return True
    ready_hour = 16 if inst["market"] == "CN" else 17
    return local_now.hour >= ready_hour


def _stock_history(inst, start, end):
    symbol = _stock_symbol(inst)
    if inst["market"] == "US":
        # Raw closes (not adjusted close): adjustments require explicit ledger actions.
        payload = _json(
            _get(
                "https://query1.finance.yahoo.com/v8/finance/chart/"
                + inst["code"].upper()
                + "?"
                + urlencode(
                    {
                        "interval": "1d",
                        "period1": int(
                            datetime.combine(
                                start, datetime.min.time(), NEW_YORK
                            ).timestamp()
                        ),
                        "period2": int(
                            datetime.combine(
                                end + timedelta(days=1), datetime.min.time(), NEW_YORK
                            ).timestamp()
                        ),
                    }
                )
            )
        )
        try:
            result = payload["chart"]["result"][0]
            if result["meta"].get("currency") != inst["currency"]:
                raise MarketDataError("currency_mismatch", "行情币种与产品币种不一致")
            _verify_yahoo_security(inst, result["meta"])
            closes = result["indicators"]["quote"][0]["close"]
            rows = [
                _quote(
                    inst,
                    price=price,
                    kind="close",
                    source="Yahoo Finance·未复权收盘价",
                    economic_date=datetime.fromtimestamp(stamp, NEW_YORK).date(),
                    historical=True,
                )
                for stamp, price in zip(result["timestamp"], closes, strict=True)
            ]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise MarketDataError(
                "history_unavailable", "美股历史价格暂不可用"
            ) from exc
    else:
        # Tencent caps each response. Fetch bounded calendar windows to avoid truncation.
        rows, cursor = [], start
        while cursor <= end:
            stop = min(cursor + timedelta(days=365), end)
            param = f"{symbol},day,{cursor.isoformat()},{stop.isoformat()},400,"
            payload = _json(
                _get(
                    "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
                    + urlencode({"param": param})
                )
            )
            try:
                points = payload["data"][symbol]["day"]
            except (KeyError, TypeError) as exc:
                raise MarketDataError(
                    "history_unavailable", "证券历史收盘价暂不可用"
                ) from exc
            for point in points:
                if isinstance(point, list) and len(point) >= 3:
                    rows.append(
                        _quote(
                            inst,
                            price=point[2],
                            kind="close",
                            source="腾讯财经·未复权收盘价",
                            economic_date=point[0],
                            historical=True,
                        )
                    )
            cursor = stop + timedelta(days=1)
    return [row for row in rows if _completed_stock_session(inst, row["economic_date"])]


def _fetch_history(instrument, start, end):
    """Daily formal NAV/unadjusted closes. Raises explicit errors, never fills gaps."""
    inst, start, end = _instrument(instrument), _date(start), _date(end)
    if not start or not end or start > end or (end - start).days > 5 * 366:
        raise MarketDataError("invalid_range", "历史行情日期须有效，且范围不能超过五年")
    if end > _now().astimezone(SHANGHAI).date():
        raise MarketDataError("invalid_range", "历史行情结束日期不能晚于今天")
    if inst["kind"] == "index":
        rows = _index_history(inst, start, end)
    elif inst["kind"] == "fund":
        rows = _fund_history(inst)
    elif inst["kind"] in ("stock", "etf") or (
        inst["kind"] == "gold" and re.fullmatch(r"\d{6}", inst["code"])
    ):
        rows = _stock_history(inst, start, end)
    else:
        raise MarketDataError(
            "unsupported_history", "该产品暂不支持自动历史行情，请录入实际持仓及收益"
        )
    result = {
        row["economic_date"]: row
        for row in rows
        if row["economic_date"]
        and start.isoformat() <= row["economic_date"] <= end.isoformat()
        and row["price"] is not None
    }
    if not result:
        raise MarketDataError(
            "history_unavailable", "该日期范围内没有可用行情；不会以零值补齐"
        )
    return [result[key] for key in sorted(result)]


def _search_products(query, kind="fund", market="CN", provider_config=None):
    """Name/code search for funds/stocks; exact-contract lookup for derivatives."""
    query, kind, market = str(query).strip(), str(kind).lower(), str(market).upper()
    if not query or len(query) > 80:
        raise MarketDataError("invalid_query", "请输入不超过 80 字的产品名称或代码")
    from .provider_policy import provider_chain

    search_source = (
        "eastmoney_fund"
        if kind == "fund"
        else "eastmoney_search"
        if kind in {"stock", "etf"}
        or (kind == "gold" and re.fullmatch(r"\d{6}", query))
        else None
    )
    if search_source and search_source not in provider_chain(provider_config, kind):
        raise MarketDataError("provider_disabled", "该分类的远程检索数据源已停用")
    if kind == "fund":
        if market != "CN":
            return []
        payload = _json(
            _get(
                "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?"
                + urlencode({"m": "1", "key": query})
            )
        )
        results = []
        for item in payload.get("Datas", [])[:30]:
            code, name = str(item.get("CODE", "")), str(item.get("NAME", ""))
            info = item.get("FundBaseInfo") or {}
            if not re.fullmatch(r"\d{6}", code) or not name or not info:
                continue
            results.append(
                {
                    "code": code,
                    "name": name,
                    "kind": "fund",
                    "market": "CN",
                    "currency": "CNY",
                    "aliases": [str(item.get("JP", ""))],
                    "specification": {
                        "fund_type": info.get("FTYPE", ""),
                        "institution": info.get("JJGS", ""),
                        "quote_provider": "eastmoney",
                    },
                }
            )
        return results
    if kind in ("stock", "etf") or (kind == "gold" and re.fullmatch(r"\d{6}", query)):
        payload = _json(
            _get(
                "https://searchapi.eastmoney.com/api/suggest/get?"
                + urlencode({"input": query, "type": "14", "count": "20"})
            )
        )
        results = []
        for item in payload.get("QuotationCodeTable", {}).get("Data", [])[:30]:
            row_market = {
                "AStock": "CN",
                "HK": "HK",
                "UsStock": "US",
                "Fund": "CN",
            }.get(item.get("Classify"))
            if row_market != market:
                continue
            code, name = str(item.get("Code", "")), str(item.get("Name", ""))
            inst = {
                "code": code,
                "name": name,
                "kind": kind,
                "market": market,
                "currency": {"CN": "CNY", "HK": "HKD", "US": "USD"}.get(market, "CNY"),
                "aliases": [str(item.get("PinYin", ""))],
                "specification": {
                    "exchange": item.get("JYS", ""),
                    "quote_provider": "tencent",
                },
            }
            try:
                _stock_symbol(inst)
            except MarketDataError:
                continue
            if name:
                results.append(inst)
        return results
    normalized_contract = (
        normalize_commodity_contract(query)
        if kind == "option"
        else normalize_commodity_future(query)
        if kind == "future"
        else None
    )
    if normalized_contract:
        if market != "CN":
            return []
        quote = fetch_quote(normalized_contract, provider_config=provider_config)
        if quote["status"] not in {"ok", "stale"}:
            return []
        normalized_contract["name"] = quote["name"]
        return [normalized_contract]
    inst = {
        "code": query.upper(),
        "name": query.upper(),
        "kind": kind,
        "market": market,
        "currency": "USD"
        if kind == "gold" and query.upper() in ("XAU", "XAUUSD")
        else "CNY",
    }
    quote = fetch_quote(inst, provider_config=provider_config)
    if quote["status"] not in ("ok", "stale"):
        return []
    if kind == "gold" and quote.get("is_derivative"):
        inst["kind"] = "future"
    inst.update(
        name=quote["name"],
        specification={
            "quote_provider": "sina",
            "quote_unit": quote.get("quote_unit", ""),
            "is_derivative": quote.get("is_derivative", False),
            "asset_class": "gold" if kind == "gold" else kind,
            "reference_only": bool(re.fullmatch(r"[A-Z]{1,3}0", inst["code"])),
        },
    )
    return [inst]


def _legacy_fetch_history(instrument, start, end):
    """Bounded historical data, or MarketDataError; missing sessions stay absent."""
    try:
        return _fetch_history(instrument, start, end)
    except MarketDataError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
        raise MarketDataError("invalid_response", "历史行情源数据格式已变化") from exc


def search_products(query, kind="fund", market="CN", provider_config=None):
    """Normalized products; network/schema failures are explicit MarketDataError."""
    try:
        return _search_products(query, kind, market, provider_config)
    except MarketDataError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
        raise MarketDataError("invalid_response", "产品检索源数据格式已变化") from exc


# Canonical index identities verified against index-owner factsheets. These are
# benchmarks, never investable positions; currency labels their quoted points.
INDEX_SPECS = {
    "NDX": {
        "name": "纳斯达克100指数",
        "market": "US",
        "currency": "USD",
        "provider_symbol": "^NDX",
        "aliases": [
            "纳斯达克100",
            "纳指100",
            "纳指",
            "nasdaq100",
            "nasdaq-100",
            "^NDX",
        ],
    },
    "SPX": {
        "name": "标普500指数",
        "market": "US",
        "currency": "USD",
        "provider_symbol": "^GSPC",
        "aliases": ["标普500", "标准普尔500", "sp500", "s&p500", "^GSPC", "GSPC"],
    },
    "VIX": {
        "name": "Cboe波动率指数",
        "market": "US",
        "currency": "USD",
        "provider_symbol": "^VIX",
        "aliases": ["恐慌指数", "波动率指数", "^VIX"],
    },
    "H30269": {
        "name": "中证红利低波动指数",
        "market": "CN",
        "currency": "CNY",
        "provider_symbol": "2.H30269",
        "aliases": ["红利低波", "中证红利低波", "红利低波50"],
    },
    "930955": {
        "name": "中证红利低波动100指数",
        "market": "CN",
        "currency": "CNY",
        "provider_symbol": "2.930955",
        "aliases": ["红利低波100", "中证红利低波100"],
    },
    "931446": {
        "name": "中证东方红红利低波动指数",
        "market": "CN",
        "currency": "CNY",
        "provider_symbol": "2.931446",
        "aliases": ["东证红利低波", "东方红红利低波"],
    },
}

INDEX_SPECS.update(
    {
        "DJI": {
            "name": "道琼斯工业平均指数",
            "market": "US",
            "currency": "USD",
            "provider_symbol": "^DJI",
            "aliases": ["道琼斯", "道指", "Dow Jones", "DJIA"],
            "tencent_symbol": "us.DJI",
        },
        "IXIC": {
            "name": "纳斯达克综合指数",
            "market": "US",
            "currency": "USD",
            "provider_symbol": "^IXIC",
            "aliases": ["纳斯达克综合", "纳综", "Nasdaq Composite"],
            "tencent_symbol": "us.IXIC",
        },
        "HSI": {
            "name": "恒生指数",
            "market": "HK",
            "currency": "HKD",
            "provider_symbol": "100.HSI",
            "aliases": ["恒指", "Hang Seng"],
            "tencent_symbol": "hkHSI",
        },
        **{
            code: {
                "name": name,
                "market": "CN",
                "currency": "CNY",
                "provider_symbol": prefix + "." + code,
                "aliases": aliases,
                "tencent_symbol": exchange + code,
            }
            for code, name, prefix, exchange, aliases in [
                ("000001", "上证指数", "1", "sh", ["上证综指", "上证综合"]),
                ("000300", "沪深300", "1", "sh", ["沪深300指数", "CSI300"]),
                ("000905", "中证500", "1", "sh", ["中证500指数", "CSI500"]),
                ("000852", "中证1000", "1", "sh", ["中证1000指数", "CSI1000"]),
                ("000922", "中证红利", "1", "sh", ["中证红利指数"]),
                ("399001", "深证成指", "0", "sz", ["深证成份", "深成指"]),
                ("399006", "创业板指", "0", "sz", ["创业板指数"]),
            ]
        },
    }
)

# Product aliases are public contract metadata, not client-entered descriptions.
COMMODITY_PRODUCTS = {
    "m": {"name": "豆粕", "exchange": "DCE", "multiplier": "10", "unit": "CNY/吨"},
    "c": {"name": "玉米", "exchange": "DCE", "unit": "CNY/吨"},
    "i": {"name": "铁矿石", "exchange": "DCE", "unit": "CNY/吨"},
    "y": {"name": "豆油", "exchange": "DCE", "unit": "CNY/吨"},
    "p": {"name": "棕榈油", "exchange": "DCE", "unit": "CNY/吨"},
    "eg": {"name": "乙二醇", "exchange": "DCE", "unit": "CNY/吨"},
    "pp": {"name": "聚丙烯", "exchange": "DCE", "unit": "CNY/吨"},
    "v": {"name": "聚氯乙烯", "exchange": "DCE", "unit": "CNY/吨"},
    "l": {"name": "聚乙烯", "exchange": "DCE", "unit": "CNY/吨"},
    "pg": {"name": "液化石油气", "exchange": "DCE", "unit": "CNY/吨"},
    "au": {"name": "黄金", "exchange": "SHFE", "unit": "CNY/克"},
    "cu": {"name": "沪铜", "exchange": "SHFE", "multiplier": "5", "unit": "CNY/吨"},
    "rb": {"name": "螺纹钢", "exchange": "SHFE", "unit": "CNY/吨"},
}


def normalize_commodity_future(query):
    """Interpret a dated commodity future; an upstream quote still verifies listing."""
    import unicodedata

    text = unicodedata.normalize("NFKC", str(query)).strip()
    if not text or len(text) > 80:
        return None
    for code, spec in sorted(
        COMMODITY_PRODUCTS.items(), key=lambda item: -len(item[1]["name"])
    ):
        text = text.replace(spec["name"], code)
    text = re.sub(r"期货|合约|[\s_-]", "", text)
    match = re.fullmatch(r"([a-zA-Z]{1,3})(\d{4})", text)
    if not match:
        match = re.fullmatch(r"(\d{4})([a-zA-Z]{1,3})", text)
        if not match:
            return None
        month, product = match.groups()
    else:
        product, month = match.groups()
    product = product.lower()
    if product not in COMMODITY_PRODUCTS or not 1 <= int(month[-2:]) <= 12:
        return None
    spec = COMMODITY_PRODUCTS[product]
    return {
        "code": product.upper() + month,
        "name": spec["name"] + month,
        "kind": "future",
        "market": "CN",
        "currency": "CNY",
        "specification": {
            "exchange": spec["exchange"],
            "product_code": product,
            "contract_month": f"20{month[:2]}-{month[2:]}",
            "quote_provider": "sina",
            "quote_unit": spec["unit"],
            "is_derivative": True,
            **(
                {"contract_multiplier": spec["multiplier"]}
                if spec.get("multiplier")
                else {}
            ),
        },
    }


def normalize_commodity_contract(query):
    """Parse an unambiguous public contract notation, without asserting listing.

    Example: 2701豆粕沽3300 -> m2701-P-3300 (Sina P_OP_m2701P3300).
    The caller must still verify actual source availability before caching it.
    """
    import unicodedata

    text = unicodedata.normalize("NFKC", str(query)).strip()
    if not text or len(text) > 80:
        return None
    for code, spec in sorted(
        COMMODITY_PRODUCTS.items(), key=lambda item: -len(item[1]["name"])
    ):
        text = text.replace(spec["name"], code)
    text = re.sub(r"认沽|看跌|沽|put", "P", text, flags=re.IGNORECASE)
    text = re.sub(r"认购|看涨|购|call", "C", text, flags=re.IGNORECASE)
    text = re.sub(r"期权|合约|期货|[\s_-]", "", text)
    match = re.fullmatch(r"([a-zA-Z]{1,3})(\d{4})([CPcp])(\d{1,8}(?:\.\d{1,2})?)", text)
    if not match:
        reverse = re.fullmatch(
            r"(\d{4})([a-zA-Z]{1,3})([CPcp])(\d{1,8}(?:\.\d{1,2})?)", text
        )
        if not reverse:
            return None
        month, product, right, strike = reverse.groups()
    else:
        product, month, right, strike = match.groups()
    product, right = product.lower(), right.upper()
    if (
        product not in COMMODITY_PRODUCTS
        or not 1 <= int(month[-2:]) <= 12
        or Decimal(strike) <= 0
    ):
        return None
    if product == "m" and int(month[-2:]) not in {1, 3, 5, 7, 8, 9, 11, 12}:
        return None  # The separately named MS series is not silently inferred.
    strike = format(Decimal(strike).normalize(), "f")
    spec = COMMODITY_PRODUCTS[product]
    return {
        "code": f"{product}{month}-{right}-{strike}",
        "name": f"{spec['name']}{month}{'沽' if right == 'P' else '购'}{strike}",
        "kind": "option",
        "market": "CN",
        "currency": "CNY",
        "specification": {
            "exchange": spec["exchange"],
            "product_code": product,
            "contract_month": f"20{month[:2]}-{month[2:]}",
            "option_right": "put" if right == "P" else "call",
            "strike": strike,
            "provider_symbol": f"{product}{month}{right}{strike}",
            "quote_provider": "sina_commodity_option",
            "quote_unit": spec["unit"],
            "is_derivative": True,
            **(
                {"contract_multiplier": spec["multiplier"]}
                if spec.get("multiplier")
                else {}
            ),
        },
    }


def _commodity_option_quote(inst):
    product = normalize_commodity_contract(inst["code"])
    if not product or inst["market"] != "CN" or inst["currency"] != "CNY":
        raise MarketDataError(
            "unsupported_code", "商品期权请提供完整合约月份、看涨/看跌和行权价"
        )
    symbol = "P_OP_" + product["specification"]["provider_symbol"]
    fields = _assignment(
        _get(
            "https://hq.sinajs.cn/list=" + symbol,
            encoding="gb18030",
            referer="https://finance.sina.com.cn/",
        ),
        "hq_str_",
        symbol,
    ).split(",")
    if len(fields) < 33:
        raise MarketDataError("quote_unavailable", "商品期权源未返回完整合约行情")
    return _quote(
        inst,
        price=fields[2],
        source="新浪财经·商品期权参考行情",
        name=product["name"],
        published_at=fields[32],
        change_percent=fields[6],
        is_derivative=True,
        quote_unit=product["specification"]["quote_unit"],
        contract_multiplier=product["specification"].get("contract_multiplier"),
        canonical_code=product["code"],
        provider_symbol=product["specification"]["provider_symbol"],
    )


def _index_identity(inst):
    code = inst["code"].upper()
    code = {"^NDX": "NDX", "^GSPC": "SPX", "GSPC": "SPX", "^VIX": "VIX"}.get(code, code)
    spec = INDEX_SPECS.get(code)
    if (
        not spec
        or inst["market"] != spec["market"]
        or inst["currency"] != spec["currency"]
    ):
        raise MarketDataError(
            "unsupported_index", "该指数身份或市场暂未接入，请从指数目录选择"
        )
    return code, spec


def _yahoo_index_payload(spec, start=None, end=None):
    from urllib.parse import quote

    params = {"interval": "1d"}
    if start is None:
        params["range"] = "5d"
    else:
        params.update(
            period1=int(
                datetime.combine(start, datetime.min.time(), NEW_YORK).timestamp()
            ),
            period2=int(
                datetime.combine(
                    end + timedelta(days=1), datetime.min.time(), NEW_YORK
                ).timestamp()
            ),
        )
    payload = _json(
        _get(
            "https://query1.finance.yahoo.com/v8/finance/chart/"
            + quote(spec["provider_symbol"], safe="")
            + "?"
            + urlencode(params)
        )
    )
    try:
        data = payload["chart"]["result"][0]
        if (
            data["meta"].get("symbol") != spec["provider_symbol"]
            or data["meta"].get("instrumentType") != "INDEX"
            or data["meta"].get("currency") != spec["currency"]
        ):
            raise MarketDataError("identity_mismatch", "行情源返回了其他指数的数据")
        return data
    except (KeyError, TypeError, IndexError) as exc:
        raise MarketDataError("index_unavailable", "指数行情暂不可用") from exc


def _index_quote(inst, allow_fallback=True):
    code, spec = _index_identity(inst)
    if inst["market"] == "US":
        try:
            data = _yahoo_index_payload(spec)
        except MarketDataError as exc:
            if not allow_fallback or exc.code != "provider_unavailable":
                raise
            return _us_index_fallback_quote(inst, code, spec)
        meta = data["meta"]
        try:
            stamp = datetime.fromtimestamp(
                int(meta["regularMarketTime"]), timezone.utc
            ).astimezone(NEW_YORK)
        except (KeyError, TypeError, ValueError, OverflowError, OSError) as exc:
            raise MarketDataError("missing_timestamp", "指数行情缺少有效时间") from exc
        return _quote(
            inst,
            price=meta.get("regularMarketPrice"),
            source="Yahoo Finance·指数参考点位",
            name=spec["name"],
            published_at=stamp,
            quote_unit="指数点",
            is_index=True,
            change_percent=meta.get("regularMarketChangePercent"),
        )
    try:
        return _csi_index_quote(inst, code, spec)
    except MarketDataError:
        # The intraday endpoint sometimes closes public connections while its
        # daily-history endpoint still works. Preserve the last actual close as
        # a close, including the original date; never label it as a live tick.
        today = _now().astimezone(SHANGHAI).date()
        rows = _filter_history(
            _index_history(
                inst, today - timedelta(days=20), today, allow_fallback=False
            ),
            today - timedelta(days=20),
            today,
        )
        last = rows[-1]
        result = _quote(
            inst,
            price=last["price"],
            kind="close",
            source=last["source"],
            name=spec["name"],
            economic_date=last["economic_date"],
            quote_unit="指数点",
            is_index=True,
            live_status="unavailable",
            feed_delay="盘中行情暂不可用，显示最近已收盘点位",
        )
        result["message"] = "盘中行情暂不可用，显示最近已收盘点位" + (
            "；" + result["message"] if result["message"] else ""
        )
        return result


def _csi_index_quote(inst, code, spec):
    payload = _json(
        _get(
            "https://push2.eastmoney.com/api/qt/stock/get?"
            + urlencode(
                {
                    "secid": spec["provider_symbol"],
                    "fields": "f43,f57,f58,f86,f60,f170",
                    "fltt": 2,
                }
            ),
            referer="https://quote.eastmoney.com/",
        )
    )
    data = payload.get("data") or {}
    if str(data.get("f57")) != code:
        raise MarketDataError("index_unavailable", "指数源暂未返回该代码的行情")
    try:
        stamp = datetime.fromtimestamp(int(data["f86"]), timezone.utc).astimezone(
            SHANGHAI
        )
    except (KeyError, ValueError, TypeError, OverflowError, OSError) as exc:
        raise MarketDataError("missing_timestamp", "指数行情缺少有效时间") from exc
    return _quote(
        inst,
        price=data.get("f43"),
        source="东方财富·指数参考点位",
        name=spec["name"],
        published_at=stamp,
        change_percent=data.get("f170"),
        quote_unit="指数点",
        is_index=True,
    )


def _index_history(inst, start, end, allow_fallback=True):
    code, spec = _index_identity(inst)
    rows = []
    if inst["market"] == "US":
        try:
            data = _yahoo_index_payload(spec, start, end)
        except MarketDataError as exc:
            if not allow_fallback or exc.code != "provider_unavailable":
                raise
            return _us_index_fallback_history(inst, code, spec, start, end)
        try:
            values = zip(
                data["timestamp"], data["indicators"]["quote"][0]["close"], strict=True
            )
            for stamp, price in values:
                economic = datetime.fromtimestamp(stamp, NEW_YORK).date()
                if _completed_stock_session(inst, economic):
                    rows.append(
                        _quote(
                            inst,
                            price=price,
                            kind="close",
                            source="Yahoo Finance·指数收盘点位",
                            economic_date=economic,
                            name=spec["name"],
                            quote_unit="指数点",
                            is_index=True,
                            historical=True,
                        )
                    )
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            raise MarketDataError(
                "history_unavailable", "指数历史点位暂不可用"
            ) from exc
    else:
        cursor = start
        while cursor <= end:
            stop = min(cursor + timedelta(days=365), end)
            payload = _json(
                _get(
                    "https://push2his.eastmoney.com/api/qt/stock/kline/get?"
                    + urlencode(
                        {
                            "secid": spec["provider_symbol"],
                            "klt": 101,
                            "fqt": 0,
                            "beg": cursor.strftime("%Y%m%d"),
                            "end": stop.strftime("%Y%m%d"),
                            "lmt": 400,
                            "fields1": "f1,f2,f3,f4,f5,f6",
                            "fields2": "f51,f52,f53,f54,f55,f56",
                        }
                    ),
                    referer="https://quote.eastmoney.com/",
                )
            )
            data = payload.get("data") or {}
            if str(data.get("code")) != code:
                raise MarketDataError(
                    "history_unavailable", "指数历史源暂未返回该代码的数据"
                )
            for text in data.get("klines", []):
                fields = str(text).split(",")
                if len(fields) >= 3 and _completed_stock_session(inst, fields[0]):
                    rows.append(
                        _quote(
                            inst,
                            price=fields[2],
                            kind="close",
                            source="东方财富·指数收盘点位",
                            economic_date=fields[0],
                            name=spec["name"],
                            quote_unit="指数点",
                            is_index=True,
                            historical=True,
                        )
                    )
            cursor = stop + timedelta(days=1)
    return rows


_TENCENT_INDEX_SYMBOLS = {"NDX": "us.NDX", "SPX": "us.INX"}
_TENCENT_INDEX_SYMBOLS.update(
    {
        code: spec["tencent_symbol"]
        for code, spec in INDEX_SPECS.items()
        if spec.get("tencent_symbol")
    }
)


def _verify_tencent_index(fields, symbol):
    # The .NDX kline service has occasionally returned a DX.N stock quote inside
    # the requested index envelope. An outer JSON key alone is not sufficient.
    currency, currency_pos, type_pos = (
        ("USD", 35, 56)
        if symbol.startswith("us")
        else ("HKD", 75, 63)
        if symbol.startswith("hk")
        else ("CNY", 82, 61)
    )
    if not isinstance(fields, list) or len(fields) <= max(currency_pos, type_pos):
        raise MarketDataError("index_unavailable", "指数备用源字段不完整")
    if (
        fields[2] != symbol[2:]
        or fields[currency_pos] != currency
        or fields[type_pos] != "ZS"
    ):
        raise MarketDataError("identity_mismatch", "指数备用源返回了其他证券的数据")


def _us_index_trade_time(value, market="US"):
    stamp = _timestamp(value, market)
    if stamp is None:
        raise MarketDataError("missing_timestamp", "指数报价缺少有效交易时间")
    if stamp > _now() + timedelta(minutes=5):
        raise MarketDataError("invalid_timestamp", "指数源时间异常，未采用该报价")
    return stamp.astimezone(NEW_YORK if market == "US" else SHANGHAI)


def _us_index_fallback_quote(inst, code, spec):
    if code == "VIX":
        try:
            payload = _json(
                _get(
                    "https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/_VIX.json",
                    referer="https://www.cboe.com/",
                )
            )
            data = payload.get("data") or {}
            if (
                payload.get("symbol") != "_VIX"
                or data.get("symbol") != "^VIX"
                or data.get("security_type") != "index"
            ):
                raise MarketDataError("identity_mismatch", "Cboe返回了其他指数的数据")
            stamp = _us_index_trade_time(data.get("last_trade_time"))
            result = _quote(
                inst,
                price=data.get("current_price"),
                source="Cboe·VIX官方延迟点位",
                name=spec["name"],
                published_at=stamp,
                change_percent=data.get("price_change_percent"),
                quote_unit="指数点",
                is_index=True,
                feed_delay="Cboe 延迟参考行情（约15分钟）",
                delay_minutes=15,
            )
            if result["data_state"] == "latest_available":
                result["data_state"] = "delayed"
            return result
        except MarketDataError as exc:
            if exc.code != "provider_unavailable":
                raise
            today = _now().astimezone(NEW_YORK).date()
            rows = _cboe_vix_history(inst, today - timedelta(days=20), today)
            if not rows:
                raise MarketDataError(
                    "index_unavailable", "VIX延迟报价和近期收盘数据暂不可用"
                ) from exc
            last = rows[-1]
            result = _quote(
                inst,
                price=last["price"],
                kind="close",
                source=last["source"],
                name=spec["name"],
                economic_date=last["economic_date"],
                quote_unit="指数点",
                is_index=True,
                live_status="unavailable",
                feed_delay="延迟报价暂不可用，显示官方最近收盘点位",
            )
            result["message"] = result["feed_delay"]
            return result
    symbol = _TENCENT_INDEX_SYMBOLS[code]
    fields = _assignment(
        _get(
            "https://qt.gtimg.cn/q=" + symbol,
            encoding="gb18030",
            referer="https://gu.qq.com/",
        ),
        "v_",
        symbol,
    ).split("~")
    _verify_tencent_index(fields, symbol)
    return _quote(
        inst,
        price=fields[3],
        source="腾讯财经·指数参考点位",
        name=spec["name"],
        published_at=_us_index_trade_time(fields[30], inst["market"]),
        change_percent=fields[32],
        quote_unit="指数点",
        is_index=True,
        feed_delay="公开指数参考行情，可能延迟",
    )


def _cboe_vix_history(inst, start, end):
    # Fixed official VIX endpoint: CSV has no ticker column. Do not accept a
    # user-supplied path or substitute futures/ETF history for the VIX index.
    text = _get(
        "https://cdn-api.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv",
        referer="https://www.cboe.com/",
    )
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames != ["DATE", "OPEN", "HIGH", "LOW", "CLOSE"]:
        raise MarketDataError("invalid_response", "Cboe VIX历史数据格式已变化")
    rows = []
    for point in reader:
        try:
            economic = (
                datetime.strptime(point["DATE"], "%m/%d/%Y")
                .replace(tzinfo=NEW_YORK)
                .date()
            )
        except (TypeError, ValueError, KeyError) as exc:
            raise MarketDataError("invalid_response", "Cboe VIX历史日期无效") from exc
        if start <= economic <= end and _completed_stock_session(inst, economic):
            row = _quote(
                inst,
                price=point["CLOSE"],
                kind="close",
                source="Cboe·VIX官方收盘点位",
                economic_date=economic,
                name=INDEX_SPECS["VIX"]["name"],
                quote_unit="指数点",
                is_index=True,
                historical=True,
            )
            if row["price"] is not None:
                rows.append(row)
    return sorted(rows, key=lambda row: row["economic_date"])


def _us_index_fallback_history(inst, code, spec, start, end):
    if code == "VIX":
        return _cboe_vix_history(inst, start, end)
    if code == "NDX":
        # Tencent's .NDX historical envelope has mixed in DX.N stock prices.
        # Use Nasdaq's own NDX endpoint instead of trying to repair that feed.
        return _nasdaq_ndx_history(inst, start, end)
    symbol = _TENCENT_INDEX_SYMBOLS[code]
    rows, cursor = [], start
    while cursor <= end:
        stop = min(cursor + timedelta(days=365), end)
        payload = _json(
            _get(
                "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
                + urlencode(
                    {
                        "param": f"{symbol},day,{cursor.isoformat()},{stop.isoformat()},400,"
                    }
                ),
                referer="https://gu.qq.com/",
            )
        )
        try:
            data = payload["data"][symbol]
            _verify_tencent_index(data["qt"][symbol], symbol)
            latest_trade = _us_index_trade_time(data["qt"][symbol][30], inst["market"])
            for point in data["day"]:
                if (
                    isinstance(point, list)
                    and len(point) >= 3
                    and _completed_stock_session(inst, point[0])
                ):
                    economic = _date(point[0])
                    if economic == _now().astimezone(
                        NEW_YORK if inst["market"] == "US" else SHANGHAI
                    ).date() and (
                        latest_trade.date() != economic
                        or latest_trade.hour < (15 if inst["market"] == "CN" else 16)
                    ):
                        continue  # A cached intraday append is not a closing bar.
                    rows.append(
                        _quote(
                            inst,
                            price=point[2],
                            kind="close",
                            source="腾讯财经·指数收盘点位",
                            economic_date=point[0],
                            name=spec["name"],
                            quote_unit="指数点",
                            is_index=True,
                            historical=True,
                        )
                    )
        except (KeyError, TypeError) as exc:
            raise MarketDataError(
                "history_unavailable", "指数备用历史源暂不可用"
            ) from exc
        cursor = stop + timedelta(days=1)
    return rows


def _nasdaq_ndx_history(inst, start, end):
    rows, cursor = [], start
    while cursor <= end:
        stop = min(cursor + timedelta(days=365), end)
        payload = _json(
            _get(
                "https://api.nasdaq.com/api/quote/NDX/historical?"
                + urlencode(
                    {
                        "assetclass": "index",
                        "fromdate": cursor.isoformat(),
                        "todate": stop.isoformat(),
                        "limit": 400,
                    }
                ),
                referer="https://www.nasdaq.com/",
            )
        )
        data = payload.get("data") or {}
        if data.get("symbol") != "NDX":
            raise MarketDataError("identity_mismatch", "Nasdaq历史源未返回NDX指数")
        points = (data.get("tradesTable") or {}).get("rows")
        if not isinstance(points, list):
            raise MarketDataError("history_unavailable", "Nasdaq指数历史暂不可用")
        try:
            if int(data["totalRecords"]) > len(points):
                raise MarketDataError("incomplete_history", "Nasdaq指数历史响应不完整")
            for point in points:
                economic = (
                    datetime.strptime(point["date"], "%m/%d/%Y")
                    .replace(tzinfo=NEW_YORK)
                    .date()
                )
                raw = str(point["close"]).strip()
                price = (
                    raw.replace(",", "")
                    if re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", raw)
                    else None
                )
                if _completed_stock_session(inst, economic):
                    rows.append(
                        _quote(
                            inst,
                            price=price,
                            kind="close",
                            source="Nasdaq·NDX官方收盘点位",
                            economic_date=economic,
                            name=INDEX_SPECS["NDX"]["name"],
                            quote_unit="指数点",
                            is_index=True,
                            historical=True,
                        )
                    )
        except (KeyError, TypeError, ValueError) as exc:
            raise MarketDataError(
                "invalid_response", "Nasdaq指数历史格式已变化"
            ) from exc
        cursor = stop + timedelta(days=1)
    return rows


def _supports_provider(provider, inst, operation):
    kind, market, code = inst["kind"], inst["market"], inst["code"].upper()
    if kind == "index":
        canonical, spec = _index_identity(inst)
        if provider == "yahoo":
            return market == "US" and spec["provider_symbol"].startswith("^")
        if provider == "eastmoney_index":
            return market in {"CN", "HK"} and bool(
                spec.get("eastmoney_symbol", spec.get("provider_symbol"))
            )
        if provider == "tencent":
            return canonical in _TENCENT_INDEX_SYMBOLS and not (
                operation == "history" and canonical == "NDX"
            )
        return (
            provider == "nasdaq" and canonical == "NDX" and operation == "history"
        ) or (provider == "cboe" and canonical == "VIX")
    if kind == "fund":
        return provider == "eastmoney_fund"
    if kind in {"future", "option"} or (
        kind == "gold" and not re.fullmatch(r"\d{6}", code)
    ):
        return provider == "sina" and operation == "quote"
    if kind in {"stock", "etf", "gold"}:
        if provider == "tencent":
            return operation == "quote" or market in {"CN", "HK"}
        return provider == "yahoo" and market == "US"
    return False


def _verify_yahoo_security(inst, meta):
    expected_type = "ETF" if inst["kind"] in {"etf", "gold"} else "EQUITY"
    if (
        meta.get("symbol") != inst["code"].upper()
        or meta.get("currency") != inst["currency"]
        or meta.get("instrumentType") != expected_type
    ):
        raise MarketDataError("identity_mismatch", "行情源返回了其他证券的数据")


def _stock_yahoo_quote(inst):
    _stock_symbol(inst)
    payload = _json(
        _get(
            "https://query1.finance.yahoo.com/v8/finance/chart/"
            + inst["code"].upper()
            + "?interval=1d&range=5d"
        )
    )
    try:
        meta = payload["chart"]["result"][0]["meta"]
        _verify_yahoo_security(inst, meta)
        stamp = datetime.fromtimestamp(
            int(meta["regularMarketTime"]), timezone.utc
        ).astimezone(NEW_YORK)
        if stamp > _now() + timedelta(minutes=5):
            raise MarketDataError("invalid_timestamp", "行情源时间晚于当前时间")
        return _quote(
            inst,
            price=meta.get("regularMarketPrice"),
            source="Yahoo Finance·证券参考行情",
            published_at=stamp,
            name=meta.get("shortName"),
            quote_unit="每股/份",
            feed_delay="公开参考行情，可能延迟",
        )
    except (KeyError, IndexError, TypeError, ValueError, OverflowError) as exc:
        raise MarketDataError("quote_unavailable", "证券备用行情暂不可用") from exc


def _provider_quote(provider, inst):
    if inst["kind"] == "index":
        code, spec = _index_identity(inst)
        if provider in {"tencent", "cboe"}:
            return _us_index_fallback_quote(inst, code, spec)
        return _index_quote(inst, allow_fallback=False)
    if provider == "yahoo":
        return _stock_yahoo_quote(inst)
    return _legacy_fetch_quote(inst)


def fetch_quote(instrument, provider_config=None):
    """Use enabled compatible providers in order, with no implicit database reads."""
    from .provider_policy import provider_chain

    inst = _instrument(instrument)
    attempts, first_error, stale = [], None, None
    try:
        providers = [
            p
            for p in provider_chain(provider_config, inst["kind"])
            if _supports_provider(p, inst, "quote")
        ]
        if not providers:
            raise MarketDataError("provider_disabled", "没有已启用且兼容的报价源")
        for provider in providers:
            try:
                quote = _provider_quote(provider, inst)
            except MarketDataError as exc:
                quote = _failed(inst, exc)
            except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                quote = _failed(
                    inst, MarketDataError("invalid_response", "行情源数据格式已变化")
                )
            quote["provider_id"] = provider
            attempts.append(
                {
                    "provider": provider,
                    "status": quote["status"],
                    "error_code": quote.get("error_code"),
                }
            )
            if quote["status"] == "ok" and quote.get("price") is not None:
                quote["provider_attempts"] = attempts
                return quote
            if quote["status"] == "stale" and stale is None:
                stale = quote
            if (
                first_error is None
                or first_error.get("error_code") == "provider_unavailable"
            ):
                first_error = quote
        result = stale or first_error
        result["provider_attempts"] = attempts
        return result
    except MarketDataError as exc:
        return _failed(inst, exc)


def _filter_history(rows, start, end):
    result = {
        row["economic_date"]: row
        for row in rows
        if row.get("economic_date")
        and start.isoformat() <= row["economic_date"] <= end.isoformat()
        and row.get("price") is not None
    }
    if not result:
        raise MarketDataError(
            "history_unavailable", "该日期范围内没有可用行情；不会以零值补齐"
        )
    return [result[key] for key in sorted(result)]


def _provider_history(provider, inst, start, end):
    if inst["kind"] == "index":
        code, spec = _index_identity(inst)
        if provider == "nasdaq":
            return _nasdaq_ndx_history(inst, start, end)
        if provider == "cboe":
            return _cboe_vix_history(inst, start, end)
        if provider == "tencent":
            return _us_index_fallback_history(inst, code, spec, start, end)
        return _index_history(inst, start, end, allow_fallback=False)
    if inst["kind"] == "fund":
        return _fund_history(inst)
    return _stock_history(inst, start, end)


def fetch_history(instrument, start, end, provider_config=None):
    from .provider_policy import provider_chain

    inst, start, end = _instrument(instrument), _date(start), _date(end)
    if (
        not start
        or not end
        or start > end
        or (end - start).days > 5 * 366
        or end > _now().astimezone(SHANGHAI).date()
    ):
        raise MarketDataError("invalid_range", "历史行情日期须有效，且范围不能超过五年")
    providers = [
        p
        for p in provider_chain(provider_config, inst["kind"])
        if _supports_provider(p, inst, "history")
    ]
    if not providers:
        raise MarketDataError(
            "unsupported_history", "没有已启用且兼容的历史源，请录入实际持仓及收益"
        )
    first_error = None
    for provider in providers:
        try:
            rows = _filter_history(
                _provider_history(provider, inst, start, end), start, end
            )
            for row in rows:
                row["provider_id"] = provider
            return rows
        except MarketDataError as exc:
            if first_error is None or first_error.code == "provider_unavailable":
                first_error = exc
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
            first_error = first_error or MarketDataError(
                "invalid_response", "历史行情源数据格式已变化"
            )
    raise first_error
