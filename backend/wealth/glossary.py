"""Versioned public vocabulary overrides, maintained by platform administrators."""

import unicodedata

from django.db import transaction

from .common import DomainError
from .platform_admin import expected_version, log_admin, require_admin
from .platform_models import PlatformSetting

KEY = "glossary"


def read_glossary():
    setting = PlatformSetting.objects.filter(pk=KEY).first()
    return {
        "version": setting.version if setting else 0,
        "overrides": setting.data.get("overrides", []) if setting else [],
    }


def _text(value, field, limit, required=False):
    if not isinstance(value, str):
        raise DomainError(f"{field}须为文字")
    value = value.strip()
    if (required and not value) or len(value) > limit:
        raise DomainError(
            f"{field}须为{'1 至 ' if required else '不超过 '}{limit}个字符"
        )
    if any(unicodedata.category(char) == "Cc" and char not in "\n\t" for char in value):
        raise DomainError(f"{field}不能包含控制字符")
    return value


def validate_overrides(value):
    if not isinstance(value, list) or len(value) > 500:
        raise DomainError("名词配置须为列表，最多 500 条")
    cleaned, terms, labels = [], set(), {}
    for item in value:
        if not isinstance(item, dict) or set(item) - {
            "term",
            "category",
            "explanation",
            "example",
            "aliases",
            "hidden",
        }:
            raise DomainError("名词配置字段无效")
        term = _text(item.get("term"), "名词", 80, True)
        normalized = unicodedata.normalize("NFKC", term).casefold()
        if normalized in terms:
            raise DomainError("名词不能重复")
        terms.add(normalized)
        hidden = item.get("hidden", False)
        if not isinstance(hidden, bool):
            raise DomainError("名词隐藏状态须为布尔值")
        if hidden and not any(
            key in item for key in ("category", "explanation", "example", "aliases")
        ):
            cleaned.append({"term": term, "hidden": True})
            continue
        entry = {
            "term": term,
            "category": _text(item.get("category"), "分类", 40, True),
            "explanation": _text(item.get("explanation"), "说明", 4000, True),
            "example": _text(item.get("example", ""), "示例", 2000),
        }
        aliases = item.get("aliases", [])
        if not isinstance(aliases, list) or len(aliases) > 20:
            raise DomainError("相关写法最多 20 个")
        entry["aliases"] = [_text(alias, "相关写法", 80, True) for alias in aliases]
        if hidden:
            entry["hidden"] = True
        local_labels = set()
        for label in [term, *entry["aliases"]]:
            key = unicodedata.normalize("NFKC", label).casefold()
            if key in local_labels or (not hidden and key in labels):
                raise DomainError("名词或相关写法重复，请为每个写法保留一个说明")
            local_labels.add(key)
            if not hidden:
                labels[key] = term
        cleaned.append(entry)
    return cleaned


@transaction.atomic
def write_glossary(actor, body):
    """Call through platform_command for actor locking and idempotent submission."""
    require_admin(actor)
    overrides = validate_overrides(body.get("overrides"))
    setting, _ = PlatformSetting.objects.select_for_update().get_or_create(pk=KEY)
    expected_version(body, setting.version)
    setting.data = {"overrides": overrides}
    setting.version += 1
    setting.save()
    log_admin(
        actor,
        "glossary.updated",
        KEY,
        {"count": len(overrides), "version": setting.version},
    )
    return read_glossary()
