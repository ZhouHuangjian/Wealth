"""Persistent public market metadata; local search never performs network I/O.

Only fixed seeds or provider-confirmed products enter this table. User portfolio
objects, account links, custom names and raw search queries are never cached.
"""

import re
import unicodedata
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone

from django.db import transaction
from django.db.models import Case, IntegerField, Q, Value, When
from django.utils import timezone

from . import market_data
from .catalog_models import MarketSymbol
from .provider_policy import get_provider_config, provider_chain

KINDS = {"fund", "stock", "etf", "future", "option", "index", "gold"}
PUBLIC_SPEC_FIELDS = {
    "fund_type",
    "institution",
    "quote_provider",
    "exchange",
    "provider_symbol",
    "quote_unit",
    "is_derivative",
    "asset_class",
    "reference_only",
    "is_index",
    "product_code",
    "contract_month",
    "option_right",
    "strike",
    "contract_multiplier",
    "metadata_source",
}


def normalize_query(value):
    text = unicodedata.normalize("NFKC", str(value or "")).strip().casefold()
    return re.sub(r"[\s\-_^./&()（）]", "", text)


def _public_row(row, source, *, status="metadata_only"):
    code, name = str(row.get("code", "")).strip(), str(row.get("name", "")).strip()
    kind, market, currency = (
        str(row.get("kind", "")),
        str(row.get("market", "")).upper(),
        str(row.get("currency", "")).upper(),
    )
    if (
        kind not in KINDS
        or market not in {"CN", "HK", "US"}
        or currency not in {"CNY", "HKD", "USD"}
        or not re.fullmatch(r"[A-Za-z0-9.^\-]{1,60}", code)
        or not name
        or len(name) > 160
    ):
        return None
    aliases = [
        str(x).strip()[:120]
        for x in row.get("aliases", [])
        if isinstance(x, str) and x.strip()
    ][:20]
    supplied = row.get("specification", {})
    if not isinstance(supplied, dict):
        supplied = {}
    specification = {
        key: supplied[key]
        for key in PUBLIC_SPEC_FIELDS
        if key in supplied and isinstance(supplied[key], (str, bool, int))
    }
    text = " ".join(dict.fromkeys(normalize_query(x) for x in [code, name, *aliases]))[
        :1600
    ]
    return {
        "code": code,
        "name": name,
        "kind": kind,
        "market": market,
        "currency": currency,
        "aliases": aliases,
        "search_text": text,
        "specification": specification,
        "source": source[:80],
        "status": status,
        "refreshed_at": timezone.now(),
    }


def _upsert_public(rows, source, *, status="verified", limit=50000):
    """Internal only: caller passes provider output, never user-authored payloads."""
    normalized = {}
    for row in rows[:limit]:
        item = _public_row(row, source, status=status)
        if item:
            normalized[
                (item["kind"], item["market"], item["code"], item["currency"])
            ] = MarketSymbol(**item)
    if normalized:
        # Keep already verified public aliases when a narrower provider response
        # omits them. Raw search terms are deliberately not part of this union.
        existing = MarketSymbol.objects.filter(
            code__in={item.code for item in normalized.values()}
        ).only("kind", "market", "code", "currency", "aliases", "specification")
        for previous in existing:
            identity = (
                previous.kind,
                previous.market,
                previous.code,
                previous.currency,
            )
            if identity in normalized:
                item = normalized[identity]
                item.aliases = list(dict.fromkeys([*previous.aliases, *item.aliases]))[
                    :20
                ]
                item.specification = {**previous.specification, **item.specification}
                item.search_text = " ".join(
                    dict.fromkeys(
                        normalize_query(value)
                        for value in [item.code, item.name, *item.aliases]
                    )
                )[:1600]
        with transaction.atomic():
            MarketSymbol.objects.bulk_create(
                list(normalized.values()),
                batch_size=500,
                update_conflicts=True,
                unique_fields=["kind", "market", "code", "currency"],
                update_fields=[
                    "name",
                    "aliases",
                    "search_text",
                    "specification",
                    "source",
                    "status",
                    "refreshed_at",
                ],
            )
    return len(normalized)


def seed_rows():
    from .instrument_metadata import FUTURES_PRODUCTS

    rows = []
    for code, data in market_data.INDEX_SPECS.items():
        rows.append(
            {
                "code": code,
                "name": data["name"],
                "kind": "index",
                "market": data["market"],
                "currency": data["currency"],
                "aliases": data["aliases"],
                "specification": {
                    "provider_symbol": data["provider_symbol"],
                    "quote_unit": "指数点",
                    "is_index": True,
                    "quote_provider": "yahoo"
                    if data["market"] == "US"
                    else "eastmoney",
                },
            }
        )
    for code, name, market, aliases in [
        ("600519", "贵州茅台", "CN", ["茅台", "GZMT"]),
        ("000001", "平安银行", "CN", ["PAYH"]),
        ("600036", "招商银行", "CN", ["招行", "ZSYH"]),
        ("00700", "腾讯控股", "HK", ["腾讯", "tencent"]),
        ("AAPL", "苹果", "US", ["apple"]),
        ("MSFT", "微软", "US", ["microsoft"]),
        ("NVDA", "英伟达", "US", ["nvidia"]),
        ("TSLA", "特斯拉", "US", ["tesla"]),
    ]:
        rows.append(
            {
                "code": code,
                "name": name,
                "kind": "stock",
                "market": market,
                "currency": {"CN": "CNY", "HK": "HKD", "US": "USD"}[market],
                "aliases": aliases,
            }
        )
    for code, name in [
        ("110022", "易方达消费行业股票"),
        ("161725", "招商中证白酒指数(LOF)A"),
        ("050025", "博时标普500ETF联接A"),
    ]:
        rows.append(
            {
                "code": code,
                "name": name,
                "kind": "fund",
                "market": "CN",
                "currency": "CNY",
                "aliases": [],
            }
        )
    for code, spec in market_data.COMMODITY_PRODUCTS.items():
        rows.append(
            {
                "code": code.upper() + "0",
                "name": spec["name"] + "连续",
                "kind": "future",
                "market": "CN",
                "currency": "CNY",
                "aliases": [spec["name"], code, spec["name"] + "期货"],
                "specification": {
                    "exchange": spec["exchange"],
                    "is_derivative": True,
                    "reference_only": True,
                    "quote_unit": spec["unit"],
                },
            }
        )
    # Public environment benchmarks, not tradable dated contracts. Their names
    # and exchange come from the shared exchange rule catalogue; missing prices
    # remain unavailable, and no contract multiplier or settlement is invented.
    for code in [
        "AG",
        "AL",
        "ZN",
        "NI",
        "SN",
        "AO",
        "SC",
        "RU",
        "FU",
        "BU",
        "NR",
        "LU",
        "J",
        "JM",
        "CF",
        "SR",
        "TA",
        "MA",
        "FG",
        "SA",
        "AP",
        "JD",
        "LH",
        "SI",
        "LC",
        "IF",
        "IH",
        "IC",
        "IM",
        "T",
        "TF",
        "TS",
        "TL",
    ]:
        spec = FUTURES_PRODUCTS[code]
        rows.append(
            {
                "code": code + "0",
                "name": spec["name"] + "连续",
                "kind": "future",
                "market": "CN",
                "currency": "CNY",
                "aliases": [spec["name"], code, spec["name"] + "期货"],
                "specification": {
                    "exchange": spec["exchange"],
                    "is_derivative": True,
                    "reference_only": True,
                    "quote_unit": "合约报价",
                    "metadata_source": spec["source"],
                },
            }
        )
    rows.extend(
        [
            {
                "code": "XAU",
                "name": "伦敦金现货",
                "kind": "gold",
                "market": "CN",
                "currency": "USD",
                "aliases": ["国际黄金", "伦敦金", "XAUUSD", "黄金现货"],
                "specification": {
                    "quote_provider": "sina",
                    "quote_unit": "USD/金衡盎司",
                    "asset_class": "gold",
                    "reference_only": True,
                },
            },
            {
                "code": "518880",
                "name": "华安黄金ETF",
                "kind": "etf",
                "market": "CN",
                "currency": "CNY",
                "aliases": ["黄金ETF", "华安黄金"],
                "specification": {
                    "quote_provider": "tencent",
                    "quote_unit": "每份",
                    "asset_class": "gold",
                },
            },
            {
                "code": "510300",
                "name": "华泰柏瑞沪深300ETF",
                "kind": "etf",
                "market": "CN",
                "currency": "CNY",
                "aliases": ["沪深300ETF"],
                "specification": {"quote_provider": "tencent", "quote_unit": "每份"},
            },
        ]
    )
    return rows


def seed_catalog():
    """Explicit cold-start action; deliberately never called by a GET search."""
    missing = []
    identities = set(
        MarketSymbol.objects.values_list("kind", "market", "code", "currency")
    )
    for row in seed_rows():
        if (row["kind"], row["market"], row["code"], row["currency"]) not in identities:
            missing.append(row)
    return _upsert_public(missing, "verified_public_seed", status="metadata_only")


def _serialize(row):
    return {
        "catalog_id": str(row.pk),
        "code": row.code,
        "name": row.name,
        "kind": row.kind,
        "market": row.market,
        "currency": row.currency,
        "aliases": row.aliases,
        "specification": row.specification,
        "source": row.source,
        "status": row.status,
        "refreshed_at": row.refreshed_at.isoformat(),
    }


def browse_catalog(kind="", market="", query="", offset=0, limit=50):
    """Public cached candidates only; empty queries show seeded environment assets."""
    kind, market, query = (
        str(kind or ""),
        str(market or "").upper(),
        str(query or "").strip(),
    )
    if (
        (kind and kind not in KINDS)
        or (market and market not in {"CN", "HK", "US"})
        or len(query) > 80
    ):
        return {"items": [], "count": 0, "has_more": False}
    try:
        offset, limit = min(50000, max(0, int(offset))), min(100, max(1, int(limit)))
    except (ValueError, TypeError):
        offset, limit = 0, 50
    qs = MarketSymbol.objects.all()
    if kind:
        qs = qs.filter(kind=kind)
    if market:
        qs = qs.filter(market=market)
    if query:
        qs = qs.filter(search_text__icontains=normalize_query(query))
    count = qs.count()
    qs = qs.annotate(
        seed_rank=Case(
            When(source="verified_public_seed", then=Value(0)),
            default=Value(1),
            output_field=IntegerField(),
        ),
        kind_rank=Case(
            When(kind="index", then=Value(0)),
            When(kind="gold", then=Value(1)),
            When(kind="future", then=Value(2)),
            default=Value(3),
            output_field=IntegerField(),
        ),
    ).order_by("seed_rank", "kind_rank", "kind", "market", "code")
    return {
        "items": [_serialize(row) for row in qs[offset : offset + limit]],
        "count": count,
        "has_more": offset + limit < count,
    }


def _local(query, kind, market, limit):
    normalized = normalize_query(query)
    qs = MarketSymbol.objects.filter(kind=kind, market=market)
    terms = [normalize_query(x) for x in str(query).split() if normalize_query(x)][:5]
    if normalized:
        direct = Q(search_text__icontains=normalized)
        if len(terms) > 1:
            separated = Q()
            for term in terms:
                separated &= Q(search_text__icontains=term)
            direct |= separated
        qs = qs.filter(direct)
    count = qs.count()
    rows = list(
        qs.annotate(
            rank=Case(
                When(code__iexact=str(query).strip(), then=Value(0)),
                When(name__iexact=str(query).strip(), then=Value(1)),
                default=Value(2),
                output_field=IntegerField(),
            )
        ).order_by("rank", "code")[:limit]
    )
    return rows, count


def _remote_rows(query, kind, market):
    config = get_provider_config()
    if kind == "index":
        wanted = normalize_query(query)
        results = []
        for row in seed_rows():
            if (
                row["kind"] == "index"
                and row["market"] == market
                and any(
                    wanted in normalize_query(x)
                    for x in [row["code"], row["name"], *row["aliases"]]
                )
            ):
                quote = market_data.fetch_quote(row, provider_config=config)
                if quote["status"] in {"ok", "stale"}:
                    results.append(row)
        return results
    return market_data.search_products(query, kind, market, provider_config=config)


def search_catalog(query, kind="fund", market="CN", remote=False, limit=20):
    """Local, bounded, parameterized lookup. Only explicit remote=True uses APIs."""
    query, kind, market = str(query or "").strip(), str(kind), str(market).upper()
    if (
        not query
        or len(query) > 80
        or kind not in KINDS
        or market not in {"CN", "HK", "US"}
    ):
        return {
            "items": [],
            "source": "local",
            "local_count": 0,
            "refreshed_at": None,
            "status": "empty",
            "message": "请输入有效的产品名称或代码",
        }
    try:
        limit = min(50, max(1, int(limit)))
    except (ValueError, TypeError):
        limit = 20
    canonical = (
        (
            market_data.normalize_commodity_contract(query)
            if kind == "option"
            else market_data.normalize_commodity_future(query)
        )
        if kind in {"option", "future"} and market == "CN"
        else None
    )
    lookup = canonical["code"] if canonical else query
    rows, local_count = _local(lookup, kind, market, limit)
    source, status, message = "local", "ok" if rows else "empty", ""
    remote_status = "not_requested"
    if remote is True:
        try:
            confirmed = _remote_rows(lookup, kind, market)
            confirmed_count = _upsert_public(
                confirmed, "public_provider_search", limit=50
            )
            source = "mixed" if local_count else "remote"
            # Upstream may understand an alias absent from its official name.
            # Return confirmed identities directly; do not persist user queries
            # as public aliases (which could leak a private custom description).
            identities = Q(pk__in=[])
            for row in confirmed[:50]:
                public = _public_row(row, "public_provider_search")
                if public:
                    identities |= Q(
                        **{
                            key: public[key]
                            for key in ("kind", "market", "code", "currency")
                        }
                    )
            fetched = list(
                MarketSymbol.objects.filter(identities).order_by("code")[:limit]
            )
            seen = {row.pk for row in fetched}
            rows = (fetched + [row for row in rows if row.pk not in seen])[:limit]
            remote_status = "ok" if confirmed_count else "unavailable"
            status = "ok" if confirmed_count else "unavailable"
            message = (
                "" if confirmed_count else "公开源暂未确认匹配产品，已保留本地目录结果"
            )
        except market_data.MarketDataError as exc:
            status, message = "unavailable", exc.message
            remote_status = "unavailable"
    items = [_serialize(row) for row in rows]
    if not items and canonical:
        # Interpretation only; never persist an unverified listing or query.
        items = [
            {
                **canonical,
                "source": "notation",
                "status": "unverified",
                "refreshed_at": None,
                "message": "代码格式已识别，尚未验证是否上市及行情可用性；请选择后查询",
            }
        ]
        if status != "unavailable":
            status = "unverified"
    return {
        "items": items,
        "source": source,
        "local_count": local_count,
        "refreshed_at": max(
            (item["refreshed_at"] for item in items if item.get("refreshed_at")),
            default=None,
        ),
        "status": status,
        "message": message,
        "remote_requested": remote is True,
        "remote_status": remote_status,
    }


def _fund_directory():
    text = market_data._get(
        "https://fund.eastmoney.com/js/fundcode_search.js", max_bytes=8_000_000
    )
    data = market_data._js_value(text, "r")
    if not isinstance(data, list) or len(data) > 60000:
        raise market_data.MarketDataError("invalid_directory", "基金目录响应异常")
    rows = []
    for item in data:
        if (
            not isinstance(item, list)
            or len(item) < 5
            or not re.fullmatch(r"\d{6}", str(item[0]))
        ):
            continue
        name = str(item[2])
        # Explicit foreign-currency share names stay correctly labelled; a fund
        # investing in USD bonds is not automatically a USD-denominated share.
        currency = (
            "USD"
            if re.search(r"美元(?:现汇|现钞|份额|[ABC]类?$)|\(美元\)", name)
            else "HKD"
            if "港币份额" in name
            else "CNY"
        )
        rows.append(
            {
                "code": item[0],
                "name": name,
                "kind": "fund",
                "market": "CN",
                "currency": currency,
                "aliases": [str(item[1]), str(item[4])],
                "specification": {
                    "fund_type": str(item[3]),
                    "quote_provider": "eastmoney",
                },
            }
        )
    return rows


def refresh_catalog(limit=40000, include_funds=True, force=False):
    """Daily background/management entry; never called implicitly by search."""
    limit = min(50000, max(1, int(limit)))
    seeded = seed_catalog()
    latest = (
        MarketSymbol.objects.filter(source="eastmoney_fund_directory")
        .order_by("-refreshed_at")
        .first()
    )
    if not include_funds:
        return {"status": "ready", "seeded": seeded, "updated": 0}
    if "eastmoney_fund" not in provider_chain(get_provider_config(), "fund"):
        return {
            "status": "disabled",
            "seeded": seeded,
            "updated": 0,
            "message": "基金公开目录数据源已停用",
        }
    if (
        not force
        and latest
        and timezone.now() - latest.refreshed_at < timedelta(hours=20)
    ):
        return {
            "status": "up_to_date",
            "seeded": seeded,
            "updated": 0,
            "refreshed_at": latest.refreshed_at.isoformat(),
        }
    try:
        rows = _fund_directory()
        # If the caller limits a batch, missing codes are selected before older
        # cached entries, so repeated background runs eventually cover the list.
        old = {
            code: stamp
            for code, stamp in MarketSymbol.objects.filter(
                kind="fund", market="CN"
            ).values_list("code", "refreshed_at")
        }
        rows.sort(
            key=lambda row: (
                row["code"] in old,
                old.get(row["code"]) or datetime.min.replace(tzinfo=dt_timezone.utc),
                row["code"],
            )
        )
        updated = _upsert_public(rows[:limit], "eastmoney_fund_directory", limit=limit)
        return {
            "status": "ready",
            "seeded": seeded,
            "updated": updated,
            "available": len(rows),
            "partial": len(rows) > limit,
            "refreshed_at": timezone.now().isoformat(),
        }
    except market_data.MarketDataError as exc:
        return {
            "status": "unavailable",
            "seeded": seeded,
            "updated": 0,
            "message": exc.message,
            "refreshed_at": latest.refreshed_at.isoformat() if latest else None,
        }
