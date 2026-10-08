"""Bounded, read-only AKShare adapters with explicit underlying feed provenance.

The SDK runs in a disposable interpreter with no application credentials. Only
fixed public interfaces are allowed. In particular, the SDK's fund JS evaluation
interface is deliberately not used: NAV history uses its JSON LSJZ interface.
Public results are cached across spaces, while private labels never enter a key.
"""

import contextlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from contextvars import ContextVar
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

if __package__:
    from . import market_data as md
else:  # Isolated ``python -I /absolute/path/akshare_provider.py`` worker.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from wealth import market_data as md

SDK_VERSION = "1.19.1"
TIMEOUT = 20
OPERATION_TIMEOUT = 30
MAX_BYTES = 2 * 1024 * 1024
MAX_ROWS = 40_000
_CACHE_BYTES = 16 * 1024 * 1024
_CACHE = {}
_PENDING = {}
_LOCK = threading.Lock()
_WORKERS = threading.BoundedSemaphore(2)
_DEADLINE = ContextVar("akshare_deadline", default=None)
_PRODUCTS = {
    "m": ("豆粕", "DCE"),
    "c": ("玉米", "DCE"),
    "i": ("铁矿石", "DCE"),
    "y": ("豆油", "DCE"),
    "p": ("棕榈油", "DCE"),
    "eg": ("乙二醇", "DCE"),
    "pp": ("聚丙烯", "DCE"),
    "v": ("PVC", "DCE"),
    "l": ("塑料", "DCE"),
    "pg": ("液化石油气", "DCE"),
    "au": ("黄金", "SHFE"),
    "cu": ("沪铜", "SHFE"),
    "rb": ("螺纹钢", "SHFE"),
}
_OPTION_PRODUCTS = {"m", "c", "i", "pg", "au", "cu"}
_INTERFACES = {
    "fund_catalog": "fund_name_em",
    "fund_nav": "fund_etf_fund_info_em",
    "stock_identity": "stock_individual_info_em",
    "stock_history": "stock_zh_a_hist",
    "etf_history": "fund_etf_hist_em",
    "future_quotes": "futures_zh_realtime",
    "option_identity": "option_commodity_contract_table_sina",
    "option_history": "option_commodity_hist_sina",
}
_NETWORK_HOSTS = frozenset(
    {
        "fund.eastmoney.com",
        "api.fund.eastmoney.com",
        "push2.eastmoney.com",
        "push2his.eastmoney.com",
        "vip.stock.finance.sina.com.cn",
        "stock.finance.sina.com.cn",
    }
)
_SDK_MODULES = (
    "akshare.fund.fund_em",
    "akshare.fund.fund_etf_em",
    "akshare.stock.stock_info_em",
    "akshare.stock_feature.stock_hist_em",
    "akshare.futures.futures_zh_sina",
    "akshare.option.option_commodity_sina",
)


def _error(code="provider_unavailable", message="AKShare 数据暂时不可用"):
    raise md.MarketDataError(code, message)


def _contract(inst):
    if inst["kind"] == "future":
        match = re.fullmatch(r"([A-Za-z]{1,3})([0-9]{4})", inst["code"])
        if match and match[1].lower() in _PRODUCTS and 1 <= int(match[2][-2:]) <= 12:
            return match[1].lower(), match[2]
    if inst["kind"] == "option":
        normalized = md.normalize_commodity_contract(inst["code"])
        if normalized:
            spec = normalized["specification"]
            product = spec["product_code"]
            if product in _OPTION_PRODUCTS:
                return product, spec["provider_symbol"]
    return None


def supports(instrument, operation="quote"):
    inst = md._instrument(instrument)
    if operation not in {"quote", "history"} or (
        inst["market"] != "CN" or inst["currency"] != "CNY"
    ):
        return False
    code, kind = inst["code"], inst["kind"]
    if kind == "fund":
        return bool(re.fullmatch(r"[0-9]{6}", code))
    if kind == "stock":
        return bool(re.fullmatch(r"(?:0|3|6)[0-9]{5}", code))
    if kind == "etf":
        return bool(re.fullmatch(r"(?:15|16|50|51|52|56|58)[0-9]{4}", code))
    return bool(_contract(inst)) and (kind != "future" or operation == "quote")


def _validate_job(job, params):
    if job not in _INTERFACES or not isinstance(params, dict):
        _error("unsupported_interface", "AKShare 接口不在允许列表中")
    expected = {
        "fund_catalog": set(),
        "fund_nav": {"code", "start", "end"},
        "stock_identity": {"code"},
        "stock_history": {"code", "start", "end"},
        "etf_history": {"code", "start", "end"},
        "future_quotes": {"product"},
        "option_identity": {"product", "contract"},
        "option_history": {"symbol"},
    }[job]
    if set(params) != expected or any(not isinstance(v, str) for v in params.values()):
        _error("invalid_request", "AKShare 请求参数不正确")
    if "code" in params and not re.fullmatch(r"[0-9]{6}", params["code"]):
        _error("unsupported_code", "AKShare 产品代码无效")
    if "start" in params:
        start, end = md._date(params["start"]), md._date(params["end"])
        if start is None or end is None or start > end or (end - start).days > 7_305:
            _error("invalid_range", "行情日期范围无效或超过 20 年")
    if "product" in params and params["product"] not in _PRODUCTS:
        _error("unsupported_code", "AKShare 暂不支持该商品品种")
    if job == "option_identity" and (
        params["product"] not in _OPTION_PRODUCTS
        or not re.fullmatch(
            re.escape(params["product"]) + r"[0-9]{4}", params["contract"]
        )
    ):
        _error("unsupported_code", "AKShare 期权合约无效")
    if job == "option_history" and not re.fullmatch(
        r"(?:"
        + "|".join(sorted(_OPTION_PRODUCTS))
        + r")[0-9]{4}[CP][0-9]{1,8}(?:\.[0-9]{1,2})?",
        params["symbol"],
    ):
        _error("unsupported_code", "AKShare 期权代码无效")


def _child_env():
    # No HOME, database/Redis URLs, Django key, tokens, cookies or proxy credentials.
    allowed = (
        "PATH",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
    )
    return {key: os.environ[key] for key in allowed if key in os.environ} | {
        "TZ": "Asia/Shanghai",
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
    }


def _invoke(job, **params):
    """Hard deadline and output bound around an SDK which may lack HTTP timeouts."""
    _validate_job(job, params)
    payload = json.dumps({"job": job, "params": params}, ensure_ascii=False).encode()
    if len(payload) > 2_048:
        _error("invalid_request", "AKShare 请求过大")
    if not _WORKERS.acquire(timeout=1):
        _error("provider_busy", "AKShare 正在更新其他行情，请稍后刷新")
    try:
        with tempfile.TemporaryFile() as output:
            try:
                deadline = _DEADLINE.get()
                remaining = deadline - time.monotonic() if deadline else TIMEOUT
                if remaining <= 0:
                    _error("provider_timeout", "AKShare 更新超时，已停止本次请求")
                result = subprocess.run(
                    [sys.executable, "-I", str(Path(__file__).resolve())],
                    input=payload,
                    stdout=output,
                    stderr=subprocess.DEVNULL,
                    env=_child_env(),
                    timeout=min(TIMEOUT, remaining),
                    check=False,
                    close_fds=True,
                )
            except subprocess.TimeoutExpired:
                _error("provider_timeout", "AKShare 更新超时，已停止本次请求")
            except OSError:
                _error()
            output.seek(0)
            raw = output.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            _error("response_too_large", "AKShare 数据超出大小限制")
        try:
            decoded = json.loads(raw)
        except (ValueError, TypeError):
            _error("invalid_response", "AKShare 返回数据格式无效")
        if result.returncode or not isinstance(decoded, dict) or not decoded.get("ok"):
            code = decoded.get("code") if isinstance(decoded, dict) else None
            _error(
                code
                if code in {"provider_unconfigured", "response_too_large"}
                else "provider_unavailable"
            )
        rows = decoded.get("rows")
        if not isinstance(rows, list) or len(rows) > MAX_ROWS:
            _error("invalid_response", "AKShare 返回数据格式无效")
        return {
            "rows": rows,
            "fetched_at": md._now().isoformat(),
            "interface_name": _INTERFACES[job],
        }
    finally:
        _WORKERS.release()


def _cached_call(job, **params):
    key = (job, tuple(sorted(params.items())))
    ttl = (
        3_600
        if job in {"fund_catalog", "stock_identity", "option_identity"}
        else 60
        if job == "future_quotes"
        else 600
    )
    now = time.monotonic()
    with _LOCK:
        old = _CACHE.get(key)
        if old and now - old[0] < ttl:
            return deepcopy(old[1])
        pending = _PENDING.get(key)
        creator = pending is None
        if creator:
            pending = _PENDING[key] = Future()
    if not creator:
        try:
            deadline = _DEADLINE.get()
            remaining = deadline - time.monotonic() if deadline else TIMEOUT + 2
            if remaining <= 0:
                _error("provider_timeout", "AKShare 更新超时，已停止本次请求")
            return deepcopy(pending.result(timeout=min(TIMEOUT + 2, remaining)))
        except FutureTimeout:
            _error("provider_busy", "AKShare 同产品行情仍在更新中")
    try:
        value = _invoke(job, **params)
        size = len(json.dumps(value, ensure_ascii=False).encode())
        if size <= MAX_BYTES:
            with _LOCK:
                for stale in [k for k, v in _CACHE.items() if now >= v[0] + v[3]]:
                    _CACHE.pop(stale, None)
                while _CACHE and (
                    len(_CACHE) >= 128
                    or sum(v[2] for v in _CACHE.values()) + size > _CACHE_BYTES
                ):
                    _CACHE.pop(next(iter(_CACHE)))
                _CACHE[key] = (now, deepcopy(value), size, ttl)
        pending.set_result(value)
        return deepcopy(value)
    except Exception as exc:
        pending.set_exception(exc)
        raise
    finally:
        with _LOCK:
            _PENDING.pop(key, None)


def _fund_identity(inst, *, etf=False):
    rows = _cached_call("fund_catalog")["rows"]
    matches = [
        r for r in rows if isinstance(r, list) and len(r) == 3 and r[0] == inst["code"]
    ]
    if len(matches) != 1:
        _error("identity_mismatch", "AKShare 基金目录未提供唯一产品身份")
    _, name, category = matches[0]
    if (
        not isinstance(name, str)
        or not isinstance(category, str)
        or not name
        or not category
    ):
        _error("identity_mismatch", "AKShare 基金身份信息不完整")
    if "货币" in category or "货币" in name:
        _error("unsupported_money_fund", "货币基金不作为普通单位净值")
    if (
        any(word in name for word in ("美元", "港元", "港币", "欧元"))
        and "人民币" not in name
    ):
        _error("currency_mismatch", "AKShare 基金份额币种尚未核实为人民币")
    if etf and "ETF" not in name.upper():
        _error("identity_mismatch", "AKShare 目录未将此产品识别为 ETF")
    return name


def _stock_identity(inst):
    rows = _cached_call("stock_identity", code=inst["code"])["rows"]
    identity = {r.get("item"): r.get("value") for r in rows if isinstance(r, dict)}
    if identity.get("股票代码") != inst["code"] or not identity.get("股票简称"):
        _error("identity_mismatch", "AKShare 返回的股票代码不一致")
    return identity["股票简称"]


def _option_identity(inst):
    product, symbol = _contract(inst)
    _validate_exchange(inst, product)
    normalized = md.normalize_commodity_contract(inst["code"])
    right = "看涨" if normalized["specification"]["option_right"] == "call" else "看跌"
    contract = re.match(r"[a-z]+[0-9]{4}", symbol)[0]
    rows = _cached_call("option_identity", product=product, contract=contract)["rows"]
    column = f"{right}合约-{right}期权合约"
    matches = [
        r
        for r in rows
        if isinstance(r, dict)
        and str(r.get(column, "")).replace("-", "").upper() == symbol.upper()
    ]
    if len(matches) != 1:
        _error("identity_mismatch", "AKShare 未找到该期权的准确合约")
    return normalized["name"], symbol


def _validate_exchange(inst, product):
    specified = inst["specification"].get("exchange")
    if specified and str(specified).upper() != _PRODUCTS[product][1]:
        _error("identity_mismatch", "产品交易所与 AKShare 合约身份不一致")


def _completed(day):
    now = md._now().astimezone(md.SHANGHAI)
    return day < now.date() or (day == now.date() and now.hour >= 16)


def _normalized(inst, row, name, interface, fetched_at, *, nav=False, historical=False):
    if not isinstance(row, dict):
        _error("invalid_response", "AKShare 行情格式无效")
    day = md._date(row.get("净值日期") if nav else row.get("日期", row.get("date")))
    if day is None or day > md._now().astimezone(md.SHANGHAI).date():
        _error("invalid_date", "AKShare 未提供有效行情归属日期")
    value = row.get("单位净值") if nav else row.get("收盘", row.get("close"))
    if md._number(value, positive=True) is None:
        _error("invalid_price", "AKShare 未提供有效价格")
    group = (
        "eastmoney_fund" if nav else "sina" if inst["kind"] == "option" else "eastmoney"
    )
    result = md._quote(
        inst,
        price=value,
        kind="official_nav" if nav else "close",
        source="AKShare·天天基金单位净值"
        if nav
        else "AKShare·新浪期权日线收盘"
        if inst["kind"] == "option"
        else "AKShare·东方财富日线收盘",
        economic_date=day,
        published_at=None,
        change_percent=row.get("日增长率") if nav else row.get("涨跌幅"),
        name=name,
        historical=historical,
        provider_id="akshare",
        source_group=group,
        upstream_provider_id=group,
        source_group_name="天天基金/东方财富"
        if group in {"eastmoney_fund", "eastmoney"}
        else "新浪财经",
        interface_name=interface,
        identity_verified=True,
        feed_delay="净值按归属日期展示，不提供盘中估值"
        if nav
        else "日线收盘行情，不提供盘中估值",
        sdk_version=SDK_VERSION,
    )
    result["fetched_at"] = fetched_at
    if inst["kind"] == "option":
        product, _ = _contract(inst)
        result.update(
            is_derivative=True,
            exchange=_PRODUCTS[product][1],
            quote_unit=md.COMMODITY_PRODUCTS[product]["unit"],
        )
    return result


def _rows(instrument, start, end):
    inst = md._instrument(instrument)
    kind = inst["kind"]
    if kind == "fund":
        name, job, params = (
            _fund_identity(inst),
            "fund_nav",
            {"code": inst["code"], "start": start.isoformat(), "end": end.isoformat()},
        )
    elif kind == "stock":
        name, job, params = (
            _stock_identity(inst),
            "stock_history",
            {"code": inst["code"], "start": start.isoformat(), "end": end.isoformat()},
        )
    elif kind == "etf":
        name, job, params = (
            _fund_identity(inst, etf=True),
            "etf_history",
            {"code": inst["code"], "start": start.isoformat(), "end": end.isoformat()},
        )
    elif kind == "option":
        name, symbol = _option_identity(inst)
        job, params = "option_history", {"symbol": symbol}
    else:
        _error("unsupported_history", "AKShare 暂未接入此类历史行情")
    data = _cached_call(job, **params)
    result = []
    for row in data["rows"]:
        day = (
            md._date(
                row.get("净值日期")
                if kind == "fund"
                else row.get("日期", row.get("date"))
            )
            if isinstance(row, dict)
            else None
        )
        if day is None:
            _error("invalid_date", "AKShare 返回了缺少日期的行情")
        if start <= day <= end and (kind == "fund" or _completed(day)):
            if kind == "stock" and row.get("股票代码") != inst["code"]:
                _error("identity_mismatch", "AKShare 历史股票代码不一致")
            result.append(
                _normalized(
                    inst,
                    row,
                    name,
                    data["interface_name"],
                    data["fetched_at"],
                    nav=kind == "fund",
                    historical=True,
                )
            )
    by_date = {}
    for row in result:
        previous = by_date.get(row["economic_date"])
        if previous and previous["price"] != row["price"]:
            _error("conflicting_history", "AKShare 同日历史价格存在冲突")
        by_date[row["economic_date"]] = row
    return list(sorted(by_date.values(), key=lambda q: q["economic_date"]))


def _quote_impl(instrument):
    inst = md._instrument(instrument)
    if not supports(inst):
        _error("unsupported_akshare", "AKShare 暂不支持此产品或币种")
    today = md._now().astimezone(md.SHANGHAI).date()
    if inst["kind"] != "future":
        rows = _rows(inst, today - timedelta(days=90), today)
        if not rows:
            _error("missing_price", "AKShare 尚无可用的正式净值或已完成收盘行情")
        latest = rows[-1]
        # Freshness is evaluated on the actual price date, never the fetch date.
        result = md._quote(
            inst,
            price=latest["price"],
            kind=latest["kind"],
            economic_date=latest["economic_date"],
            published_at=None,
            change_percent=latest["change_percent"],
            name=latest["name"],
        )
        return latest | {
            key: result[key] for key in ("status", "data_state", "message")
        }
    product, month = _contract(inst)
    _validate_exchange(inst, product)
    data = _cached_call("future_quotes", product=product)
    matches = [
        r
        for r in data["rows"]
        if isinstance(r, dict)
        and str(r.get("symbol", "")).upper() == (product + month).upper()
    ]
    if len(matches) != 1:
        _error("identity_mismatch", "AKShare 未找到该期货的准确合约")
    row = matches[0]
    if str(row.get("exchange", "")).upper() != _PRODUCTS[product][1]:
        _error("identity_mismatch", "AKShare 返回的期货交易所不一致")
    day = md._date(row.get("tradedate"))
    if (
        day is None
        or day > today + timedelta(days=1)
        or md._number(row.get("trade"), positive=True) is None
    ):
        _error("invalid_price", "AKShare 未提供有效期货价格和交易日")
    clock = str(row.get("ticktime", "")).strip()
    stamp = md._timestamp(clock)
    clock_only = bool(re.fullmatch(r"[0-9]{2}:[0-9]{2}:[0-9]{2}", clock))
    if clock_only:
        candidate = md._timestamp(f"{day.isoformat()}T{clock}")
        if candidate is None:
            _error("invalid_time", "AKShare 期货行情时间无效")
        # Sina's trade date can name the next session rather than the natural day.
        stamp = candidate if 9 <= candidate.hour < 18 and day <= today else None
    elif stamp is None:
        _error("invalid_time", "AKShare 未提供有效的期货行情时间")
    if stamp and stamp > md._now() + timedelta(minutes=5):
        stamp = None  # Night-session trading day may differ from calendar date.
    previous_settlement = md._number(row.get("presettlement"), positive=True)
    change = (
        ((Decimal(str(row["trade"])) / Decimal(previous_settlement)) - 1) * 100
        if previous_settlement
        else None
    )
    result = md._quote(
        inst,
        price=row["trade"],
        kind="market",
        source="AKShare·新浪期货行情",
        economic_date=day,
        published_at=stamp,
        name=row.get("name"),
        change_percent=change,
        provider_id="akshare",
        source_group="sina",
        upstream_provider_id="sina",
        source_group_name="新浪财经",
        interface_name=data["interface_name"],
        identity_verified=True,
        feed_delay="第三方实时/延迟行情；动态结算不作为正式结算",
        sdk_version=SDK_VERSION,
        is_derivative=True,
        exchange=_PRODUCTS[product][1],
        quote_unit=md.COMMODITY_PRODUCTS[product]["unit"],
        source_clock=clock,
        timestamp_quality="published_time" if stamp else "source_clock_only",
        timestamp_message=""
        if stamp
        else "来源仅提供时钟和交易日；夜盘自然日期尚未核实",
        previous_settlement=previous_settlement,
        dynamic_settlement=md._number(row.get("settlement"), positive=True),
    )
    result["fetched_at"] = data["fetched_at"]
    return result


def _history_impl(instrument, start, end):
    inst = md._instrument(instrument)
    if not supports(inst, "history"):
        _error("unsupported_history", "AKShare 暂不支持此产品历史行情")
    start, end = md._date(start), md._date(end)
    if start is None or end is None or start > end or (end - start).days > 7_305:
        _error("invalid_range", "行情日期范围无效或超过 20 年")
    rows = _rows(inst, start, end)
    if not rows:
        _error("missing_history", "AKShare 在该日期范围内未提供行情")
    return rows


def quote(instrument):
    token = _DEADLINE.set(time.monotonic() + OPERATION_TIMEOUT)
    try:
        return _quote_impl(instrument)
    finally:
        _DEADLINE.reset(token)


def history(instrument, start, end):
    token = _DEADLINE.set(time.monotonic() + OPERATION_TIMEOUT)
    try:
        return _history_impl(instrument, start, end)
    finally:
        _DEADLINE.reset(token)


def _plain(value):
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, float):
        return str(value) if math.isfinite(value) else None
    if isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if hasattr(value, "item"):
        return _plain(value.item())
    return str(value)


def _bounded_http_get(url, **kwargs):
    """Disposable-worker transport; the global requests module is never patched."""
    import requests

    parsed = urlsplit(str(url))
    if (
        parsed.scheme != "https"
        or parsed.hostname not in _NETWORK_HOSTS
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        _error("unsafe_url", "AKShare 行情地址不在允许列表中")
    if set(kwargs) - {"params", "headers", "timeout"}:
        _error("invalid_request", "AKShare 行情请求参数无效")
    with requests.Session() as session:
        session.trust_env = False
        verify = (
            os.environ.get("REQUESTS_CA_BUNDLE")
            or os.environ.get("CURL_CA_BUNDLE")
            or True
        )
        with session.get(
            url,
            params=kwargs.get("params"),
            headers=kwargs.get("headers"),
            timeout=8,
            allow_redirects=False,
            stream=True,
            verify=verify,
        ) as response:
            if 300 <= response.status_code < 400:
                _error("provider_redirect", "AKShare 行情源发生重定向，已停止请求")
            response.raise_for_status()
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > 8 * 1024 * 1024:
                _error("response_too_large", "AKShare 行情响应超出大小限制")
            chunks, size = [], 0
            for chunk in response.iter_content(chunk_size=65_536):
                size += len(chunk)
                if size > 8 * 1024 * 1024:
                    _error("response_too_large", "AKShare 行情响应超出大小限制")
                chunks.append(chunk)
            # SDK methods expect requests.Response.text/json/encoding, with the
            # complete, bounded body available even after the socket is closed.
            response._content = b"".join(chunks)
            response._content_consumed = True
            return response


def _guard_sdk_transport():
    transport = SimpleNamespace(get=_bounded_http_get)
    for name in _SDK_MODULES:
        import_module(name).requests = transport


def _sdk_rows(ak, job, params):
    """Fixed method/argument mapping; no SDK method names or URLs from a user."""
    _validate_job(job, params)
    if job == "fund_catalog":
        frame = ak.fund_name_em()
        if len(frame) > MAX_ROWS:
            _error("response_too_large", "AKShare 目录过大")
        return _plain(frame[["基金代码", "基金简称", "基金类型"]].values.tolist())
    if job == "fund_nav":
        frame = ak.fund_etf_fund_info_em(
            fund=params["code"],
            start_date=params["start"].replace("-", ""),
            end_date=params["end"].replace("-", ""),
        )
    elif job == "stock_identity":
        frame = ak.stock_individual_info_em(symbol=params["code"], timeout=8)
    elif job == "stock_history":
        frame = ak.stock_zh_a_hist(
            symbol=params["code"],
            period="daily",
            start_date=params["start"].replace("-", ""),
            end_date=params["end"].replace("-", ""),
            adjust="",
            timeout=8,
        )
    elif job == "etf_history":
        frame = ak.fund_etf_hist_em(
            symbol=params["code"],
            period="daily",
            start_date=params["start"].replace("-", ""),
            end_date=params["end"].replace("-", ""),
            adjust="",
        )
    elif job == "future_quotes":
        frame = ak.futures_zh_realtime(symbol=_PRODUCTS[params["product"]][0])
    elif job == "option_identity":
        frame = ak.option_commodity_contract_table_sina(
            symbol=_PRODUCTS[params["product"]][0] + "期权", contract=params["contract"]
        )
    elif job == "option_history":
        frame = ak.option_commodity_hist_sina(symbol=params["symbol"])
    else:
        _error("unsupported_interface", "AKShare 接口不在允许列表中")
    if len(frame) > MAX_ROWS:
        _error("response_too_large", "AKShare 数据过大")
    return _plain(frame.to_dict(orient="records"))


def _worker_main():
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES + 1, MAX_BYTES + 1))
        resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT + 2, TIMEOUT + 3))
        if sys.platform.startswith("linux"):
            # Bound a disposable pandas worker, including malformed oversized feeds.
            limit = 2 * 1024 * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ImportError, OSError, ValueError):
        pass
    try:
        request = json.loads(sys.stdin.buffer.read(2_049))
        if not isinstance(request, dict) or set(request) != {"job", "params"}:
            _error("invalid_request", "AKShare 请求格式无效")
        _validate_job(request["job"], request["params"])
        with (
            open(os.devnull, "w") as quiet,
            contextlib.redirect_stdout(quiet),
            contextlib.redirect_stderr(quiet),
        ):
            import akshare as ak

            if ak.__version__ != SDK_VERSION:
                _error("provider_unconfigured", "AKShare 版本尚未正确安装")
            _guard_sdk_transport()
            rows = _sdk_rows(ak, request["job"], request["params"])
        result = {"ok": True, "rows": rows}
    except ImportError:
        result = {"ok": False, "code": "provider_unconfigured"}
    except md.MarketDataError as exc:
        result = {"ok": False, "code": exc.code}
    except Exception:
        result = {"ok": False, "code": "provider_unavailable"}
    raw = json.dumps(result, ensure_ascii=False, allow_nan=False).encode()
    if len(raw) > MAX_BYTES:
        raw = b'{"ok":false,"code":"response_too_large"}'
    sys.stdout.buffer.write(raw)


if __name__ == "__main__":
    _worker_main()
