"""Personal chat data is owned by a login account, never a financial workspace."""

import uuid

from django.conf import settings
from django.db import models


class ChatAccess(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="chat_access",
    )
    enabled = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)


class ChatDevice(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="chat_devices"
    )
    name = models.CharField(max_length=80)
    token_hash = models.CharField(max_length=64, unique=True)
    token_ciphertext = models.TextField(default="", db_default="", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(null=True)
    revoked_at = models.DateTimeField(null=True)


class ChatDraftBatch(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="chat_drafts"
    )
    device = models.ForeignKey(
        ChatDevice, on_delete=models.CASCADE, related_name="batches"
    )
    batch_id = models.CharField(max_length=300)
    payload = models.JSONField(default=dict)
    payload_digest = models.CharField(max_length=64)
    received_at = models.DateTimeField(auto_now_add=True)
    # Soft deletion retains the payload; retries never restore a trashed batch.
    deleted_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["device", "batch_id"], name="chat_device_batch_unique"
            )
        ]
        indexes = [
            models.Index(
                fields=["owner", "-received_at", "-id"], name="chat_owner_received"
            )
        ]
