"""Account-specific option observations, excluded from all wealth totals.

Premium prices describe a contract. These private holding observations never
become shared prices, cash entries, or a substitute for institution equity.
"""

from copy import copy, deepcopy
from decimal import Decimal

from django.db import transaction

from .common import catalog_queryset
from .common import DomainError, audit, bump, day, dec, get_obj, serial
from .investments import validate_investment_account
from .models import Account, Instrument, Resource, ResourceRevision, Workspace

KIND = "option_positions"
IDENTITY = ("account_id", "instrument_id", "side")
FIELDS = {
    *IDENTITY,
    "quantity",
    "contract_multiplier",
    "opening_price",
    "current_value",
    "purchase_date",
    "as_of",
    "settlement_price",
    "settlement_date",
    "status",
    "closed_date",
}


def option_record(obj, account=None, instrument=None):
    data = obj.data
    account = account or get_obj(Account, obj.tenant, data["account_id"])
    instrument = instrument or get_obj(Instrument, obj.tenant, data["instrument_id"])
    premium = (
        dec(data["quantity"], places=18)
        * dec(data["contract_multiplier"], places=18)
        * dec(data["opening_price"], places=18)
    )
    value = dec(data["current_value"])
    sign = Decimal(1) if data["side"] == "long" else Decimal(-1)
    profit = sign * (value - premium)
    return serial(
        {
            **data,
            "id": str(obj.pk),
            "option_position_id": str(obj.pk),
            "version": obj.version,
            "account_name": account.name,
            "name": instrument.name,
            "instrument_name": instrument.name,
            "code": instrument.code,
            "market": instrument.market,
            "currency": data["currency"],
            "kind": "option",
            "side_label": "买入持仓" if sign > 0 else "卖出持仓",
            "opening_premium": premium,
            "opening_value": premium,
            "cost": premium,
            "signed_market_value": sign * value,
            "market_value": value,
            "reference_profit": profit,
            "profit": profit,
            "profit_rate": None,
            "profit_type": "reference_unrealized_gross",
            "contributes": False,
            "is_reference_position": True,
            "price": value
            / (
                dec(data["quantity"], places=18)
                * dec(data["contract_multiplier"], places=18)
            ),
            "price_date": data["as_of"],
            "price_kind": "option_position_reference",
            "price_source": "manual",
            "cost_status": "known",
            "valuation_basis": "reference",
            "message": "持仓参考明细，不重复计入账户权益；浮盈未扣手续费和税费，也不是已结算收益。",
        }
    )


def option_items(
    space, when=None, account_id=None, instrument_id=None, status="active"
):
    if status not in {"active", "closed", "all"}:
        raise DomainError("持仓状态须为 active、closed 或 all")
    when = day(when)
    filters = {}
    for field, model, ident in [
        ("account_id", Account, account_id),
        ("instrument_id", Instrument, instrument_id),
    ]:
        if ident:
            get_obj(model, space, ident)
            filters[f"data__{field}"] = str(ident)
    accounts = {
        str(a.pk): a for a in catalog_queryset(Account, space).filter(tenant=space)
    }
    instruments = {
        str(i.pk): i for i in catalog_queryset(Instrument, space).filter(tenant=space)
    }
    return [
        option_record(
            row,
            accounts[row.data["account_id"]],
            instruments[row.data["instrument_id"]],
        )
        for row in _dated_records(space, when, **filters)
        if status == "all" or row.data["status"] == status
    ]


def _dated_records(space, when, **filters):
    """Recall reference revisions without claiming historical fills or P&L."""
    for obj in (
        Resource.objects.filter(tenant=space, kind=KIND, **filters)
        .prefetch_related("resourcerevision_set")
        .order_by("created_at")
    ):
        versions = [(r.version, r.data) for r in obj.resourcerevision_set.all()]
        versions.append((obj.version, obj.data))
        eligible = [
            (version, data)
            for version, data in versions
            if day(
                data.get("closed_date")
                if data.get("status") == "closed" and data.get("closed_date")
                else data["as_of"]
            )
            <= when
        ]
        if not eligible:
            continue
        version, data = max(eligible, key=lambda item: item[0])
        observed = copy(obj)
        observed.version, observed.data = version, data
        yield observed


def has_option_reference(
    space, *, account_id=None, instrument_id=None, when=None, active_only=False
):
    qs = Resource.objects.filter(tenant=space, kind=KIND)
    if account_id:
        qs = qs.filter(data__account_id=str(account_id))
    if instrument_id:
        qs = qs.filter(data__instrument_id=str(instrument_id))
    if when:
        filters = {}
        if account_id:
            filters["data__account_id"] = str(account_id)
        if instrument_id:
            filters["data__instrument_id"] = str(instrument_id)
        return any(
            not active_only or row.data["status"] == "active"
            for row in _dated_records(space, day(when), **filters)
        )
    if active_only:
        qs = qs.filter(data__status="active")
    return qs.exists()


@transaction.atomic
def save_option_position(space, user, body, ident=None, instrument=None):
    if not isinstance(body, dict):
        raise DomainError("期权持仓须为对象")
    Workspace.objects.select_for_update().get(pk=space.pk)
    if ident and body.get("id") and str(ident) != str(body["id"]):
        raise DomainError("期权持仓编号不一致")
    ident = ident or body.get("id")
    obj = get_obj(Resource, space, ident, kind=KIND) if ident else None
    if obj and (
        isinstance(body.get("version"), bool)
        or str(body.get("version")) != str(obj.version)
    ):
        raise DomainError("期权持仓已更新，请刷新后再修改", "version_conflict", 409)
    values = {
        **(deepcopy(obj.data) if obj else {}),
        **{k: v for k, v in body.items() if k in FIELDS},
    }
    if instrument:
        if values.get("instrument_id") not in (None, str(instrument.pk)):
            raise DomainError("持仓合约与正在保存的产品不一致")
        values["instrument_id"] = str(instrument.pk)
    else:
        instrument = get_obj(Instrument, space, values.get("instrument_id"))
    account = get_obj(Account, space, values.get("account_id"))
    if instrument.kind not in {"option", "options"}:
        raise DomainError("该入口仅用于期权持仓参考")
    validate_investment_account(account, instrument)
    if values.get("side") not in ("long", "short"):
        raise DomainError("请选择买入持仓或卖出持仓；看涨、看跌不代表买卖方向")
    if obj and any(str(values.get(k)) != str(obj.data.get(k)) for k in IDENTITY):
        raise DomainError(
            "账户、合约和买卖方向不能直接改动；请关闭旧记录后新增正确持仓"
        )
    status = values.get("status", "active")
    if status not in ("active", "closed"):
        raise DomainError("请选择持有中或已关闭")
    quantity = dec(values.get("quantity"), nonnegative=True, places=18)
    multiplier = dec(values.get("contract_multiplier"), nonnegative=True, places=18)
    opening_price = dec(values.get("opening_price"), nonnegative=True, places=18)
    current_value = dec(values.get("current_value"), nonnegative=True)
    if quantity <= 0 or quantity != quantity.to_integral_value():
        raise DomainError("期权手数须为大于零的整数")
    if multiplier <= 0:
        raise DomainError("请填写已核对的合约乘数，不能默认按 1 或 100 计算")
    as_of, purchase_date = day(values.get("as_of")), day(values.get("purchase_date"))
    if (
        not values.get("as_of")
        or not values.get("purchase_date")
        or purchase_date > as_of
        or as_of > day()
    ):
        raise DomainError(
            "请填写实际开仓日与持仓核对日，开仓日不能晚于核对日，核对日不能晚于今天"
        )
    closed_date = day(values.get("closed_date")) if status == "closed" else None
    if closed_date and (closed_date < as_of or closed_date > day()):
        raise DomainError("关闭日期不能早于最后一次持仓核对日，也不能晚于今天")
    settlement_price, settlement_date = (
        values.get("settlement_price"),
        values.get("settlement_date"),
    )
    if settlement_price in (None, ""):
        if settlement_date not in (None, ""):
            raise DomainError("结算价与其所属日期须一同填写或清空")
        settlement_price = settlement_date = None
    else:
        settlement_price = dec(settlement_price, nonnegative=True, places=18)
        if not settlement_date:
            raise DomainError("填写结算价后请填写结算价所属日期")
        settlement_date = day(settlement_date)
        if settlement_date > as_of:
            raise DomainError("结算价所属日期不能晚于持仓核对日期")
    duplicate = Resource.objects.filter(
        tenant=space,
        kind=KIND,
        data__account_id=str(account.pk),
        data__instrument_id=str(instrument.pk),
        data__side=values["side"],
        data__status="active",
    )
    if obj:
        duplicate = duplicate.exclude(pk=obj.pk)
    if status == "active" and duplicate.exists():
        raise DomainError(
            "该账户已有同合约、同方向的持仓参考，请编辑现有记录",
            "option_position_exists",
            409,
        )
    clean = serial(
        {
            "account_id": str(account.pk),
            "instrument_id": str(instrument.pk),
            "side": values["side"],
            "status": status,
            "closed_date": closed_date,
            "quantity": quantity,
            "contract_multiplier": multiplier,
            "opening_price": opening_price,
            "current_value": current_value,
            "as_of": as_of,
            "purchase_date": purchase_date,
            "settlement_price": settlement_price,
            "settlement_date": settlement_date,
            "currency": account.currency,
            "specification": deepcopy(instrument.specification)
            if not obj
            else obj.data.get("specification", {}),
        }
    )
    if obj:
        ResourceRevision.objects.get_or_create(
            tenant=space,
            resource=obj,
            version=obj.version,
            defaults={"created_by": user, "data": deepcopy(obj.data)},
        )
        obj.version += 1
        obj.data = clean
        obj.save(update_fields=["version", "data"])
    else:
        obj = Resource.objects.create(
            tenant=space, created_by=user, kind=KIND, data=clean
        )
    ResourceRevision.objects.get_or_create(
        tenant=space,
        resource=obj,
        version=obj.version,
        defaults={"created_by": user, "data": deepcopy(obj.data)},
    )
    audit(
        space,
        user,
        "option_position.saved",
        obj,
        {"version": obj.version, "contributes_to_assets": False},
    )
    bump(space, user, invalidate_reconciliations=False)
    return option_record(obj, account, instrument)
