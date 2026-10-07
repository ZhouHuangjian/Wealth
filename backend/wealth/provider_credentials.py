"""Write-only market-data tokens, encrypted separately from public source policy."""

import base64
import json

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings
from django.utils.crypto import salted_hmac

from .common import DomainError
from .platform_models import PlatformSetting

TOKEN_PROVIDERS = {"tushare_fund", "lixinger_fund"}
PREFIX = "market_credential:"


def _cipher(provider):
    # Context-separated keys prevent a ciphertext copied between providers from
    # becoming a usable credential. Existing Django fallback keys allow rotation.
    secrets = [settings.SECRET_KEY, *getattr(settings, "SECRET_KEY_FALLBACKS", [])]
    return MultiFernet(
        [
            Fernet(
                base64.urlsafe_b64encode(
                    salted_hmac(
                        "wealth.market.credential.v1",
                        provider,
                        secret=secret,
                        algorithm="sha256",
                    ).digest()
                )
            )
            for secret in secrets
        ]
    )


def get_provider_credentials(provider):
    """Server adapters only. Neither this value nor ciphertext enters API output."""
    if provider not in TOKEN_PROVIDERS:
        return None
    row = PlatformSetting.objects.filter(pk=PREFIX + provider).first()
    encrypted = row.data.get("ciphertext") if row else None
    if not encrypted:
        return None
    try:
        body = json.loads(_cipher(provider).decrypt(encrypted.encode()).decode())
        if body.get("provider") != provider or not isinstance(body.get("token"), str):
            return None
        return {"token": body["token"]}
    except (InvalidToken, ValueError, TypeError, AttributeError, UnicodeError):
        return None


def credential_status(provider):
    if provider not in TOKEN_PROVIDERS:
        return {"required": False, "configured": True, "version": 0, "status": "public"}
    row = PlatformSetting.objects.filter(pk=PREFIX + provider).first()
    configured = bool(row and row.data.get("ciphertext"))
    readable = bool(get_provider_credentials(provider)) if configured else False
    return {
        "required": True,
        "configured": readable,
        "version": row.version if row else 0,
        "status": "configured"
        if readable
        else "unreadable"
        if configured
        else "unconfigured",
    }


def admin_provider_directory():
    from .provider_policy import provider_directory

    rows = provider_directory()
    for row in rows:
        row["credential"] = credential_status(row["id"])
        row.setdefault(
            "category",
            "subscription"
            if row["id"] in TOKEN_PROVIDERS
            else "official"
            if row["id"].endswith("_official") or row["id"] in {"nasdaq", "cboe"}
            else "aggregator",
        )
    return rows


def write_credential(actor, provider, body, *, delete=False):
    from .platform_admin import expected_version, log_admin, require_admin

    require_admin(actor)
    if provider not in TOKEN_PROVIDERS:
        raise DomainError("此来源不需要访问密钥", "credential_not_supported")
    allowed = {"version"} if delete else {"version", "token"}
    if not isinstance(body, dict) or set(body) - allowed:
        raise DomainError("密钥设置含不支持的字段")
    row = (
        PlatformSetting.objects.select_for_update().filter(pk=PREFIX + provider).first()
    )
    expected_version(body, row.version if row else 0)
    if row is None:
        row = PlatformSetting(key=PREFIX + provider)
    if delete:
        row.data = {}
    else:
        token = body.get("token")
        if (
            not isinstance(token, str)
            or not 8 <= len(token) <= 4096
            or any(c.isspace() or ord(c) < 32 for c in token)
        ):
            raise DomainError("请填写有效的访问密钥（8–4096 个非空白字符）")
        payload = json.dumps(
            {"provider": provider, "token": token}, separators=(",", ":")
        )
        row.data = {
            "ciphertext": _cipher(provider).encrypt(payload.encode()).decode(),
            "schema_version": 1,
        }
    row.version += 1
    row.save()
    log_admin(
        actor,
        "data_source.credential.removed"
        if delete
        else "data_source.credential.updated",
        provider,
        {"version": row.version},
    )
    return {"provider": provider, "credential": credential_status(provider)}
