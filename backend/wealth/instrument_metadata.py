"""Deterministic product identification, explicit ambiguity and manual overrides.

Exchange recognition does not prove that a contract is currently listed. No
accounting facts, prices, currencies or settlement events are written here.
"""

import re
import unicodedata
from copy import deepcopy
from datetime import date, time
from decimal import Decimal

from .common import DomainError
from .trading_calendar import CALENDARS, calendar_info

RULE_VERSION = "2026-09-26"
EXCHANGE_SOURCES = {
    "SHFE": "https://www.shfe.cn/specialtopic/investor/trade/",
    "INE": "https://www.shfe.cn/specialtopic/investor/trade/",
    "DCE": "https://www.dce.com.cn/",
    "CZCE": "https://www.czce.com.cn/cn/content_file/jysj/ydscbg/2026/6/085dd92a2afe42cd9644c0346b493c9e.pdf",
    "CFFEX": "https://www.cffex.com.cn/en_new/DailyData.html",
    "GFEX": "https://www.gfex.com.cn/gfex/sspzb/sspz.shtml",
    "SSE": "https://www.sse.com.cn/assortment/options/",
    "SZSE": "https://www.szse.cn/marketServices/technicalservice/doc/P020240510623040090566.pdf",
    "BSE": "https://www.bse.cn/service/code_mapping.html",
    "HKEX": "https://www.hkex.com.hk/Products/Securities/Stock-Code-Allocation-Plan?sc_lang=en",
}
FUND_RULE_SOURCE = (
    "https://edu.gffunds.com.cn/lcxt/zdjptzjhl/tzjhl1/202405/t20240515_393621.shtml"
)
FOF_RULE_SOURCE = (
    "https://api.efunds.com.cn/xcowch/ui/content/show?ID=520336&platformID=pc"
)
FUND_DAY_SOURCE = (
    "https://gfwx.gffunds.com.cn/html/app/agreement/riskwarning/service.html"
)

# Includes illiquid listed varieties; never identifies a made-up prefix as SHFE.
_VARIETIES = {
    "SHFE": "CU:铜 AL:铝 ZN:锌 PB:铅 NI:镍 SN:锡 AO:氧化铝 AD:铸造铝合金 AU:黄金 AG:白银 RB:螺纹钢 WR:线材 HC:热轧卷板 SS:不锈钢 FU:燃料油 BU:石油沥青 RU:天然橡胶 BR:丁二烯橡胶 SP:纸浆 OP:胶版印刷纸",
    "INE": "SC:原油 NR:20号胶 LU:低硫燃料油 BC:国际铜 EC:集运指数欧线",
    "DCE": "A:黄大豆一号 B:黄大豆二号 C:玉米 CS:玉米淀粉 M:豆粕 Y:豆油 P:棕榈油 BB:胶合板 FB:纤维板 JD:鸡蛋 L:聚乙烯 V:聚氯乙烯 PP:聚丙烯 J:焦炭 JM:焦煤 I:铁矿石 EG:乙二醇 RR:粳米 EB:苯乙烯 PG:液化石油气 LH:生猪 LG:原木 BZ:纯苯",
    "CZCE": "WH:强麦 PM:普麦 CF:棉花 SR:白糖 TA:PTA OI:菜籽油 RI:早籼稻 MA:甲醇 FG:玻璃 RS:油菜籽 RM:菜籽粕 ZC:动力煤 JR:粳稻 LR:晚籼稻 SF:硅铁 SM:锰硅 CY:棉纱 AP:苹果 CJ:红枣 UR:尿素 SA:纯碱 PF:短纤 PK:花生 PX:对二甲苯 SH:烧碱 PR:瓶片 PL:丙烯",
    "CFFEX": "IF:沪深300股指 IH:上证50股指 IC:中证500股指 IM:中证1000股指 T:10年期国债 TF:5年期国债 TS:2年期国债 TL:30年期国债 IO:沪深300股指期权 HO:上证50股指期权 MO:中证1000股指期权",
    "GFEX": "SI:工业硅 LC:碳酸锂 PS:多晶硅 PT:铂 PD:钯",
}
FUTURES_PRODUCTS = {
    item.split(":")[0]: {
        "name": item.split(":")[1],
        "exchange": exchange,
        "source": EXCHANGE_SOURCES[exchange],
    }
    for exchange, words in _VARIETIES.items()
    for item in words.split()
}
EXCHANGE_ALIASES = {
    "SH": "SSE",
    "SS": "SSE",
    "SHSE": "SSE",
    "SZ": "SZSE",
    "BJ": "BSE",
    "SHF": "SHFE",
    "ZCE": "CZCE",
    "CZC": "CZCE",
    "CFX": "CFFEX",
    "GFE": "GFEX",
    "HK": "HKEX",
}
CN_EXCHANGES = {"SSE", "SZSE", "BSE", "SHFE", "INE", "DCE", "CZCE", "CFFEX", "GFEX"}
KINDS = {"fund", "etf", "stock", "future", "option", "gold", "index", "other"}
_IDENTITY_FIELDS = {
    "exchange",
    "calendar_id",
    "subscription_calendar",
    "settlement_rule",
    "is_derivative",
    "trading_channel",
    "product_prefix",
    "product_code",
    "contract_month",
    "contract_verified",
    "option_type",
    "option_right",
    "strike",
    "continuous_contract",
    "underlying_code",
    "is_qdii",
    "is_fof",
    "fund_type",
    "quote_provider",
    "provider_symbol",
    "quote_unit",
    "unit",
    "contract_multiplier",
    "reference_only",
    "observation_only",
    "is_index",
    "asset_class",
    "metadata_identity",
}


def _exchange(value):
    normalized = str(value or "").strip().upper()
    return EXCHANGE_ALIASES.get(normalized, normalized)


def _confirmation_days(value):
    if (
        isinstance(value, bool)
        or not re.fullmatch(r"\d{1,2}", str(value))
        or not 0 <= int(value) <= 30
    ):
        raise DomainError("确认周期应为 0 至 30 个交易日的整数")
    return int(value)


def _settlement_rule(kind, specification, overrides, calendar_id, warnings):
    days = None
    status, label, cutoff, source = (
        "not_applicable",
        "以实际成交与交收记录为准",
        None,
        None,
    )
    if (
        kind == "fund"
        and calendar_id == "CN_EXCHANGE"
        and specification.get("trading_channel") != "exchange"
    ):
        is_qdii, is_fof = specification.get("is_qdii"), specification.get("is_fof")
        days = 3 if is_fof else 2 if is_qdii else 1
        source = FOF_RULE_SOURCE if is_fof else FUND_RULE_SOURCE
        status, cutoff = "estimated", "15:00"
        label = f"建议 T+{days}（待核对本基金规则）"
        warnings.append(
            "确认周期是同类基金的建议值，尚未核实本产品合同及销售渠道规则。"
        )
    manual_days = overrides.get(
        "confirmation_days", specification.get("confirmation_days")
    )
    if "confirmation_days" in overrides and manual_days is None:
        days, status, source, label = (
            None,
            "manual",
            "user_override",
            "人工设置：暂不预估确认日",
        )
    elif manual_days is not None:
        days = _confirmation_days(manual_days)
        status, source, label = "manual", "user_override", f"人工指定 T+{days}"
    manual_cutoff = overrides.get("cutoff_time", specification.get("cutoff_time"))
    if manual_cutoff is not None:
        try:
            parsed = time.fromisoformat(str(manual_cutoff))
            if parsed.tzinfo is not None:
                raise ValueError
            cutoff = parsed.isoformat(timespec="minutes")
        except (ValueError, TypeError):
            raise DomainError("截止时间应为 HH:MM") from None
        status = "manual"
    return {
        "confirmation_days": days,
        "label": label,
        "cutoff_time": cutoff,
        "calendar_id": calendar_id,
        "day_basis": "exchange_trading_days",
        "status": status,
        "source": source,
        "requires_confirmation": status in {"estimated", "manual"},
        "meaning": "subscription_confirmation_not_nav_publication_or_redemption_payment",
    }


def resolve_instrument_metadata(body):
    if not isinstance(body, dict):
        raise DomainError("产品识别参数应为对象")
    code = (
        unicodedata.normalize("NFKC", str(body.get("code") or ""))
        .strip()
        .upper()
        .replace(" ", "")
    )
    if not code or len(code) > 64:
        raise DomainError("请提供长度不超过 64 的产品代码")
    specification = deepcopy(body.get("specification") or {})
    if not isinstance(specification, dict):
        raise DomainError("产品规格应为对象")
    overrides = deepcopy(
        body["overrides"]
        if "overrides" in body
        else specification.get("metadata_overrides", {})
    )
    if not isinstance(overrides, dict):
        raise DomainError("产品规格和人工覆盖应为对象")
    specification.pop("metadata_overrides", None)
    name = str(body.get("name") or "").strip()
    kind = str(body.get("kind") or "").lower()
    kind = {"futures": "future", "options": "option"}.get(kind, kind)
    if kind and kind not in KINDS:
        raise DomainError("不支持的产品类型")
    previous_identity = specification.get("metadata_identity")
    changed_identity = isinstance(previous_identity, dict) and (
        str(previous_identity.get("code") or "").upper() != code
        or kind
        and previous_identity.get("kind") != kind
    )
    # A wizard may carry the last response when the code/type changes. Never
    # let those generated fields configure a different product. Explicit
    # overrides and unrelated tenant settings (e.g. tags) remain intact.
    legacy_conflict = (
        specification.get("metadata_version")
        and not previous_identity
        and re.fullmatch(r"\d{6}", code)
        and kind in {"fund", "etf", "stock", "gold", "index"}
        and (
            _exchange(specification.get("exchange")) in _VARIETIES
            or specification.get("calendar_id") == "CN_FUTURES"
        )
    )
    reset_identity = changed_identity or legacy_conflict
    if reset_identity:
        for field in _IDENTITY_FIELDS:
            specification.pop(field, None)
    market = str(body.get("market") or "").upper()
    exchange = (
        ""
        if reset_identity
        else _exchange(body.get("exchange") or specification.get("exchange"))
    )
    if _exchange(market) in CN_EXCHANGES or _exchange(market) == "HKEX":
        exchange = exchange or _exchange(market)
        market = "HK" if exchange == "HKEX" else "CN"
    if market in {"NYSE", "NASDAQ", "AMEX"}:
        exchange, market = exchange or market, "US"
    currency = str(body.get("currency") or "").upper()
    warnings, sources, candidates = [], [], []
    status = "unknown"
    # Reuse the provider's pure notation parser, so search and manual entry agree.
    from .market_data import normalize_commodity_contract, normalize_commodity_future

    normalized = normalize_commodity_contract(code) or normalize_commodity_future(code)
    canonical_code = None
    if normalized:
        code = normalized["code"].upper()
        canonical_code = normalized["code"]
        name = name or normalized["name"]
        for key, value in normalized["specification"].items():
            specification.setdefault(key, value)
    # Prefix/suffix venue annotations are removed without altering contract digits.
    annotated = re.fullmatch(r"([A-Z]+)[.:](.+)", code)
    if annotated and _exchange(annotated[1]) in CN_EXCHANGES | {
        "HKEX",
        "NYSE",
        "NASDAQ",
    }:
        exchange, code = _exchange(annotated[1]), annotated[2]
    else:
        annotated = re.fullmatch(r"(.+)[.]([A-Z]+)", code)
        if annotated and _exchange(annotated[2]) in CN_EXCHANGES | {
            "HKEX",
            "NYSE",
            "NASDAQ",
        }:
            code, exchange = annotated[1], _exchange(annotated[2])
    simple_prefix = re.fullmatch(r"(SH|SZ|BJ|HK)(\d{5,8})", code)
    if simple_prefix:
        exchange, code = _exchange(simple_prefix[1]), simple_prefix[2]
    future = re.fullmatch(
        r"([A-Z]{1,3})(\d{3,4}|0)(F)?(?:-?([CP])-?(\d+(?:\.\d+)?))?", code
    )
    option_code = re.fullmatch(
        r"(\d{6})([CP])(\d{4})([A-Z])(\d{5,6})([A-Z#]{0,2})", code
    )
    occ = re.fullmatch(r"([A-Z.]{1,6})(\d{6})([CP])(\d{8})", code)
    if future and future[1] in FUTURES_PRODUCTS:
        product = FUTURES_PRODUCTS[future[1]]
        month = future[2]
        if month != "0" and not 1 <= int(month[-2:]) <= 12:
            raise DomainError("期货合约月份应为 01 至 12")
        inferred_kind = (
            "option" if future[4] or future[1] in {"IO", "MO", "HO"} else "future"
        )
        kind, market, currency = inferred_kind, "CN", "CNY"
        if exchange and exchange != product["exchange"]:
            warnings.append(
                f"代码前缀对应 {product['exchange']}，原交易所线索不一致，已使用品种规则。"
            )
        exchange = product["exchange"]
        name = name or f"{product['name']}{month}"
        specification.update(
            product_prefix=future[1], is_derivative=True, contract_verified=False
        )
        if future[4]:
            if Decimal(future[5]) <= 0:
                raise DomainError("期权行权价必须大于零")
            specification.update(
                option_type="call" if future[4] == "C" else "put", strike=future[5]
            )
        if month == "0":
            specification["continuous_contract"] = True
            warnings.append(
                "连续/主连代码用于观察行情，不代表可直接成交的具体月份合约。"
            )
        sources.append(product["source"])
        warnings.append(
            "交易所按品种代码识别；具体合约、行权价及是否仍挂牌须向交易所或券商核对。"
        )
        status = "identified"
    elif future:
        warnings.append("未识别该衍生品前缀，不能自动指派交易所；请核对合约信息。")
    elif occ:
        try:
            date(2000 + int(occ[2][:2]), int(occ[2][2:4]), int(occ[2][4:6]))
        except ValueError:
            raise DomainError("美股期权到期日期无效") from None
        kind, market, currency, status = "option", "US", "USD", "inferred"
        specification.update(
            is_derivative=True,
            contract_verified=False,
            underlying_code=occ[1],
            option_type="call" if occ[3] == "C" else "put",
            strike=format(Decimal(occ[4]) / 1000, "f"),
        )
    elif re.fullmatch(r"[19]\d{7}", code) or option_code:
        kind, market, currency = "option", "CN", "CNY"
        exchange = (
            ("SSE" if code.startswith("1") else "SZSE")
            if not option_code
            else ("SSE" if option_code[1].startswith("5") else "SZSE")
        )
        specification.update(is_derivative=True, contract_verified=False)
        if option_code:
            specification["underlying_code"] = option_code[1]
            specification["option_type"] = "call" if option_code[2] == "C" else "put"
        sources.append(EXCHANGE_SOURCES[exchange])
        status = "inferred"
    elif re.fullmatch(r"\d{1,5}", code) and (
        market == "HK" or exchange == "HKEX" or len(code) == 5
    ):
        code, kind, market, exchange = code.zfill(5), kind or "stock", "HK", "HKEX"
        hk_number = int(code)
        usd_counter = any(
            first <= hk_number <= last
            for first, last in [
                (9000, 9599),
                (9700, 9849),
                (10900, 10999),
                (41500, 41599),
            ]
        )
        currency, status = (
            "CNY" if code.startswith("8") else "USD" if usd_counter else "HKD",
            "inferred",
        )
        sources.append(EXCHANGE_SOURCES["HKEX"])
        if code.startswith("8"):
            warnings.append("港股代码可能属于人民币柜台，请核对币种。")
    elif re.fullmatch(r"\d{6}", code):
        market = "CN"
        if exchange in _VARIETIES and kind in {"fund", "etf", "stock", "gold", "index"}:
            exchange = ""
        if not kind:
            status = "ambiguous"
            candidates = [
                {"kind": x, "code": code, "market": "CN"}
                for x in ["fund", "stock", "index"]
            ]
            warnings.append(
                "六位数字代码可能在基金、股票或指数间重复，请先选择类型或从产品搜索结果选择。"
            )
        else:
            if kind in {"fund", "etf", "gold"}:
                exchange = exchange or (
                    "SSE"
                    if code.startswith("5")
                    else "SZSE"
                    if code.startswith(("15", "16"))
                    else "OTC"
                )
                if (
                    kind == "etf"
                    or code.startswith(("51", "56", "58", "159"))
                    and "联接" not in name
                ):
                    specification.setdefault("trading_channel", "exchange")
                else:
                    specification.setdefault("trading_channel", "off_exchange")
            elif kind == "stock":
                exchange = exchange or (
                    "BSE"
                    if code.startswith("920")
                    else "SSE"
                    if code.startswith(("6", "900"))
                    else "SZSE"
                    if code.startswith(("0", "2", "3"))
                    else ""
                )
                if not exchange:
                    warnings.append(
                        "旧北交所/新三板代码或未识别代码不能只按前缀确认上市交易所。"
                    )
            elif kind == "index":
                exchange = exchange or (
                    "SZSE"
                    if code.startswith("399")
                    else "SSE"
                    if code.startswith("000")
                    else ""
                )
                specification["observation_only"] = True
            currency = (
                currency
                if kind in {"fund", "etf", "gold"} and currency
                else "USD"
                if kind == "stock" and code.startswith("900")
                else "HKD"
                if kind == "stock" and code.startswith("200")
                else "CNY"
            )
            status = "inferred"
            if exchange in EXCHANGE_SOURCES:
                sources.append(EXCHANGE_SOURCES[exchange])
    elif code in {"XAU", "XAUUSD", "GC=X"} and kind == "gold":
        market, currency, exchange, status = market or "US", "USD", "OTC", "inferred"
        specification.setdefault("unit", "troy_ounce")
        if code == "GC=X":
            kind, specification["is_derivative"] = "future", True
            warnings.append("GC=X 为连续期货报价，不能作为实物黄金资产单价直接记账。")
    elif re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", code) and (
        market == "US" or kind in {"stock", "fund", "etf"}
    ):
        kind, market, currency, status = (
            kind or "stock",
            "US",
            "USD",
            "inferred",
        )
        warnings.append(
            "代码形式只能推断美国市场，具体上市交易所须由产品目录或人工核对。"
        )
    else:
        warnings.append("暂未识别该代码，请核对类型、交易所及计价币种后人工覆盖。")
    # Preserve provider metadata; heuristics never assert a verified fund contract.
    upper_description = f"{name} {specification.get('fund_type', '')}".upper()
    specification["is_qdii"] = (
        specification.get("is_qdii") is True or "QDII" in upper_description
    )
    specification["is_fof"] = (
        specification.get("is_fof") is True or "FOF" in upper_description
    )
    if "trading_channel" in body:
        specification["trading_channel"] = body["trading_channel"]
    if kind == "etf":
        specification["trading_channel"] = "exchange"
    result_fields = {
        "kind": kind or None,
        "market": market or None,
        "currency": currency or ("CNY" if market == "CN" else None),
        "exchange": exchange or None,
    }
    for key in ["kind", "market", "currency", "exchange"]:
        if key in overrides:
            value = str(overrides[key]).strip()
            result_fields[key] = (
                value.lower()
                if key == "kind"
                else _exchange(value)
                if key == "exchange"
                else value.upper()
            )
            status = "manual"
    if result_fields["kind"] and result_fields["kind"] not in KINDS:
        raise DomainError("人工覆盖的产品类型不支持")
    if result_fields["market"] and result_fields["market"] not in {"CN", "HK", "US"}:
        raise DomainError("当前支持 CN、HK、US 市场")
    # The service layer can supply verified catalog currency, while ordinary
    # form defaults must not turn Hong Kong/US shares into CNY instruments.
    if "currency" not in overrides and body.get("_catalog_currency"):
        result_fields["currency"] = str(body["_catalog_currency"]).upper()
    if result_fields["currency"] and result_fields["currency"] not in {
        "CNY",
        "USD",
        "HKD",
    }:
        raise DomainError("当前支持 CNY、USD、HKD 计价")
    if result_fields["kind"] in {"future", "option"}:
        specification["is_derivative"] = True
    calendar_id = (
        "CN_FUTURES"
        if result_fields["exchange"] in _VARIETIES
        else {"CN": "CN_EXCHANGE", "HK": "HKEX", "US": "US_EQUITIES"}.get(
            result_fields["market"], "UNKNOWN"
        )
    )
    calendar_id = (
        overrides.get("calendar_id") or specification.get("calendar_id") or calendar_id
    )
    if not isinstance(calendar_id, str) or calendar_id not in {*CALENDARS, "UNKNOWN"}:
        raise DomainError("不支持的交易日历")
    rule = _settlement_rule(
        result_fields["kind"], specification, overrides, calendar_id, warnings
    )
    specification.update(
        exchange=result_fields["exchange"],
        calendar_id=calendar_id,
        settlement_rule=rule,
        metadata_version=RULE_VERSION,
        metadata_identity={
            "code": canonical_code or code,
            "kind": result_fields["kind"],
        },
    )
    if overrides:
        specification["metadata_overrides"] = overrides
    if rule["source"] and rule["source"] != "user_override":
        sources.extend([rule["source"], FUND_DAY_SOURCE])
    from .subscription_calendar import subscription_rule

    subscription = subscription_rule(
        {
            "code": canonical_code or code,
            "name": name,
            **result_fields,
            "specification": specification,
        }
    )
    return {
        "subscription_rule": subscription,
        "code": canonical_code or code,
        "name": name or code,
        **result_fields,
        "specification": specification,
        "calendar": calendar_info(calendar_id),
        "settlement_rule": rule,
        "status": status,
        "candidates": candidates,
        "sources": list(dict.fromkeys(sources)),
        "warnings": list(dict.fromkeys(warnings)),
        "rule_version": RULE_VERSION,
    }
