"""Shared public instrument directory: never tenant or portfolio information."""

import uuid
from typing import ClassVar

from django.db import models


class MarketSymbol(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=60)
    name = models.CharField(max_length=160)
    kind = models.CharField(max_length=20)
    market = models.CharField(max_length=30)
    currency = models.CharField(max_length=3)
    aliases = models.JSONField(default=list)
    search_text = models.CharField(max_length=1600)
    specification = models.JSONField(default=dict)
    source = models.CharField(max_length=80)
    status = models.CharField(max_length=24, default="metadata_only")
    refreshed_at = models.DateTimeField()

    class Meta:
        app_label = "wealth"
        constraints: ClassVar[list] = [
            models.UniqueConstraint(
                fields=["kind", "market", "code", "currency"],
                name="public_market_symbol_identity",
            )
        ]
        indexes: ClassVar[list] = [
            models.Index(fields=["kind", "market"], name="market_symbol_scope")
        ]
