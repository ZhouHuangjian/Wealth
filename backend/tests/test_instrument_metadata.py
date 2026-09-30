from copy import deepcopy

import pytest
from wealth.common import DomainError
from wealth.instrument_metadata import resolve_instrument_metadata as resolve


@pytest.mark.parametrize(
    "code,exchange",
    [
        ("AU2612", "SHFE"),
        ("AD2609", "SHFE"),
        ("OP2701", "SHFE"),
        ("SC2612", "INE"),
        ("EC2612", "INE"),
        ("BC2612", "INE"),
        ("A2701", "DCE"),
        ("BZ2612", "DCE"),
        ("LG2701", "DCE"),
        ("PL701", "CZCE"),
        ("PR701", "CZCE"),
        ("SA701", "CZCE"),
        ("IF2612", "CFFEX"),
        ("TL2612", "CFFEX"),
        ("SI2612", "GFEX"),
        ("PT2612", "GFEX"),
        ("PD2612", "GFEX"),
    ],
)
def test_all_six_futures_venues_override_default_form_hints(code, exchange):
    result = resolve({"code": code, "kind": "fund", "market": "CN"})
    assert (result["kind"], result["exchange"], result["currency"]) == (
        "future",
        exchange,
        "CNY",
    )
    assert result["specification"]["contract_verified"] is False
    assert result["sources"]
    assert result["calendar"]["id"] == "CN_FUTURES"


@pytest.mark.parametrize(
    "code,exchange",
    [
        ("CU2701C80000", "SHFE"),
        ("M2701-P-3300", "DCE"),
        ("SR701P5000", "CZCE"),
        ("IO2701-C-4000", "CFFEX"),
        ("LC2612-C-100000", "GFEX"),
        ("10000001", "SSE"),
        ("90000001", "SZSE"),
        ("510050C2612M03000", "SSE"),
        ("159919C2612M004000A", "SZSE"),
    ],
)
def test_options_are_derivatives_with_recognized_exchange(code, exchange):
    result = resolve({"code": code})
    assert result["kind"] == "option"
    assert result["exchange"] == exchange
    assert result["specification"]["is_derivative"] is True


def test_chinese_notation_matches_provider_without_network(monkeypatch):
    from wealth import market_data

    monkeypatch.setattr(
        market_data, "_get", lambda *args, **kwargs: pytest.fail("Unexpected network")
    )
    result = resolve({"code": "2701豆粕沽3300"})
    assert result["code"] == "m2701-P-3300"
    assert result["exchange"] == "DCE"
    assert result["kind"] == "option"


def test_unknown_derivative_prefix_never_defaults_to_an_exchange():
    result = resolve({"code": "ZZ2612", "kind": "fund"})
    assert result["status"] == "unknown"
    assert result["exchange"] is None
    assert result["market"] is None


def test_six_digit_overlap_requires_kind():
    result = resolve({"code": "000001"})
    assert result["status"] == "ambiguous"
    assert result["kind"] is None
    assert len(result["candidates"]) == 3
    assert resolve({"code": "000001", "kind": "stock"})["exchange"] == "SZSE"
    assert resolve({"code": "000001", "kind": "index"})["exchange"] == "SSE"
    assert resolve({"code": "000001", "kind": "fund"})["exchange"] == "OTC"


def test_etf_classification_and_exchange_channel_are_preserved():
    result = resolve({"code": "510300", "kind": "etf"})
    assert result["kind"] == "etf"
    assert result["specification"]["trading_channel"] == "exchange"
    assert result["settlement_rule"]["confirmation_days"] is None


@pytest.mark.parametrize(
    "name,days", [("普通基金", 1), ("海外QDII", 2), ("养老FOF", 3), ("货币基金", 1)]
)
def test_fund_rules_are_only_estimates_and_not_nav_publication_dates(name, days):
    result = resolve({"code": "123456", "kind": "fund", "name": name})
    rule = result["settlement_rule"]
    assert rule["confirmation_days"] == days
    assert rule["status"] == "estimated"
    assert rule["requires_confirmation"] is True
    assert rule["source"]
    assert "not_nav_publication" in rule["meaning"]


def test_round_trip_keeps_estimate_manual_override_and_explicit_clear_distinct():
    first = resolve({"code": "123456", "kind": "fund", "name": "测试QDII"})
    assert resolve(first)["settlement_rule"] == first["settlement_rule"]
    manual = resolve(
        {**first, "overrides": {"confirmation_days": 1, "cutoff_time": "14:30"}}
    )
    assert resolve(manual)["settlement_rule"]["status"] == "manual"
    assert resolve(manual)["settlement_rule"]["confirmation_days"] == 1
    reset = resolve({**manual, "overrides": {}})
    assert reset["settlement_rule"]["status"] == "estimated"
    assert reset["settlement_rule"]["confirmation_days"] == 2
    assert "metadata_overrides" not in reset["specification"]
    disabled = resolve({**first, "overrides": {"confirmation_days": None}})
    assert disabled["settlement_rule"]["confirmation_days"] is None
    assert disabled["settlement_rule"]["status"] == "manual"


def test_resolution_does_not_mutate_input_or_misclassify_gold_futures():
    body = {
        "code": "AU2612",
        "kind": "gold",
        "specification": {"allocation_tag_id": "tag"},
    }
    original = deepcopy(body)
    result = resolve(body)
    assert body == original
    assert result["kind"] == "future"
    assert result["specification"]["allocation_tag_id"] == "tag"


@pytest.mark.parametrize(
    "body",
    [
        {"code": "AU2613"},
        {"code": "M2701P0"},
        {"code": "123456", "specification": "bad"},
        {"code": "123456", "overrides": {"confirmation_days": True}},
        {"code": "123456", "overrides": {"confirmation_days": 2.5}},
        {"code": "123456", "overrides": {"cutoff_time": "25:00"}},
        {"code": "123456", "overrides": {"calendar_id": ["CN_EXCHANGE"]}},
        {"code": "123456", "specification": {"calendar_id": {"value": "CN_EXCHANGE"}}},
        {"code": "123456", "overrides": {"market": "GLOBAL"}},
    ],
)
def test_invalid_inputs_raise_domain_errors(body):
    with pytest.raises(DomainError):
        resolve(body)


def test_us_option_strike_and_xau_compatible_market():
    result = resolve({"code": "AAPL261218C00200000"})
    assert (result["kind"], result["market"], result["currency"]) == (
        "option",
        "US",
        "USD",
    )
    assert result["specification"]["strike"] == "200"
    assert resolve({"code": "XAU", "kind": "gold"})["market"] == "US"
    assert resolve({"code": "XAU", "kind": "gold", "market": "CN"})["market"] == "CN"


@pytest.mark.parametrize(
    "body,currency",
    [
        ({"code": "00700", "kind": "stock", "currency": "CNY"}, "HKD"),
        ({"code": "80700", "kind": "stock", "currency": "HKD"}, "CNY"),
        ({"code": "AAPL", "kind": "stock", "currency": "CNY"}, "USD"),
        ({"code": "900901", "kind": "stock", "currency": "CNY"}, "USD"),
        ({"code": "200002", "kind": "stock", "currency": "CNY"}, "HKD"),
        ({"code": "09001", "kind": "etf", "currency": "CNY"}, "USD"),
        ({"code": "09618", "kind": "stock", "currency": "CNY"}, "HKD"),
        ({"code": "00700", "kind": "stock", "overrides": {"currency": "USD"}}, "USD"),
    ],
)
def test_known_market_currency_does_not_inherit_form_default(body, currency):
    assert resolve(body)["currency"] == currency


def test_unique_catalog_currency_supports_usd_fund_share_class():
    result = resolve(
        {
            "code": "123456",
            "kind": "fund",
            "currency": "CNY",
            "_catalog_currency": "USD",
        }
    )
    assert result["currency"] == "USD"
    assert resolve(result)["currency"] == "USD"
    overridden = resolve(
        {**result, "_catalog_currency": "USD", "overrides": {"currency": "HKD"}}
    )
    assert overridden["currency"] == "HKD"


def test_non_chinese_fund_does_not_inherit_chinese_confirmation_rule():
    result = resolve({"code": "ABCDE", "kind": "fund", "market": "US"})
    assert result["settlement_rule"]["confirmation_days"] is None
    assert result["settlement_rule"]["status"] == "not_applicable"


def test_changed_product_drops_prior_option_identity_but_preserves_tags():
    prior = resolve({"code": "m2701-P-3300", "kind": "option"})
    prior["specification"]["allocation_tag_id"] = "my-tag"
    result = resolve({**prior, "code": "110022", "kind": "fund", "name": "普通基金"})
    assert result["exchange"] == "OTC"
    assert result["calendar"]["id"] == "CN_EXCHANGE"
    assert result["settlement_rule"]["confirmation_days"] == 1
    assert not result["specification"].get("is_derivative")
    assert "provider_symbol" not in result["specification"]
    assert result["specification"]["allocation_tag_id"] == "my-tag"


def test_legacy_auto_option_spec_is_not_a_fund_calendar():
    prior = resolve({"code": "m2701-P-3300", "kind": "option"})
    prior["specification"].pop("metadata_identity")
    result = resolve(
        {"code": "110022", "kind": "fund", "specification": prior["specification"]}
    )
    assert result["exchange"] == "OTC"
    assert result["calendar"]["id"] == "CN_EXCHANGE"
    assert result["settlement_rule"]["confirmation_days"] == 1
    assert not result["specification"].get("is_derivative")


@pytest.mark.parametrize(
    "previous",
    [
        {"code": "510300", "kind": "etf"},
        {"code": "123456", "kind": "fund", "name": "测试QDII"},
    ],
)
def test_new_ordinary_fund_does_not_inherit_etf_channel_or_qdii_rule(previous):
    prior = resolve(previous)
    result = resolve({**prior, "code": "110022", "kind": "fund", "name": "普通基金"})
    assert result["settlement_rule"]["confirmation_days"] == 1
    assert result["specification"]["trading_channel"] == "off_exchange"
    assert result["specification"]["is_qdii"] is False


def test_changed_identity_keeps_explicit_manual_overrides():
    prior = resolve(
        {
            "code": "m2701-P-3300",
            "kind": "option",
            "overrides": {
                "exchange": "SSE",
                "calendar_id": "CN_EXCHANGE",
                "confirmation_days": 2,
            },
        }
    )
    result = resolve({**prior, "code": "110022", "kind": "fund", "name": "普通基金"})
    assert result["exchange"] == "SSE"
    assert result["calendar"]["id"] == "CN_EXCHANGE"
    assert result["settlement_rule"]["confirmation_days"] == 2
    assert result["settlement_rule"]["status"] == "manual"
