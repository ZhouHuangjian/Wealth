"""Authoritative facts are immutable; tenant resources and plans are versioned."""

import uuid

from django.conf import settings
from django.db import models


class ActiveResourceManager(models.Manager):
    def get_queryset(self):
        return (
            super()
            .get_queryset()
            .filter(
                models.Q(data___administration_deleted__isnull=True)
                | models.Q(data___administration_deleted=False)
            )
        )


class ActiveObservationManager(models.Manager):
    def get_queryset(self):
        from django.db.models.functions import Cast
        from django.db.models.fields.json import KeyTextTransform

        hidden = Resource.all_objects.filter(
            tenant_id=models.OuterRef("tenant_id"),
            kind="administration_observations",
            data__model=self.model._meta.model_name,
            data__status__in=["deleted", "superseded"],
        ).annotate(
            target=Cast(KeyTextTransform("target_id", "data"), models.UUIDField())
        )
        return (
            super()
            .get_queryset()
            .exclude(pk__in=models.Subquery(hidden.values("target")))
        )


class ActiveOccurrenceManager(models.Manager):
    def get_queryset(self):
        return (
            super()
            .get_queryset()
            .filter(
                models.Q(plan__data___administration_deleted__isnull=True)
                | models.Q(plan__data___administration_deleted=False)
            )
        )


def money(**kwargs):
    return models.DecimalField(max_digits=38, decimal_places=12, **kwargs)


class Workspace(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100)
    base_currency = models.CharField(max_length=3, default="CNY")
    timezone = models.CharField(max_length=64, default="Asia/Shanghai")
    revision = models.PositiveBigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    deleted_at = models.DateTimeField(null=True, blank=True)


class Membership(models.Model):
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    role = models.CharField(max_length=10, default="owner")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "user"], name="membership_unique"
            )
        ]


class TenantModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Workspace, on_delete=models.PROTECT)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        abstract = True


class Account(TenantModel):
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=24, default="bank")
    currency = models.CharField(max_length=3, default="CNY")
    institution = models.CharField(max_length=120, blank=True)
    owner_label = models.CharField(max_length=100, blank=True)
    tail = models.CharField(max_length=8, blank=True)
    valuation_mode = models.CharField(max_length=20, default="detailed")
    archived = models.BooleanField(default=False)
    frozen = money(default=0)


class Instrument(TenantModel):
    name = models.CharField(max_length=150)
    code = models.CharField(max_length=60)
    market = models.CharField(max_length=30, default="CN")
    currency = models.CharField(max_length=3, default="CNY")
    share_class = models.CharField(max_length=30, blank=True)
    kind = models.CharField(max_length=20, default="fund")
    specification = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "code", "market", "currency", "share_class"],
                name="instrument_identity",
            )
        ]


class Event(TenantModel):
    kind = models.CharField(max_length=40)
    economic_date = models.DateField()
    description = models.CharField(max_length=500, blank=True)
    category = models.CharField(max_length=100, blank=True)
    payload = models.JSONField(default=dict)
    operation_id = models.UUIDField(default=uuid.uuid4)
    stage_key = models.CharField(max_length=160, unique=True)
    related = models.ForeignKey(
        "self", on_delete=models.PROTECT, null=True, related_name="following"
    )
    reverses = models.OneToOneField(
        "self", on_delete=models.PROTECT, null=True, related_name="reversal"
    )
    revision = models.PositiveBigIntegerField()

    class Meta:
        ordering = ["-economic_date", "-created_at"]
        indexes = [models.Index(fields=["tenant", "economic_date"])]


class JournalLine(TenantModel):
    event = models.ForeignKey(Event, on_delete=models.PROTECT, related_name="lines")
    account = models.ForeignKey(Account, on_delete=models.PROTECT, null=True)
    code = models.CharField(max_length=32)
    currency = models.CharField(max_length=3)
    amount = money()  # debit positive, credit negative
    instrument = models.ForeignKey(Instrument, on_delete=models.PROTECT, null=True)

    class Meta:
        indexes = [models.Index(fields=["tenant", "account", "code"])]


class PositionMovement(TenantModel):
    event = models.ForeignKey(Event, on_delete=models.PROTECT, related_name="movements")
    account = models.ForeignKey(Account, on_delete=models.PROTECT)
    instrument = models.ForeignKey(Instrument, on_delete=models.PROTECT)
    quantity = models.DecimalField(max_digits=38, decimal_places=18)
    cost = money(null=True)


class Price(TenantModel):
    objects = ActiveObservationManager()
    all_objects = models.Manager()
    instrument = models.ForeignKey(Instrument, on_delete=models.PROTECT)
    value = models.DecimalField(max_digits=38, decimal_places=18)
    kind = models.CharField(max_length=24, default="official_nav")
    economic_date = models.DateField()
    published_at = models.DateTimeField(null=True, blank=True)
    source = models.CharField(max_length=120, default="manual")


class FxRate(TenantModel):
    objects = ActiveObservationManager()
    all_objects = models.Manager()
    base = models.CharField(max_length=3)
    quote = models.CharField(max_length=3)
    rate = models.DecimalField(max_digits=38, decimal_places=18)
    economic_date = models.DateField()
    source = models.CharField(max_length=120, default="manual")
    purpose = models.CharField(max_length=20, default="valuation")


class ImportBatch(TenantModel):
    source = models.CharField(max_length=80)
    filename = models.CharField(max_length=200)
    digest = models.CharField(max_length=64)
    storage_key = models.CharField(max_length=200)
    account = models.ForeignKey(Account, on_delete=models.PROTECT, null=True)
    status = models.CharField(max_length=24, default="uploaded")
    parser_version = models.CharField(max_length=30, default="generic-1")
    mapping = models.JSONField(default=dict)
    ledger_revision = models.PositiveBigIntegerField(default=0)
    preview_hash = models.CharField(max_length=64, blank=True)
    diagnostics = models.JSONField(default=dict)


class SourceRecord(TenantModel):
    batch = models.ForeignKey(
        ImportBatch, on_delete=models.PROTECT, related_name="rows"
    )
    row_number = models.PositiveIntegerField()
    raw = models.JSONField(default=dict)
    normalized = models.JSONField(default=dict)
    errors = models.JSONField(default=list)
    identity = models.CharField(max_length=64, blank=True, db_index=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["batch", "row_number"], name="row_locator_unique"
            )
        ]


class SourceFact(TenantModel):
    identity = models.CharField(max_length=64)
    event = models.ForeignKey(Event, on_delete=models.PROTECT)
    fingerprint = models.CharField(max_length=64)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "identity"], name="source_fact_permanent"
            )
        ]


class EvidenceLink(TenantModel):
    record = models.ForeignKey(SourceRecord, on_delete=models.PROTECT)
    event = models.ForeignKey(
        Event, on_delete=models.PROTECT, related_name="evidence_links"
    )
    introduced = models.BooleanField(default=False)
    active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["record", "event"], name="evidence_unique")
        ]


class Idempotency(TenantModel):
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    command = models.CharField(max_length=200)
    key = models.CharField(max_length=160)
    digest = models.CharField(max_length=64)
    result = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "actor", "command", "key"], name="idempotency_unique"
            )
        ]


class Resource(TenantModel):
    """Versioned non-ledger records; validated by kind and never used as journal facts."""

    objects = ActiveResourceManager()
    all_objects = models.Manager()

    kind = models.CharField(max_length=40)
    data = models.JSONField(default=dict)

    class Meta:
        indexes = [models.Index(fields=["tenant", "kind"])]


class ResourceRevision(TenantModel):
    resource = models.ForeignKey(Resource, on_delete=models.PROTECT)
    data = models.JSONField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["resource", "version"], name="resource_version_unique"
            )
        ]


class Occurrence(TenantModel):
    objects = ActiveOccurrenceManager()
    all_objects = models.Manager()
    plan = models.ForeignKey(
        Resource, on_delete=models.PROTECT, related_name="occurrences"
    )
    sequence = models.PositiveIntegerField()
    due_date = models.DateField()
    amount = money()
    currency = models.CharField(max_length=3)
    status = models.CharField(max_length=24, default="scheduled")
    event = models.OneToOneField(Event, on_delete=models.PROTECT, null=True)
    details = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["plan", "sequence"], name="permanent_occurrence"
            )
        ]


class Snapshot(TenantModel):
    objects = ActiveObservationManager()
    all_objects = models.Manager()
    account = models.ForeignKey(Account, on_delete=models.PROTECT)
    economic_date = models.DateField()
    equity = money()
    currency = models.CharField(max_length=3)
    coverage = models.CharField(max_length=200)
    complete = models.BooleanField(default=False)
    includes_options = models.BooleanField(null=True, blank=True)
    included_event_ids = models.JSONField(default=list, blank=True)
    details = models.JSONField(default=dict, blank=True)


class Audit(TenantModel):
    action = models.CharField(max_length=100)
    object_id = models.CharField(max_length=100)
    detail = models.JSONField(default=dict)


class Outbox(TenantModel):
    revision = models.PositiveBigIntegerField()
    kind = models.CharField(max_length=40, default="recompute")
    status = models.CharField(max_length=20, default="pending")
    attempts = models.PositiveIntegerField(default=0)
    error = models.CharField(max_length=120, blank=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "revision", "kind"], name="outbox_revision_unique"
            )
        ]


class Projection(TenantModel):
    revision = models.PositiveBigIntegerField()
    payload = models.JSONField(default=dict)
    as_of = models.DateField()


class Invitation(TenantModel):
    token_hash = models.CharField(max_length=64, unique=True)
    role = models.CharField(max_length=10)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True)
    revoked = models.BooleanField(default=False)


class LoginAttempt(models.Model):
    key = models.CharField(max_length=64, unique=True)
    count = models.PositiveIntegerField(default=0)
    window_start = models.DateTimeField()


# Public metadata only. It intentionally does not inherit TenantModel or hold
# references to users, workspaces, private names, accounts or positions.
from .catalog_models import MarketSymbol  # noqa: F401
from .platform_models import (  # noqa: F401
    PlatformSetting,
    NavigationPreference,
    PlatformUserState,
    PlatformAudit,
    PlatformCommand,
    ConfigurationTemplate,
)
