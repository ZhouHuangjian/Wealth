"""Existing spaces deliberately start without delegation consent."""

from importlib import import_module

from django.db import migrations, models

# Recreate the previously audited function without changing its erasure scope.
# Whole-workspace lifecycle cleanup remains a separate platform capability.
PREVIOUS_SQL = import_module(
    "wealth.migrations.0011_scoped_business_erasure"
).SQL.replace("CREATE FUNCTION public.", "CREATE OR REPLACE FUNCTION public.", 1)
ANCHOR = "  IF root_table NOT IN ("
CONSENT = """  IF NOT EXISTS (SELECT 1 FROM public.wealth_workspace
      WHERE id=wanted AND admin_access_enabled AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Workspace owner consent required' USING ERRCODE='42501';
  END IF;
"""
assert PREVIOUS_SQL.count(ANCHOR) == 1


class Migration(migrations.Migration):
    dependencies = [("wealth", "0011_scoped_business_erasure")]
    operations = [
        migrations.AddField(
            model_name="workspace",
            name="admin_access_enabled",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="workspace",
            name="admin_access_version",
            field=models.PositiveBigIntegerField(default=0),
        ),
        migrations.RunSQL(
            PREVIOUS_SQL.replace(ANCHOR, CONSENT + ANCHOR, 1), PREVIOUS_SQL
        ),
    ]
