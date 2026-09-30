"""Enrich identification using the public cache, never another tenant's products."""

from .common import DomainError, get_obj
from .models import Instrument
from .catalog_models import MarketSymbol
from .instrument_metadata import resolve_instrument_metadata


def metadata_input(space, body):
    if not isinstance(body, dict):
        raise DomainError("产品识别参数须为对象")
    if body.get("instrument_id"):
        instrument = get_obj(Instrument, space, body["instrument_id"])
        values = {
            key: getattr(instrument, key)
            for key in ("code", "name", "kind", "market", "currency", "specification")
        }
        values.update(
            {key: value for key, value in body.items() if key != "instrument_id"}
        )
    else:
        values = dict(body)
    initial = resolve_instrument_metadata(values)
    # A changed product may arrive with the previous form's automatic metadata.
    # Keep the resolver's cleaned specification before enriching the new identity
    # so the second resolution neither revives old fields nor discards new cache data.
    values["specification"] = initial["specification"]
    values["exchange"] = initial["exchange"]
    rows = MarketSymbol.objects.filter(code__iexact=initial["code"])
    if initial.get("kind"):
        rows = rows.filter(kind=initial["kind"])
    if initial.get("market"):
        rows = rows.filter(market=initial["market"])
    candidates = list(rows[:2])
    if len(candidates) == 1:
        cached = candidates[0]
        values["code"] = initial["code"]
        values["_catalog_currency"] = cached.currency
        values["name"] = values.get("name") or cached.name
        values["specification"] = {
            **cached.specification,
            **(values.get("specification") or {}),
        }
    return values


def resolve_metadata(space, body):
    return resolve_instrument_metadata(metadata_input(space, body))
