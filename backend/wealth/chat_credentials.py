"""Recoverable device credentials with keys scoped to their account and device."""

import base64
import hashlib
import secrets

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings
from django.utils.crypto import salted_hmac


def _cipher(device):
    # Separate from market credentials and bind ciphertext to one device/account.
    context = f"{device.owner_id}:{device.pk}"
    return MultiFernet(
        [
            Fernet(
                base64.urlsafe_b64encode(
                    salted_hmac(
                        "wealth.chat.device.credential.v1",
                        context,
                        secret=secret,
                        algorithm="sha256",
                    ).digest()
                )
            )
            for secret in [settings.SECRET_KEY, *settings.SECRET_KEY_FALLBACKS]
        ]
    )


def encrypt_device_token(device, token):
    return _cipher(device).encrypt(token.encode()).decode()


def read_device_token(device):
    if device.revoked_at or not device.token_ciphertext:
        return None
    try:
        token = _cipher(device).decrypt(device.token_ciphertext.encode()).decode()
        if not secrets.compare_digest(
            hashlib.sha256(token.encode()).hexdigest(), device.token_hash
        ):
            return None
        return token
    except (InvalidToken, ValueError, TypeError, AttributeError, UnicodeError):
        return None
