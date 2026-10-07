"""Independent official fund NAV feeds and date-wise reconciliation.

Endpoints were traced from the providers' public product-page JavaScript. These
adapters never execute scripts, follow redirects, accept user URLs or write books.
Provider publication timestamps are unknown unless explicitly supplied; cache and
request timestamps are not publication timestamps.
"""

import hashlib
import re
import threading
import time
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from copy import deepcopy
from datetime import date, timedelta
from decimal import Decimal
from html import unescape
from urllib.parse import urlencode
from xml.etree import ElementTree

from . import market_data as md

PUBLIC_PROVIDERS = ("gffunds_official", "efunds_official", "cifm_official")
FUND_PROVIDERS = (*PUBLIC_PROVIDERS, "eastmoney_fund", "tushare_fund", "lixinger_fund")
_NAMES = {
    "gffunds_official": "广发基金官方·单位净值",
    "efunds_official": "易方达基金官方·单位净值",
    "cifm_official": "摩根基金官方·单位净值",
    "tushare_fund": "Tushare·基金单位净值",
    "lixinger_fund": "理杏仁·基金单位净值",
}
_CACHE = {}
_LOCK = threading.Lock()
_DATA_CACHE = {}
_IN_FLIGHT = {}
_DATA_LOCK = threading.Lock()
_DATA_CACHE_BYTES = 16 * 1024 * 1024


def _cached_provider_call(provider, inst, operation, start=None, end=None):
    """Ten-minute public data cache, sharing concurrent identical refreshes.

    Keys never include user names/tenant IDs or plaintext credentials. Normalize
    from public product identity only so one user's custom display label cannot
    appear in another user's observations. Policy is evaluated before this call.
    """
    fingerprint = None
    if provider in {"tushare_fund", "lixinger_fund"}:
        from .provider_credentials import get_provider_credentials

        credentials = get_provider_credentials(provider)
        if not credentials or not credentials.get("token"):
            _error("provider_unconfigured", "该数据源尚未配置凭证")
        fingerprint = hashlib.sha256(credentials["token"].encode()).hexdigest()
    key = (
        provider,
        inst["code"],
        inst["currency"],
        inst["market"],
        operation,
        str(start),
        str(end),
        fingerprint,
    )
    now = time.monotonic()
    with _DATA_LOCK:
        cached = _DATA_CACHE.get(key)
        if cached and now - cached[0] < 600:
            return deepcopy(cached[1])
        pending = _IN_FLIGHT.get(key)
        creator = pending is None
        if creator:
            pending = _IN_FLIGHT[key] = Future()
    if not creator:
        try:
            return deepcopy(pending.result(timeout=md.TIMEOUT * 4 + 2))
        except FutureTimeout:
            _error("provider_unavailable", "同产品行情请求仍在处理中，请稍后刷新")
    try:
        public_inst = md._instrument(
            {key: inst[key] for key in ("code", "currency", "market", "kind")}
        )
        value = (
            md._provider_quote(provider, public_inst)
            if operation == "quote"
            else md._provider_history(provider, public_inst, start, end)
        )
        valid = (
            _valid(value, public_inst)
            if operation == "quote"
            else bool(value) and all(_valid(row, public_inst) for row in value)
        )
        if valid:
            size = len(repr(value).encode("utf-8"))
            if size <= 2_000_000:
                with _DATA_LOCK:
                    for stale in [
                        k for k, v in _DATA_CACHE.items() if now - v[0] >= 600
                    ]:
                        _DATA_CACHE.pop(stale)
                    while _DATA_CACHE and (
                        len(_DATA_CACHE) >= 64
                        or sum(v[2] for v in _DATA_CACHE.values()) + size
                        > _DATA_CACHE_BYTES
                    ):
                        _DATA_CACHE.pop(next(iter(_DATA_CACHE)))
                    _DATA_CACHE[key] = (now, deepcopy(value), size)
        pending.set_result(deepcopy(value))
        return value
    except Exception as exc:
        pending.set_exception(exc)
        raise
    finally:
        with _DATA_LOCK:
            _IN_FLIGHT.pop(key, None)


def _cached(key, loader):
    # Public identity only, bounded TTL/size. Never cache credentials or policy.
    now = time.monotonic()
    with _LOCK:
        previous = _CACHE.get(key)
        if previous and now - previous[0] < 3600:
            return deepcopy(previous[1])
    value = loader()
    with _LOCK:
        if len(_CACHE) >= 128:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = (now, deepcopy(value))
    return value


def _error(code="invalid_response", message="基金官方数据格式已变化"):
    raise md.MarketDataError(code, message)


def _identity(inst):
    if inst["currency"] != "CNY":
        _error("unsupported_currency", "普通基金净值仅支持已核实的人民币份额")
    if inst["market"] != "CN" or not re.fullmatch(r"[0-9]{6}", inst["code"]):
        _error("unsupported_fund", "基金须使用境内六位产品代码")


def _ordinary(name, category, currency):
    if currency not in {"RMB", "CNY", "人民币"}:
        _error("currency_mismatch", "官方产品币种不是人民币")
    if not name or not category:
        _error("identity_mismatch", "官方未提供完整产品身份")
    if "货币" in category or "货币" in name:
        _error("unsupported_money_fund", "货币基金万份收益不作为普通单位净值")


def _day(raw):
    text = str(raw)
    try:
        day = (
            date(int(text[:4]), int(text[4:6]), int(text[6:8]))
            if re.fullmatch(r"[0-9]{8}", text)
            else md._date(text.replace(".", "-"))
        )
    except ValueError:
        day = None
    if day is None or day > md._now().astimezone(md.SHANGHAI).date():
        _error("invalid_date", "净值日期无效或晚于当前日期")
    return day


def _nav(inst, provider, value, day, name, historical=True, **extra):
    if md._number(value, positive=True) is None:
        _error("invalid_nav", "来源未提供有效单位净值")
    return md._quote(
        inst,
        price=value,
        kind="official_nav",
        source=_NAMES[provider],
        economic_date=_day(day),
        published_at=None,
        historical=historical,
        name=name,
        provider_id=provider,
        identity_verified=True,
        **extra,
    )


def _gf_basic(inst):
    payload = md._json(
        md._get(
            "https://www.gffunds.com.cn/apistore/JsonService?"
            + urlencode(
                {
                    "service": "BaseInfo",
                    "method": "Fund",
                    "op": "queryFundByGFFundcode",
                    "fundcode": inst["code"],
                }
            ),
            referer="https://www.gffunds.com.cn/",
        )
    )
    rows = payload.get("data")
    if not isinstance(rows, list) or not rows:
        _error("unsupported_identity", "广发官网未收录该产品")
    if len(rows) != 1 or rows[0].get("FUNDCODE") != inst["code"]:
        _error("identity_mismatch", "广发官方返回其他基金份额")
    row = rows[0]
    _ordinary(row.get("FUNDNAME"), row.get("CATEGORYNAME"), row.get("MONEYTYPE"))
    return row


def _ef_identity(inst):
    def read():
        page = md._get(
            f"https://www.efunds.com.cn/fund/{inst['code']}.shtml",
            referer="https://www.efunds.com.cn/",
        )
        if md._js_value(page, "fundCode") != inst["code"]:
            _error("identity_mismatch", "易方达官网页面份额不一致")
        name = md._js_value(page, "shortName")
        if not re.search(r'\bvar\s+ismoneyfund\s*=\s*"false"\s*(?:;|[\r\n])', page):
            _error("unsupported_money_fund", "货币基金不作为普通单位净值")
        heading = re.search(
            r'<div\s+class="fund-s-msg">\s*单位净值\(([^<)]+)\)</div>', page
        )
        category = re.search(r'<td\s+class="[^"]*fund-type"[^>]*>([^<]+)</td>', page)
        _ordinary(
            name,
            category.group(1).strip() if category else None,
            "CNY" if heading and heading.group(1) == "元" else None,
        )
        if any(word in name for word in ("美元", "港元", "港币", "欧元")):
            _error("currency_mismatch", "易方达份额名称不是人民币份额")
        return {"name": unescape(name)}

    return _cached(("ef_identity", inst["code"]), read)


def _xml(text):
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)", text, re.IGNORECASE):
        _error("invalid_response", "官方XML包含不支持的声明")
    try:
        return ElementTree.fromstring(text)
    except ElementTree.ParseError:
        _error()


def _cifm_catalog():
    root = _xml(
        md._get(
            "https://www.cifm.com/images/fund/fund_2697.xml",
            referer="https://www.cifm.com/",
        )
    )
    rows = {}
    for node in root.findall("Fund"):
        code = node.get("Fund_code")
        if not re.fullmatch(r"[0-9]{6}", code or ""):
            continue  # Legacy non-standard codes are not supported identities.
        if code in rows:
            _error("identity_mismatch", "摩根产品目录代码重复")
        rows[code] = dict(node.attrib)
    if not rows:
        _error("identity_mismatch", "摩根产品目录为空")
    return rows


def _cifm_identity(inst):
    row = _cached("cifm_catalog", _cifm_catalog).get(inst["code"])
    if not row:
        _error("unsupported_identity", "摩根官网未收录该产品")
    _ordinary(
        row.get("shortname"), row.get("Fund_investtype"), row.get("Fund_currency")
    )
    if row.get("Fund_management") != "摩根基金管理（中国）有限公司":
        _error("identity_mismatch", "基金管理公司身份不一致")
    return row


def official_history(provider, inst, start, end):
    _identity(inst)
    if provider == "gffunds_official":
        meta = _gf_basic(inst)
        payload = md._json(
            md._get(
                "https://www.gffunds.com.cn/apistore/JsonService?"
                + urlencode(
                    {
                        "service": "MarketPerformance",
                        "method": "NAV",
                        "op": "queryNAVByFundcode",
                        "fundcode": inst["code"],
                        "_mode": "all",
                        "startdate": start.strftime("%Y%m%d"),
                        "enddate": end.strftime("%Y%m%d"),
                    }
                ),
                referer="https://www.gffunds.com.cn/",
            )
        )
        points = payload.get("data")
        if not isinstance(points, list) or int(
            payload.get("totalrows", len(points))
        ) != len(points):
            _error("incomplete_history", "广发历史净值返回不完整")
        rows = []
        for point in points:
            if (
                point.get("FUNDCODE") != inst["code"]
                or point.get("FUNDNAME") != meta["FUNDNAME"]
            ):
                _error("identity_mismatch", "广发历史净值份额不一致")
            rows.append(
                _nav(
                    inst,
                    provider,
                    point.get("NAVUNIT"),
                    point.get("NAVDATE"),
                    meta["FUNDNAME"],
                )
            )
        return rows
    if provider == "efunds_official":
        meta, rows, expected = _ef_identity(inst), [], None
        for page_index in range(20):
            payload = md._json(
                md._post(
                    "https://api.efunds.com.cn/xcowch/front/fund/nav",
                    {
                        "fundCode": inst["code"],
                        "pageIndex": page_index,
                        "pageSize": 100,
                        "startDate": start.isoformat(),
                        "endDate": end.isoformat(),
                        "siteID": "1",
                    },
                )
            )
            if payload.get("status") != 1 or not isinstance(payload.get("data"), dict):
                _error("provider_unavailable", "易方达历史净值暂不可用")
            data = payload["data"]
            points = data.get("data")
            total = int(data.get("total", -1))
            if expected is not None and total != expected:
                _error("incomplete_history", "易方达分页数据在读取期间变化")
            expected = total
            if (
                not isinstance(points, list)
                or total < 0
                or total > 2000
                or (not points and len(rows) < total)
            ):
                _error("incomplete_history", "易方达历史净值返回不完整")
            for point in points:
                if point.get("shortName") != meta["name"]:
                    _error("identity_mismatch", "易方达历史净值份额名称不一致")
                rows.append(
                    _nav(
                        inst,
                        provider,
                        point.get("netValue"),
                        point.get("navDate"),
                        meta["name"],
                    )
                )
            if len(rows) == total:
                return rows
            if len(rows) > total:
                break
        _error("incomplete_history", "易方达历史净值分页超出限制")
    if provider == "cifm_official":
        meta = _cifm_identity(inst)
        payload = md._json(
            md._post(
                "https://www.cifm.com/web/search",
                {
                    "channelid": "269512",
                    "searchword": "c_fundcode=" + inst["code"],
                    "startDate": start.isoformat(),
                    "endDate": end.isoformat(),
                    "page": 1,
                    "perpage": 10000,
                },
                form=True,
                referer="https://www.cifm.com/",
            )
        )
        points = payload.get("rows")
        if not isinstance(points, list) or int(payload.get("total", -1)) != len(points):
            _error("incomplete_history", "摩根历史净值返回不完整")
        rows = []
        for point in points:
            # The official catalogue says “纳斯达克100指数人民币A”, while
            # this endpoint says “纳斯达克100人民币A”. Both echo the exact
            # share code; do not confuse descriptive abbreviations with identity.
            if (
                point.get("FUNDCODE") != inst["code"]
                or not point.get("FUNDNAME")
                or any(
                    word in point["FUNDNAME"]
                    for word in ("美元", "港元", "港币", "欧元")
                )
                or "货币" in point.get("FUNDTYPE", "")
            ):
                _error("identity_mismatch", "摩根历史净值份额不一致")
            rows.append(
                _nav(
                    inst,
                    provider,
                    point.get("NETVALUE"),
                    point.get("FUNDDATE"),
                    meta["shortname"],
                )
            )
        return rows
    return _token_history(provider, inst, start, end)


def official_quote(provider, inst):
    _identity(inst)
    if provider == "gffunds_official":
        meta = _gf_basic(inst)
        return _nav(
            inst,
            provider,
            meta.get("NAVUNIT"),
            meta.get("NAVDATE"),
            meta["FUNDNAME"],
            historical=False,
        )
    # No forward-fill: last actual date is retained, including during holidays.
    today = md._now().astimezone(md.SHANGHAI).date()
    rows = official_history(provider, inst, today - timedelta(days=90), today)
    if not rows:
        _error("quote_unavailable", "官方近期没有可用单位净值")
    row = max(rows, key=lambda item: item["economic_date"])
    return _nav(
        inst,
        provider,
        row["price"],
        row["economic_date"],
        row["name"],
        historical=False,
        **(
            {"publication_date": row["publication_date"]}
            if row.get("publication_date")
            else {}
        ),
    )


def _verified_token_identity(inst):
    # Vendor NAV endpoints do not echo currency. Require independent issuer
    # identity (not a user-provided fund name/currency or an inferred code prefix).
    for reader in (_gf_basic, _ef_identity, _cifm_identity):
        try:
            return reader(inst)
        except md.MarketDataError as exc:
            if exc.code in {"unsupported_money_fund", "currency_mismatch"}:
                raise
    _error("unsupported_identity", "该凭证数据源需先由基金官网核实人民币份额身份")


def _token_history(provider, inst, start, end):
    if provider not in {"tushare_fund", "lixinger_fund"}:
        _error("unsupported_provider", "不支持的基金数据源")
    from .provider_credentials import get_provider_credentials

    credentials = get_provider_credentials(provider)
    if (
        not credentials
        or not isinstance(credentials.get("token"), str)
        or not credentials["token"]
    ):
        _error("provider_unconfigured", "该数据源尚未配置凭证")
    _verified_token_identity(inst)
    if provider == "tushare_fund":
        # https://tushare.pro/document/2?doc_id=119 ; HTTP contract doc_id=130.
        payload = md._json(
            md._post(
                "https://api.tushare.pro",
                {
                    "api_name": "fund_nav",
                    "token": credentials["token"],
                    "params": {
                        "ts_code": inst["code"] + ".OF",
                        "start_date": start.strftime("%Y%m%d"),
                        "end_date": end.strftime("%Y%m%d"),
                    },
                    "fields": "ts_code,ann_date,nav_date,unit_nav",
                },
            )
        )
        if payload.get("code") != 0:
            _error("provider_unavailable", "Tushare凭证权限或数据请求暂不可用")
        data = payload.get("data") or {}
        fields, items = data.get("fields"), data.get("items")
        if (
            not isinstance(fields, list)
            or set(fields) != {"ts_code", "ann_date", "nav_date", "unit_nav"}
            or not isinstance(items, list)
            or len(items) >= 2000
        ):
            _error("incomplete_history", "Tushare历史净值结构无效或可能被截断")
        rows = []
        for item in items:
            if not isinstance(item, list) or len(item) != len(fields):
                _error()
            point = dict(zip(fields, item))
            if point["ts_code"] != inst["code"] + ".OF":
                _error("identity_mismatch", "Tushare返回其他基金份额")
            announcement = (
                _day(point["ann_date"]).isoformat() if point.get("ann_date") else None
            )
            rows.append(
                _nav(
                    inst,
                    provider,
                    point["unit_nav"],
                    point["nav_date"],
                    inst["name"],
                    publication_date=announcement,
                )
            )
        return rows
    # https://www.lixinger.com/api/open-api/html-doc/cn/fund/net-value
    payload = md._json(
        md._post(
            "https://open.lixinger.com/api/cn/fund/net-value",
            {
                "token": credentials["token"],
                "stockCode": inst["code"],
                "startDate": start.isoformat(),
                "endDate": end.isoformat(),
                "limit": 2000,
            },
        )
    )
    if payload.get("code") != 1 or not isinstance(payload.get("data"), list):
        _error("provider_unavailable", "理杏仁凭证权限或数据请求暂不可用")
    if len(payload["data"]) >= 2000:
        _error("incomplete_history", "理杏仁历史净值可能被截断")
    return [
        _nav(inst, provider, point.get("netValue"), point.get("date"), inst["name"])
        for point in payload["data"]
    ]


def _observation(row):
    return {
        key: row.get(key)
        for key in (
            "provider_id",
            "source",
            "code",
            "currency",
            "kind",
            "price",
            "economic_date",
            "published_at",
            "publication_date",
            "fetched_at",
            "status",
        )
    }


def _reconcile(rows, attempts):
    latest = max(row["economic_date"] for row in rows)
    compared = [row for row in rows if row["economic_date"] == latest]
    prices = {Decimal(row["price"]) for row in compared}
    # Repeated rows from one vendor are not independent confirmation.
    providers = list(dict.fromkeys(row["provider_id"] for row in compared))
    conflict = len(prices) != 1
    result = dict(compared[0])
    result["data_quality"] = {
        "status": "conflict"
        if conflict
        else "consistent"
        if len(providers) > 1
        else "single_source",
        "usable_for_accounting": not conflict,
        "compared_date": latest,
        "agreeing_providers": [] if conflict else providers,
        "conflicting_providers": providers if conflict else [],
    }
    result["provider_observations"] = [_observation(row) for row in rows]
    result["provider_attempts"] = attempts
    if conflict:
        result.update(
            price=None,
            status="conflict",
            data_state="conflict",
            error_code="nav_conflict",
            message="同日正式净值存在来源差异，需核对后使用",
        )
    return result


def _valid(row, inst):
    return (
        row.get("kind") == "official_nav"
        and row.get("code") == inst["code"]
        and row.get("currency") == "CNY"
        and md._number(row.get("price"), positive=True) is not None
        and row.get("economic_date")
        and _day(row["economic_date"])
    )


def _failed_quality(inst, attempts, error):
    row = md._failed(inst, error)
    row.update(
        data_quality={
            "status": "unavailable",
            "usable_for_accounting": False,
            "compared_date": None,
            "agreeing_providers": [],
            "conflicting_providers": [],
        },
        provider_observations=[],
        provider_attempts=attempts,
    )
    return row


def compare_quote(inst, providers):
    attempts, rows, estimate, first_error = [], [], None, None
    try:
        _identity(inst)
    except md.MarketDataError as exc:
        return _failed_quality(inst, attempts, exc)
    for provider in providers:
        try:
            row = _cached_provider_call(provider, inst, "quote")
            row["provider_id"] = provider
            if row.get("estimate"):
                estimate = row["estimate"]
            if _valid(row, inst):
                rows.append(row)
            else:
                _error(
                    row.get("error_code", "quote_unavailable"),
                    row.get("message") or "来源没有有效净值",
                )
            attempts.append(
                {"provider": provider, "status": row["status"], "error_code": None}
            )
        except (
            md.MarketDataError,
            ValueError,
            TypeError,
            KeyError,
            AttributeError,
            OverflowError,
        ) as exc:
            error = (
                exc
                if isinstance(exc, md.MarketDataError)
                else md.MarketDataError("invalid_response", "行情源数据格式已变化")
            )
            attempts.append(
                {
                    "provider": provider,
                    "status": "unconfigured"
                    if error.code == "provider_unconfigured"
                    else "unavailable",
                    "error_code": error.code,
                }
            )
            first_error = first_error or error
    if not rows:
        result = _failed_quality(
            inst,
            attempts,
            first_error
            or md.MarketDataError("provider_disabled", "没有已启用且兼容的报价源"),
        )
    else:
        result = _reconcile(rows, attempts)
    if estimate is not None:
        result["estimate"] = estimate
    return result


def compare_history(inst, providers, start, end):
    _identity(inst)
    attempts, by_day, first_error = [], {}, None
    for provider in providers:
        try:
            rows = _cached_provider_call(provider, inst, "history", start, end)
            accepted = []
            for row in rows:
                row["provider_id"] = provider
                if not _valid(row, inst):
                    _error("identity_mismatch", "历史净值身份或价格无效")
                if start.isoformat() <= row["economic_date"] <= end.isoformat():
                    accepted.append(row)
            if not accepted:
                _error("history_unavailable", "日期范围内没有可用净值")
            # Commit a provider's batch only after complete identity/date checks.
            for row in accepted:
                by_day.setdefault(row["economic_date"], []).append(row)
            attempts.append({"provider": provider, "status": "ok", "error_code": None})
        except (
            md.MarketDataError,
            ValueError,
            TypeError,
            KeyError,
            AttributeError,
            OverflowError,
        ) as exc:
            error = (
                exc
                if isinstance(exc, md.MarketDataError)
                else md.MarketDataError("invalid_response", "历史行情源数据格式已变化")
            )
            attempts.append(
                {
                    "provider": provider,
                    "status": "unconfigured"
                    if error.code == "provider_unconfigured"
                    else "unavailable",
                    "error_code": error.code,
                }
            )
            first_error = first_error or error
    if not by_day:
        raise first_error or md.MarketDataError(
            "history_unavailable", "日期范围内没有可用净值"
        )
    return [_reconcile(by_day[day], attempts) for day in sorted(by_day)]
