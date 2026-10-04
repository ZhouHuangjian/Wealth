"""Share configuration snapshots without account identities, balances or transactions."""

from copy import deepcopy
from django.contrib.auth import get_user_model
from django.db import transaction
from . import models as m
from .common import catalog_queryset
from .common import DomainError, serial, digest, tenant_context, audit
from .platform_admin import expected_version, log_admin, NAV_GROUPS
from .platform_models import ConfigurationTemplate, NavigationPreference
from . import insights

SECTIONS = {"navigation", "dashboard", "tags", "watchlist"}


def available_templates():
    # A captured source configuration must not outlive its owner's permission
    # through a public template or a platform-administration list.
    return ConfigurationTemplate.objects.filter(
        source_workspace__deleted_at__isnull=True,
        source_workspace__admin_access_enabled=True,
    )


def template_record(obj, administrative=False):
    result = {
        k: serial(getattr(obj, k))
        for k in [
            "id",
            "title",
            "description",
            "data",
            "published",
            "version",
            "created_at",
        ]
    }
    if administrative:
        result.update(
            source_user_id=obj.source_user_id,
            source_space_id=str(obj.source_workspace_id)
            if obj.source_workspace_id
            else None,
            created_by_id=obj.created_by_id,
        )
    return result


@transaction.atomic
def snapshot(user_id, space_id, *, actor):
    from .admin_access import require_delegation

    space = require_delegation(actor, space_id)
    users = get_user_model().objects
    # Consent and the space are locked above. Do not lock the source user after
    # that: an owner revokes under user->space ordering. The snapshot only reads
    # their navigation and the caller verifies its complete content digest.
    user = users.filter(pk=user_id, is_active=True).first()
    if (
        not user
        or not space
        or not m.Membership.objects.filter(user=user, workspace=space).exists()
    ):
        raise DomainError("请选择该用户已加入的有效空间")
    nav = NavigationPreference.objects.filter(user=user).first()
    groups = deepcopy(nav.groups if nav else {})
    groups = {k: v for k, v in groups.items() if k in NAV_GROUPS and k != "admin"}
    with tenant_context(space.pk):
        tags = [
            {k: row.data.get(k) for k in ["name", "color", "target_weight"]}
            for row in m.Resource.objects.filter(
                tenant=space, kind="investment_tags"
            ).order_by("created_at")
            if not row.data.get("archived")
        ]
        watches = []
        for row in m.Resource.objects.filter(
            tenant=space, kind="market_watchlist"
        ).order_by("created_at"):
            if not row.data.get("enabled", True):
                continue
            inst = (
                catalog_queryset(m.Instrument, space)
                .filter(tenant=space, pk=row.data.get("instrument_id"))
                .first()
            )
            if not inst:
                continue
            # Public identity only. Even renamed private product labels are excluded.
            catalog = m.MarketSymbol.objects.filter(
                code=inst.code,
                kind=inst.kind,
                market=inst.market,
                currency=inst.currency,
            ).first()
            if not catalog:
                continue
            product = {
                k: getattr(inst, k) for k in ["code", "kind", "market", "currency"]
            }
            product["name"] = catalog.name if catalog else inst.code
            product["specification"] = {
                k: v
                for k, v in (catalog.specification if catalog else {}).items()
                if k
                in {
                    "provider_symbol",
                    "quote_unit",
                    "exchange",
                    "is_index",
                    "quote_provider",
                    "reference_only",
                    "asset_class",
                }
                and isinstance(v, (str, int, bool))
            }
            watches.append(
                {
                    "product": product,
                    **{
                        k: row.data.get(k, default)
                        for k, default in [
                            ("show_on_home", True),
                            ("lookback_days", 365),
                        ]
                    },
                }
            )
        prefs = insights.preferences(space)
        data = {
            "navigation": groups,
            "dashboard": {k: prefs[k] for k in insights.DEFAULT_PREFERENCES},
            "tags": tags,
            "watchlist": watches,
        }
    return {
        "data": serial(data),
        "preview_digest": digest(data),
        "source_revision": space.revision,
        "navigation_version": nav.version if nav else 0,
    }


def admin_write(actor, ident, method, body):
    if ident is None and method == "POST":
        title = str(body.get("title", "")).strip()
        description = str(body.get("description", "")).strip()
        if not title or len(title) > 100 or len(description) > 500:
            raise DomainError("模板名称须为 1–100 字，说明不超过 500 字")
        snap = snapshot(
            body.get("source_user_id"),
            body.get("source_space_id"),
            actor=actor,
        )
        if body.get("preview_digest") != snap["preview_digest"]:
            raise DomainError(
                "来源设置已变化，请重新预览再发布", "version_conflict", 412
            )
        obj = ConfigurationTemplate.objects.create(
            title=title,
            description=description,
            data=snap["data"],
            source_user_id=body["source_user_id"],
            source_workspace_id=body["source_space_id"],
            created_by=actor,
        )
        log_admin(
            actor,
            "configuration_template.published",
            obj.pk,
            {
                "source_user_id": obj.source_user_id,
                "source_space_id": str(obj.source_workspace_id),
                "title": title,
            },
        )
        return template_record(obj, True)
    obj = (
        ConfigurationTemplate.objects.select_for_update().filter(pk=ident).first()
        if ident
        else None
    )
    if not obj:
        raise DomainError("模板不存在", "not_found", 404)
    from .admin_access import require_delegation

    require_delegation(actor, obj.source_workspace_id)
    if method != "PATCH":
        raise DomainError("仅支持发布与上下架模板", "method_not_allowed", 405)
    expected_version(body, obj.version)
    if not isinstance(body.get("published"), bool):
        raise DomainError("请选择是否发布")
    obj.published = body["published"]
    obj.version += 1
    obj.save(update_fields=["published", "version"])
    log_admin(
        actor, "configuration_template.visibility", obj.pk, {"published": obj.published}
    )
    return template_record(obj, True)


def apply_template(space, user, ident, body, role):
    obj = (
        available_templates()
        .select_for_update()
        .filter(pk=ident, published=True)
        .first()
    )
    if not obj:
        raise DomainError("模板不存在或已下架", "not_found", 404)
    expected_version(body, obj.version)
    sections = body.get("sections")
    if (
        not isinstance(sections, list)
        or not sections
        or any(x not in SECTIONS for x in sections)
    ):
        raise DomainError("请选择要采用的配置部分")
    if any(x != "navigation" for x in sections) and role != "owner":
        raise DomainError("账簿配置仅空间管理员可采用", "forbidden", 403)
    if str(body.get("space_revision")) != str(space.revision):
        raise DomainError("当前账簿配置已变化，请刷新预览", "version_conflict", 412)
    data = obj.data
    counts = {
        "tags_added": 0,
        "tags_skipped": 0,
        "watchlist_added": 0,
        "watchlist_skipped": 0,
    }
    if "navigation" in sections:
        nav, _ = NavigationPreference.objects.get_or_create(user=user)
        if str(body.get("navigation_version")) != str(nav.version):
            raise DomainError("个人导航已变化，请刷新后再采用", "version_conflict", 412)
        # Keep administrator-only navigation private to the recipient.
        admin = nav.groups.get("admin")
        nav.groups = deepcopy(data["navigation"])
        if admin is not None:
            nav.groups["admin"] = admin
        nav.version += 1
        nav.save()
    if "dashboard" in sections:
        existing = m.Resource.objects.filter(
            tenant=space, kind="dashboard_preferences"
        ).first()
        insights.save_configuration(
            space, user, "dashboard_preferences", data["dashboard"], existing
        )
    if "tags" in sections:
        existing = {
            str(t.data.get("name", "")).casefold()
            for t in m.Resource.objects.filter(tenant=space, kind="investment_tags")
        }
        for tag in data["tags"]:
            if tag["name"].casefold() in existing:
                counts["tags_skipped"] += 1
                continue
            insights.save_configuration(space, user, "investment_tags", tag)
            existing.add(tag["name"].casefold())
            counts["tags_added"] += 1
    if "watchlist" in sections:
        for item in data["watchlist"]:
            product = insights._ensure_product(space, user, item)
            if m.Resource.objects.filter(
                tenant=space,
                kind="market_watchlist",
                data__instrument_id=str(product.pk),
            ).exists():
                counts["watchlist_skipped"] += 1
                continue
            insights.save_configuration(
                space,
                user,
                "market_watchlist",
                {**item, "instrument_id": str(product.pk), "enabled": True},
            )
            counts["watchlist_added"] += 1
    audit(
        space,
        user,
        "configuration_template.applied",
        obj.pk,
        {"template_version": obj.version, "sections": sections, "counts": counts},
    )
    return {"ok": True, "template_id": str(obj.pk), "sections": sections, **counts}
