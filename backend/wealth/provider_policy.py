"""Administrator policy for a fixed, public-only set of market adapters.

No arbitrary endpoints, credentials or secrets are accepted. Runtime callers read
the database once per refresh/remote search and pass the snapshot to market_data.
"""

from copy import deepcopy

DEFAULT_PRIORITY = {
    "fund": ["eastmoney_fund"],
    "stock": ["tencent", "yahoo", "eastmoney_search"],
    "etf": ["tencent", "yahoo", "eastmoney_search"],
    "future": ["sina"],
    "option": ["sina"],
    "index": ["yahoo", "tencent", "nasdaq", "cboe", "eastmoney_index"],
    "gold": ["sina", "tencent", "eastmoney_search"],
}

_PROVIDERS = [
    {
        "id": "eastmoney_fund",
        "name": "天天基金 / 东方财富基金",
        "description": "人民币单位净值、可用盘中估值、基金目录及分红公告；分红需核对后记账，货币基金不按普通净值估价。",
        "hosts": [
            "fund.eastmoney.com",
            "fundf10.eastmoney.com",
            "fundsuggest.eastmoney.com",
            "fundcomapi.tiantianfunds.com",
        ],
        "capabilities": [
            {
                "kind": "fund",
                "markets": ["CN"],
                "operations": ["quote", "history", "search", "catalog", "dividends"],
            }
        ],
    },
    {
        "id": "tencent",
        "name": "腾讯财经",
        "description": "境内、港美证券与已验证指数参考行情；历史按市场及代码支持，NDX历史不使用此源。",
        "hosts": ["qt.gtimg.cn", "web.ifzq.gtimg.cn"],
        "capabilities": [
            {
                "kind": kind,
                "markets": ["CN", "HK", "US"],
                "operations": ["quote"],
            }
            for kind in ("stock", "etf")
        ]
        + [
            {"kind": kind, "markets": ["CN", "HK"], "operations": ["history"]}
            for kind in ("stock", "etf")
        ]
        + [
            {
                "kind": "gold",
                "markets": ["CN"],
                "operations": ["quote", "history"],
                "codes": ["境内六位黄金ETF代码"],
            },
            {
                "kind": "index",
                "markets": ["US"],
                "operations": ["quote"],
                "codes": ["NDX", "SPX", "DJI", "IXIC"],
            },
            {
                "kind": "index",
                "markets": ["US"],
                "operations": ["history"],
                "codes": ["SPX", "DJI", "IXIC"],
            },
            {
                "kind": "index",
                "markets": ["CN", "HK"],
                "operations": ["quote", "history"],
                "codes": [
                    "000001",
                    "000300",
                    "000905",
                    "000852",
                    "000922",
                    "399001",
                    "399006",
                    "HSI",
                ],
            },
        ],
    },
    {
        "id": "sina",
        "name": "新浪财经",
        "description": "境内期货、ETF/商品期权和XAU现货参考报价；这些合约目前没有第二自动报价源或历史源。",
        "hosts": ["hq.sinajs.cn"],
        "capabilities": [
            {"kind": kind, "markets": ["CN"], "operations": ["quote", "search"]}
            for kind in ("future", "option", "gold")
        ],
    },
    {
        "id": "yahoo",
        "name": "Yahoo Finance",
        "description": "美股证券、已验证美股指数当前与历史；可能受地区或限流影响。",
        "hosts": ["query1.finance.yahoo.com"],
        "capabilities": [
            {"kind": kind, "markets": ["US"], "operations": ["quote", "history"]}
            for kind in ("stock", "etf", "index")
        ],
    },
    {
        "id": "eastmoney_index",
        "name": "东方财富指数",
        "description": "已验证境内指数及恒生指数点位、日收盘；公开接口可能暂时断连。",
        "hosts": ["push2.eastmoney.com", "push2his.eastmoney.com"],
        "capabilities": [
            {
                "kind": "index",
                "markets": ["CN", "HK"],
                "operations": ["quote", "history"],
            }
        ],
    },
    {
        "id": "nasdaq",
        "name": "Nasdaq 官方",
        "description": "纳斯达克100官方日收盘，非实时行情。",
        "hosts": ["api.nasdaq.com"],
        "capabilities": [
            {
                "kind": "index",
                "markets": ["US"],
                "codes": ["NDX"],
                "operations": ["history"],
            }
        ],
    },
    {
        "id": "cboe",
        "name": "Cboe 官方",
        "description": "VIX约15分钟延迟报价、官方日收盘；不使用ETF或期货代替。",
        "hosts": ["cdn-api.cboe.com"],
        "capabilities": [
            {
                "kind": "index",
                "markets": ["US"],
                "codes": ["VIX"],
                "operations": ["quote", "history"],
            }
        ],
    },
    {
        "id": "eastmoney_search",
        "name": "东方财富证券目录",
        "description": "仅股票、ETF和黄金ETF公开元数据搜索，不提供估值价格。",
        "hosts": ["searchapi.eastmoney.com"],
        "capabilities": [
            {"kind": kind, "markets": ["CN", "HK", "US"], "operations": ["search"]}
            for kind in ("stock", "etf", "gold")
        ],
    },
]


def provider_directory():
    rows = deepcopy(_PROVIDERS)
    for row in rows:
        row["kinds"] = sorted({cap["kind"] for cap in row["capabilities"]})
        row["operations"] = sorted(
            {op for cap in row["capabilities"] for op in cap["operations"]}
        )
    return rows


def default_provider_config():
    return {
        "schema_version": 1,
        "enabled": {p["id"]: True for p in _PROVIDERS},
        "priority": deepcopy(DEFAULT_PRIORITY),
    }


def validate_provider_config(data):
    if not isinstance(data, dict) or set(data) - {
        "schema_version",
        "enabled",
        "priority",
    }:
        raise ValueError(
            "数据源配置只接受 schema_version、enabled 和 priority，不支持自定义URL或密钥"
        )
    if (
        type(data.get("schema_version", 1)) is not int
        or data.get("schema_version", 1) != 1
    ):
        raise ValueError("不支持的数据源配置版本")
    result = default_provider_config()
    flags, priorities = data.get("enabled", {}), data.get("priority", {})
    if not isinstance(flags, dict) or set(flags) - set(result["enabled"]):
        raise ValueError("包含未知数据源")
    if any(type(flag) is not bool for flag in flags.values()):
        raise ValueError("数据源启用状态必须为布尔值")
    if not isinstance(priorities, dict) or set(priorities) - set(DEFAULT_PRIORITY):
        raise ValueError("包含未知产品分类")
    for kind, chain in priorities.items():
        if (
            not isinstance(chain, list)
            or any(not isinstance(p, str) for p in chain)
            or len(chain) != len(set(chain))
            or set(chain) - set(DEFAULT_PRIORITY[kind])
        ):
            raise ValueError("数据源优先级必须是该分类支持的内置源列表，且不能重复")
        result["priority"][kind] = list(chain)
    result["enabled"].update(flags)
    return result


def provider_chain(config, kind):
    config = validate_provider_config(config if config is not None else {})
    return [
        source
        for source in config["priority"].get(kind, [])
        if config["enabled"][source]
    ]


def get_provider_config():
    # Always read: disabling a source takes effect on the next refresh in every
    # web/worker process. A DB error does not silently bypass administrator policy.
    from .platform_models import PlatformSetting

    data = (
        PlatformSetting.objects.filter(pk="market_sources")
        .values_list("data", flat=True)
        .first()
    )
    return validate_provider_config(data if data is not None else {})


def invalidate_provider_config_cache():
    """Compatibility hook for the admin API; there is deliberately no process cache."""
    return
