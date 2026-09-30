import uuid
from typing import ClassVar

from django.db import migrations, models


def grant_catalog_runtime(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wealth_app') THEN
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.wealth_marketsymbol TO wealth_app;
          END IF;
        END $$;
        """)


class Migration(migrations.Migration):
    dependencies: ClassVar[list] = [("wealth", "0006_immutable_audit_history")]
    operations: ClassVar[list] = [
        migrations.CreateModel(
            name="MarketSymbol",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("code", models.CharField(max_length=60)),
                ("name", models.CharField(max_length=160)),
                ("kind", models.CharField(max_length=20)),
                ("market", models.CharField(max_length=30)),
                ("currency", models.CharField(max_length=3)),
                ("aliases", models.JSONField(default=list)),
                ("search_text", models.CharField(max_length=1600)),
                ("specification", models.JSONField(default=dict)),
                ("source", models.CharField(max_length=80)),
                ("status", models.CharField(default="metadata_only", max_length=24)),
                ("refreshed_at", models.DateTimeField()),
            ],
            options={
                "indexes": [
                    models.Index(fields=["kind", "market"], name="market_symbol_scope")
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("kind", "market", "code", "currency"),
                        name="public_market_symbol_identity",
                    )
                ],
            },
        ),
        migrations.RunPython(grant_catalog_runtime, migrations.RunPython.noop),
    ]
