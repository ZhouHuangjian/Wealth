"""Discover fund distributions; only explicit confirmation creates ledger facts.

Public notices and estimated entitlement are mutable evidence, never cash. HTTP
runs outside tenant transactions; a small leased batch can be continued by Celery.
"""

import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from decimal import Decimal, localcontext
from html.parser import HTMLParser

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .common import catalog_queryset
from .common import (
    DomainError,
    audit,
    bump,
    day,
    dec,
    digest,
    get_obj,
    record,
    serial,
    tenant_context,
)
from .ledger import event_detail, position, post_event
from .market_data import MarketDataError, _get
from .models import (
    Account,
    Event,
    Instrument,
    Resource,
    ResourceRevision,
    Workspace,
)
from .provider_policy import get_provider_config, provider_chain

SOURCE = "天天基金·分红送配"
SETTINGS = "dividend_settings"
NOTICES = "dividend_notices"
CANDIDATES = "dividend_candidates"
REFRESH = "dividend_refresh"
BATCH = 20
CACHE_AGE = timedelta(hours=24)
LEASE = timedelta(minutes=15)


class _Tables(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self.rows = None
        self.row = None
        self.cell = None
        self.title = ""
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
        if tag == "table":
            self.rows = []
        elif tag == "tr" and self.rows is not None:
            self.row = []
        elif tag in {"th", "td"} and self.row is not None:
            self.cell = ""

    def handle_data(self, text):
        if self.in_title:
            self.title += text
        if self.cell is not None:
            self.cell += text

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag in {"td", "th"} and self.cell is not None:
            self.row.append(re.sub(r"\s+", "", self.cell))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None
        elif tag == "table" and self.rows is not None:
            self.tables.append(self.rows)
            self.rows = None


def parse_fund_distributions(text, code):
    """Strictly parse the provider's own labelled cash-distribution table."""
    parser = _Tables()
    parser.feed(text)
    if not re.search(r"[（(]" + re.escape(code) + r"[)）]", parser.title):
        raise MarketDataError("identity_mismatch", "分红来源返回了其他基金的信息")
    expected = ["年份", "权益登记日", "除息日", "每10份分红", "分红发放日"]
    tables = [rows for rows in parser.tables if rows and rows[0] == expected]
    if len(tables) != 1:
        raise MarketDataError("invalid_response", "分红来源格式已变化，请稍后刷新")
    notices = {}
    for row in tables[0][1:]:
        if len(row) == 1 and "暂无分红信息" in row[0]:
            continue
        if len(row) != 5:
            raise MarketDataError("invalid_response", "分红来源包含无法识别的记录")
        match = re.fullmatch(r"每10份派现金([0-9]+(?:\.[0-9]{1,12})?)元", row[3])
        try:
            registered, ex_date, payment = [
                date.fromisoformat(row[i]) for i in (1, 2, 4)
            ]
            amount = dec(match[1], nonnegative=True) if match else None
            if (
                not amount
                or ex_date < registered
                or payment < registered
                or registered.year < 1900
                or max(registered, ex_date, payment)
                > timezone.localdate() + timedelta(days=366)
            ):
                raise ValueError()
        except (ValueError, DomainError):
            raise MarketDataError("invalid_response", "分红日期或每十份金额无法核实")
        # Amount is deliberately absent from identity: a source correction must
        # update a candidate, not create a second entitlement.
        key = digest({"code": code, "record_date": registered, "ex_date": ex_date})
        notice = {
            "notice_key": key,
            "code": code,
            "record_date": str(registered),
            "ex_date": str(ex_date),
            "payment_date": str(payment),
            "amount_per_10": str(amount),
            "currency": "CNY",
            "description": row[3],
            "source": SOURCE,
            "source_url": f"https://fundf10.eastmoney.com/fhsp_{code}.html",
            "source_verified": False,
        }
        if key in notices and notices[key] != notice:
            raise MarketDataError(
                "conflicting_notice", "同一期分红来源存在冲突，请人工核实"
            )
        notices[key] = notice
    return sorted(notices.values(), key=lambda item: item["record_date"], reverse=True)


def fetch_fund_distributions(identity, provider_config):
    if "eastmoney_fund" not in provider_chain(provider_config, "fund"):
        raise MarketDataError("provider_disabled", "管理员已停用基金分红数据源")
    if (
        identity["kind"] != "fund"
        or identity["market"] != "CN"
        or identity["currency"] != "CNY"
        or not re.fullmatch(r"\d{6}", identity["code"])
    ):
        raise MarketDataError("unsupported_fund", "自动分红目前支持境内人民币场外基金")
    code = identity["code"]
    return parse_fund_distributions(
        _get(f"https://fundf10.eastmoney.com/fhsp_{code}.html"), code
    )


def _active_spaces():
    qs = Workspace.objects.all()
    if any(field.name == "deleted_at" for field in Workspace._meta.fields):
        qs = qs.filter(deleted_at__isnull=True)
    return qs


def _identity(instrument):
    return {
        key: getattr(instrument, key)
        for key in ("code", "market", "currency", "kind", "share_class")
    }


def _save(space, user, kind, data, obj=None):
    if obj:
        if obj.data == serial(data):
            return obj
        ResourceRevision.objects.get_or_create(
            tenant=space,
            resource=obj,
            version=obj.version,
            defaults={"created_by": user, "data": obj.data},
        )
        obj.data, obj.version = serial(data), obj.version + 1
        obj.save(update_fields=["data", "version"])
    else:
        obj = Resource.objects.create(
            tenant=space, created_by=user, kind=kind, data=serial(data)
        )
    ResourceRevision.objects.get_or_create(
        tenant=space,
        resource=obj,
        version=obj.version,
        defaults={"created_by": user, "data": obj.data},
    )
    return obj


def preferences(space):
    obj = Resource.objects.filter(tenant=space, kind=SETTINGS).first()
    return {
        "enabled": bool(obj and obj.data.get("enabled")),
        "version": obj.version if obj else 0,
        "id": str(obj.pk) if obj else None,
        "mode": "review_before_posting",
        "message": "自动查找分红并计算参考金额；到账金额或再投资份额经你确认后才记账。",
    }


def save_preferences(space, user, body):
    obj = Resource.objects.filter(tenant=space, kind=SETTINGS).first()
    if str(body.get("version")) != str(obj.version if obj else 0):
        raise DomainError("分红设置已改变，请刷新后重试", "version_conflict", 412)
    if type(body.get("enabled")) is not bool:
        raise DomainError("启用状态必须为布尔值")
    obj = _save(space, user, SETTINGS, {"enabled": body["enabled"]}, obj)
    audit(space, user, "dividend.preferences", obj, {"enabled": body["enabled"]})
    return preferences(space)


def _entitlement(space, account, instrument, notice):
    when = day(notice["record_date"])
    quantity, _ = position(space, account, instrument, when)
    # A later imported opening snapshot says nothing about shares at record date.
    # Even 'unchanged holding' is not legal entitlement evidence around a dividend.
    history = "recorded_quantity" if quantity > 0 else "quantity_unknown"
    with localcontext() as context:
        context.prec = 160
        estimated = (
            str(
                (quantity * dec(notice["amount_per_10"]) / Decimal(10)).quantize(
                    Decimal("0.01")
                )
            )
            if quantity > 0
            else None
        )
    return {
        "record_quantity": str(quantity) if quantity > 0 else None,
        "estimated_amount": estimated,
        "entitlement_status": history,
        "entitlement_confirmed": False,
        "message": "按登记日已录入份额估算，请核对机构确认的分红方式、到账金额或再投份额。"
        if quantity > 0
        else "登记日份额记录不足，请按机构分红记录填写实际金额；不会用当前份额倒推。",
    }


def _matches(space, candidate):
    data = candidate.data
    # Institutions can credit a few days later than the published payment date.
    start = day(data["record_date"])
    end = day(data["payment_date"]) + timedelta(days=14)
    claimed = (
        Resource.objects.filter(
            tenant=space, kind=CANDIDATES, data__event_id__isnull=False
        )
        .exclude(pk=candidate.pk)
        .values_list("data__event_id", flat=True)
    )
    return list(
        Event.objects.filter(
            tenant=space,
            kind__in=["dividend", "reinvest"],
            economic_date__gte=start,
            economic_date__lte=end,
            payload__account_id=data["account_id"],
            payload__currency=data["currency"],
            reverses__isnull=True,
            reversal__isnull=True,
        )
        .filter(
            Q(payload__instrument_id=data["instrument_id"])
            | Q(kind="dividend", payload__instrument_id__isnull=True)
            | Q(kind="dividend", payload__instrument_id=None)
            | Q(kind="dividend", payload__instrument_id="")
        )
        .exclude(pk__in=list(claimed))
        .order_by("economic_date", "created_at")
    )


def candidate_record(space, candidate):
    data = record(candidate)
    account = get_obj(Account, space, data["account_id"])
    instrument = get_obj(Instrument, space, data["instrument_id"])
    data.update(
        account_name=account.name,
        instrument_name=instrument.name,
        **_entitlement(space, account, instrument, data),
    )
    confirmed = (
        Event.objects.filter(tenant=space, pk=data.get("event_id")).first()
        if data.get("event_id")
        else None
    )
    if confirmed:
        data["status"] = "reversed" if hasattr(confirmed, "reversal") else "confirmed"
        data["event"] = {
            "id": str(confirmed.pk),
            "kind": confirmed.kind,
            "economic_date": str(confirmed.economic_date),
            "amount": confirmed.payload.get("amount"),
            "reversed": hasattr(confirmed, "reversal"),
        }
    else:
        data["status"] = "pending"
    data["matching_events"] = [
        {
            "id": str(event.pk),
            "kind": event.kind,
            "economic_date": str(event.economic_date),
            "amount": event.payload.get("amount"),
            "product_match": "same_product"
            if event.payload.get("instrument_id")
            else "unassigned_product",
        }
        for event in _matches(space, candidate)
        if not confirmed or event.pk != confirmed.pk
    ]
    data["can_confirm"] = (
        data["status"] != "confirmed"
        and day(data["record_date"]) <= timezone.localdate()
        and not account.archived
    )
    return data


def list_dividends(space, *, offset=0, limit=50):
    offset, limit = max(0, int(offset)), min(100, max(1, int(limit)))
    qs = Resource.objects.filter(tenant=space, kind=CANDIDATES).order_by(
        "-data__record_date", "-created_at"
    )
    count = qs.count()
    return {
        "settings": preferences(space),
        "items": [candidate_record(space, obj) for obj in qs[offset : offset + limit]],
        "count": count,
        "offset": offset,
        "limit": limit,
        "has_more": offset + limit < count,
        "sources": [
            record(obj)
            for obj in Resource.objects.filter(tenant=space, kind=REFRESH).order_by(
                "data__instrument_id"
            )
        ],
        "support": "境内人民币场外基金；基金公告不是个人到账凭证。现金分红和红利再投均需确认。",
    }


def _match_notice(space, instrument, notice, user=None):
    from .models import PositionMovement

    known_accounts = catalog_queryset(Account, space).filter(
        tenant=space,
        archived=False,
        pk__in=PositionMovement.objects.filter(
            tenant=space,
            instrument=instrument,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        ).values("account_id"),
    )
    created = 0
    for account in known_accounts:
        quantity, _ = position(space, account, instrument, day(notice["record_date"]))
        # Later snapshot with purchase-date spanning the record date is a useful
        # review candidate, but never an inferred entitlement or amount.
        later = Event.objects.filter(
            tenant=space,
            kind="opening",
            payload__account_id=str(account.pk),
            payload__instrument_id=str(instrument.pk),
            payload__opening_source="existing_holding",
            economic_date__gt=day(notice["record_date"]),
            payload__purchase_date__lte=notice["record_date"],
            reversal__isnull=True,
            reverses__isnull=True,
        ).exists()
        if quantity <= 0 and not later:
            continue
        key = digest(
            {
                "notice": notice["notice_key"],
                "account": account.pk,
                "instrument": instrument.pk,
            }
        )
        old = Resource.objects.filter(
            tenant=space, kind=CANDIDATES, data__candidate_key=key
        ).first()
        data = {
            **notice,
            "candidate_key": key,
            "instrument_id": str(instrument.pk),
            "account_id": str(account.pk),
            "status": "pending",
        }
        if old:
            for field in (
                "event_id",
                "status",
                "confirmed_at",
                "confirmed_by",
                "previous_event_ids",
            ):
                if field in old.data:
                    data[field] = old.data[field]
        _save(space, user, CANDIDATES, data, old)
        created += not bool(old)
    return created


def match_cached_notices(space, user=None):
    count = 0
    for notice in Resource.objects.filter(tenant=space, kind=NOTICES):
        instrument = (
            catalog_queryset(Instrument, space)
            .filter(tenant=space, pk=notice.data["instrument_id"])
            .first()
        )
        if instrument and _identity(instrument) == notice.data.get("identity"):
            count += _match_notice(space, instrument, notice.data, user)
    return count


def _enqueue(space_id):
    from .tasks import refresh_dividends_for_space

    try:
        refresh_dividends_for_space.delay(str(space_id))
    except Exception:
        # A durable settings marker is retried by the periodic dispatcher.
        return False
    return True


def request_refresh(space, user):
    from .market_sync import enabled

    if not enabled():
        raise DomainError(
            "行情抓取当前未启用，分红缓存仍可查看和核对", "market_disabled", 409
        )
    if "eastmoney_fund" not in provider_chain(get_provider_config(), "fund"):
        raise DomainError("管理员已停用基金分红数据源", "provider_disabled", 409)
    obj = Resource.objects.filter(tenant=space, kind=SETTINGS).first()
    obj = _save(
        space,
        user,
        SETTINGS,
        {
            **(obj.data if obj else {"enabled": False}),
            "refresh_requested": True,
            "refresh_request_token": str(uuid.uuid4()),
        },
        obj,
    )
    match_cached_notices(space, user)
    transaction.on_commit(lambda: _enqueue(space.pk))
    return {
        "status": "queued",
        "settings": preferences(space),
        "message": "已安排检查分红，24小时内的公告优先使用缓存；只生成待确认事项。",
    }


def _due(state, now):
    if not state:
        return True
    attempted = parse_datetime(state.data.get("last_attempt_at", ""))
    age = (
        LEASE
        if state.data.get("status") == "fetching"
        else (
            timedelta(hours=1)
            if state.data.get("status") in {"failed", "superseded"}
            else CACHE_AGE
        )
    )
    return not attempted or now - attempted >= age


def refresh_space_dividends(space_id):
    """Fetch one fair batch outside DB locks, then validate identity before save."""
    from .market_sync import enabled

    if not enabled():
        return {"status": "disabled", "has_more": False}
    config = get_provider_config()
    if "eastmoney_fund" not in provider_chain(config, "fund"):
        return {"status": "provider_disabled", "has_more": False}
    with tenant_context(space_id):
        space = _active_spaces().select_for_update().filter(pk=space_id).first()
        if not space:
            return {"status": "not_found", "has_more": False}
        settings = Resource.objects.filter(tenant=space, kind=SETTINGS).first()
        if not settings or not (
            settings.data.get("enabled") or settings.data.get("refresh_requested")
        ):
            return {"status": "disabled", "has_more": False}
        request_token = settings.data.get("refresh_request_token")
        match_cached_notices(space)
        states = {
            row.data.get("instrument_id"): row
            for row in Resource.objects.filter(tenant=space, kind=REFRESH)
        }
        now = timezone.now()
        eligible = (
            catalog_queryset(Instrument, space)
            .filter(tenant=space, kind="fund", market="CN", currency="CNY")
            .order_by("created_at", "pk")
        )
        due = [
            inst
            for inst in eligible
            if re.fullmatch(r"\d{6}", inst.code) and _due(states.get(str(inst.pk)), now)
        ]
        batch = []
        for instrument in due[:BATCH]:
            token = str(uuid.uuid4())
            row = _save(
                space,
                None,
                REFRESH,
                {
                    **(
                        states[str(instrument.pk)].data
                        if str(instrument.pk) in states
                        else {}
                    ),
                    "instrument_id": str(instrument.pk),
                    "instrument_name": instrument.name,
                    "status": "fetching",
                    "last_attempt_at": now.isoformat(),
                    "token": token,
                },
                states.get(str(instrument.pk)),
            )
            batch.append(
                (str(instrument.pk), _identity(instrument), str(row.pk), token)
            )
        has_more = len(due) > BATCH

    def fetch(item):
        iid, identity, rid, token = item
        try:
            return (*item, fetch_fund_distributions(identity, config), None)
        except MarketDataError as exc:
            return (*item, None, {"code": exc.code, "message": exc.message})
        except Exception:
            return (
                *item,
                None,
                {
                    "code": "provider_unavailable",
                    "message": "分红来源暂时不可用，已保留上次缓存",
                },
            )

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(fetch, batch))
    succeeded, failed, created = 0, 0, 0
    for iid, identity, rid, token, notices, error in results:
        with tenant_context(space_id):
            space = _active_spaces().select_for_update().filter(pk=space_id).first()
            if not space:
                continue
            state = Resource.objects.filter(tenant=space, pk=rid, kind=REFRESH).first()
            instrument = (
                catalog_queryset(Instrument, space).filter(tenant=space, pk=iid).first()
            )
            if not state or state.data.get("token") != token:
                continue
            if not instrument or _identity(instrument) != identity:
                _save(
                    space,
                    None,
                    REFRESH,
                    {
                        **state.data,
                        "status": "superseded",
                        "message": "产品身份已变化，已放弃旧分红结果",
                    },
                    state,
                )
                continue
            if error:
                _save(
                    space,
                    None,
                    REFRESH,
                    {**state.data, "status": "failed", **error},
                    state,
                )
                failed += 1
                continue
            for notice in notices:
                old = Resource.objects.filter(
                    tenant=space,
                    kind=NOTICES,
                    data__instrument_id=iid,
                    data__notice_key=notice["notice_key"],
                ).first()
                data = {**notice, "instrument_id": iid, "identity": identity}
                _save(space, None, NOTICES, data, old)
                created += _match_notice(space, instrument, data)
            _save(
                space,
                None,
                REFRESH,
                {
                    **state.data,
                    "status": "ready",
                    "message": "",
                    "code": "",
                    "fetched_at": timezone.now().isoformat(),
                    "notice_count": len(notices),
                },
                state,
            )
            succeeded += 1
    if not has_more:
        with tenant_context(space_id):
            space = _active_spaces().select_for_update().filter(pk=space_id).first()
            if space:
                settings = Resource.objects.filter(tenant=space, kind=SETTINGS).first()
                busy = any(
                    state.data.get("status") == "fetching"
                    and not _due(state, timezone.now())
                    for state in Resource.objects.filter(tenant=space, kind=REFRESH)
                )
                if (
                    settings
                    and settings.data.get("refresh_requested")
                    and settings.data.get("refresh_request_token") == request_token
                    and not busy
                ):
                    _save(
                        space,
                        None,
                        SETTINGS,
                        {**settings.data, "refresh_requested": False},
                        settings,
                    )
    return {
        "status": "ready" if not failed else "partial",
        "refreshed": succeeded,
        "failed": failed,
        "candidates_added": created,
        "has_more": has_more,
    }


def refresh_due_dividends(inline=False):
    from .market_sync import enabled

    if not enabled():
        return {"status": "disabled", "queued": 0}
    if "eastmoney_fund" not in provider_chain(get_provider_config(), "fund"):
        return {"status": "provider_disabled", "queued": 0}
    queued = 0
    for sid in _active_spaces().values_list("pk", flat=True):
        with tenant_context(sid):
            prefs = Resource.objects.filter(tenant_id=sid, kind=SETTINGS).first()
            should_queue = bool(
                prefs
                and (prefs.data.get("enabled") or prefs.data.get("refresh_requested"))
            )
            if should_queue and not prefs.data.get("refresh_requested"):
                states = {
                    row.data.get("instrument_id"): row
                    for row in Resource.objects.filter(tenant_id=sid, kind=REFRESH)
                }
                now = timezone.now()
                should_queue = any(
                    re.fullmatch(r"\d{6}", inst.code)
                    and _due(states.get(str(inst.pk)), now)
                    for inst in catalog_queryset(Instrument, sid).filter(
                        tenant_id=sid, kind="fund", market="CN", currency="CNY"
                    )
                )
        if should_queue:
            if inline:
                refresh_space_dividends(sid)
                queued += 1
            else:
                queued += bool(_enqueue(sid))
    return {"status": "queued", "queued": queued}


@transaction.atomic
def confirm_dividend(space, user, candidate_id, body):
    Workspace.objects.select_for_update().get(pk=space.pk)
    candidate = get_obj(Resource, space, candidate_id, kind=CANDIDATES)
    if body.get("actual_confirmed") is not True:
        raise DomainError(
            "请先核对机构的实际到账或红利再投记录", "confirmation_required"
        )
    prior = (
        Event.objects.filter(tenant=space, pk=candidate.data.get("event_id")).first()
        if candidate.data.get("event_id")
        else None
    )
    if prior and not hasattr(prior, "reversal"):
        raise DomainError(
            "这笔分红已确认，请在账本冲正后再重新核对",
            "dividend_already_confirmed",
            409,
        )
    if str(body.get("version")) != str(candidate.version):
        raise DomainError(
            "分红公告或确认记录已改变，请刷新后核对", "version_conflict", 412
        )
    data = candidate.data
    account = get_obj(Account, space, data["account_id"])
    instrument = get_obj(Instrument, space, data["instrument_id"])
    if _identity(instrument) != data.get("identity"):
        raise DomainError("产品身份已改变，请重新查询分红", "identity_mismatch", 409)
    if account.currency != data["currency"] or instrument.currency != data["currency"]:
        raise DomainError("账户或产品币种与分红公告不一致")
    if account.archived:
        raise DomainError("账户已归档")
    linked_id = body.get("event_id")
    if linked_id:
        event = get_obj(Event, space, linked_id)
        if (
            event not in _matches(space, candidate)
            or event.economic_date > timezone.localdate()
        ):
            raise DomainError(
                "只能关联同账户、同基金、相应分红期间内未冲正的分红记录",
                "dividend_event_mismatch",
            )
        if (
            Resource.objects.filter(
                tenant=space, kind=CANDIDATES, data__event_id=str(event.pk)
            )
            .exclude(pk=candidate.pk)
            .exists()
        ):
            raise DomainError(
                "这条账本记录已关联其他分红", "dividend_event_in_use", 409
            )
    else:
        if _matches(space, candidate):
            raise DomainError(
                "发现可能已记入的分红，请核对并关联已有记录，避免重复记账",
                "dividend_existing_event",
                409,
            )
        when = day(body.get("economic_date"))
        if (
            body.get("economic_date") in (None, "")
            or when < day(data["record_date"])
            or when > timezone.localdate()
        ):
            raise DomainError("请填写登记日之后、今天之前的实际到账或再投确认日期")
        mode = body.get("mode")
        if mode not in {"cash", "reinvest"}:
            raise DomainError("请选择现金分红或红利再投")
        event_data = {
            "kind": "dividend" if mode == "cash" else "reinvest",
            "account_id": str(account.pk),
            "instrument_id": str(instrument.pk),
            "economic_date": str(when),
            "currency": data["currency"],
            "description": "确认基金现金分红" if mode == "cash" else "确认基金红利再投",
            "dividend_candidate_id": str(candidate.pk),
            "dividend_notice_key": data["notice_key"],
            "fee": body.get("fee", "0"),
            "tax": body.get("tax", "0"),
        }
        if mode == "cash":
            event_data["amount"] = str(dec(body.get("amount"), nonnegative=True))
        else:
            event_data.update(
                quantity=str(dec(body.get("quantity"), nonnegative=True, places=18)),
                price=str(dec(body.get("price"), nonnegative=True, places=18)),
            )
            if body.get("amount") not in (None, ""):
                event_data["amount"] = str(dec(body["amount"], nonnegative=True))
        generation = len(data.get("previous_event_ids", [])) + (1 if prior else 0)
        event = post_event(
            space, user, event_data, stage_key=f"dividend:{candidate.pk}:{generation}"
        )
    updated = {
        **data,
        "status": "confirmed",
        "event_id": str(event.pk),
        "confirmed_at": timezone.now().isoformat(),
        "confirmed_by": user.pk,
    }
    if prior:
        updated["previous_event_ids"] = [
            *data.get("previous_event_ids", []),
            str(prior.pk),
        ]
    candidate = _save(space, user, CANDIDATES, updated, candidate)
    if linked_id:
        bump(space, user, invalidate_reconciliations=False)
    audit(
        space,
        user,
        "dividend.confirmed",
        candidate,
        {"event_id": str(event.pk), "linked_existing": bool(linked_id)},
    )
    return {
        "candidate": candidate_record(space, candidate),
        "event": event_detail(event),
    }


def dispatch_dividends(request, space, user, parts, body, role):
    from .views import write_command

    ident = parts[1] if len(parts) > 1 else None
    action = parts[2] if len(parts) > 2 else None
    if request.method == "GET" and not ident:
        return list_dividends(
            space,
            offset=request.GET.get("offset", 0),
            limit=request.GET.get("limit", 50),
        )
    if role == "viewer":
        raise DomainError("只读成员不能修改分红设置或记账", "forbidden", 403)
    if request.method == "PUT" and ident == "settings":
        return write_command(
            request,
            space,
            "dividends/settings",
            body,
            lambda: save_preferences(space, user, body),
        )
    if request.method == "POST" and ident == "refresh":
        return write_command(
            request,
            space,
            "dividends/refresh",
            body,
            lambda: request_refresh(space, user),
        )
    if request.method == "POST" and ident and action == "confirm":
        return write_command(
            request,
            space,
            f"dividends/{ident}/confirm",
            body,
            lambda: confirm_dividend(space, user, ident, body),
        )
    raise DomainError("分红接口不存在或不支持此方法", "not_found", 404)
