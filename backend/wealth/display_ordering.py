"""Read-side date ordering; never change execution or ledger chronology."""

from django.db.models import F, Value
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Coalesce, NullIf

RESOURCE_DATE_FIELDS = {
    "goals": ("target_date",),
    "scenarios": ("target_date",),
    "plans": ("start_date",),
    "loans": ("first_due_date",),
    "reconciliations": ("as_of",),
    "budgets": ("month",),
    "todos": ("due_date", "economic_date", "date"),
    "fund_orders": ("application_date",),
}


def resource_display_order(query, kind):
    """Sort validated ISO business dates before slicing pages, unknowns last.

    created_at is only a tie-breaker, so backfilled older dates remain older.
    UUID supplies a stable final tie-breaker across identical timestamps.
    """
    fields = RESOURCE_DATE_FIELDS.get(kind)
    if not fields:
        return query.order_by("-created_at", "-pk")
    dates = [NullIf(KeyTextTransform(field, "data"), Value("")) for field in fields]
    business_date = Coalesce(*dates) if len(dates) > 1 else dates[0]
    return query.alias(display_date=business_date).order_by(
        F("display_date").desc(nulls_last=True), "-created_at", "-pk"
    )
