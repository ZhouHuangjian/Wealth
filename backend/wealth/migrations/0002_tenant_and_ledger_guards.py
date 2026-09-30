from django.db import migrations


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        raise RuntimeError(
            "PostgreSQL is required for tenant isolation and ledger constraints"
        )
    models = [
        m
        for m in apps.get_app_config("wealth").get_models()
        if any(f.name == "tenant" for f in m._meta.fields)
    ]
    with schema_editor.connection.cursor() as c:
        for model in models:
            table = model._meta.db_table
            c.execute(
                f"CREATE UNIQUE INDEX {table}_tenant_identity ON {table}(tenant_id,id)"
            )
            c.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
            c.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
            c.execute(
                f"CREATE POLICY space_isolation ON {table} USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)"
            )
        for model in models:
            for field in model._meta.fields:
                if field.is_relation and field.related_model in models:
                    table = model._meta.db_table
                    ref = field.related_model._meta.db_table
                    name = f"{table}_{field.name}_space_fk"[:63]
                    c.execute(
                        f"ALTER TABLE {table} ADD CONSTRAINT {name} FOREIGN KEY (tenant_id,{field.column}) REFERENCES {ref}(tenant_id,id) DEFERRABLE INITIALLY DEFERRED"
                    )
        c.execute("""
        CREATE FUNCTION wealth_no_fact_mutation() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'Posted financial facts are immutable; reverse and replace' USING ERRCODE='23514';
        END; $$;
        """)
        for table in [
            "wealth_event",
            "wealth_journalline",
            "wealth_positionmovement",
            "wealth_sourcefact",
        ]:
            c.execute(
                f"CREATE TRIGGER immutable_fact BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION wealth_no_fact_mutation()"
            )
        # Deferred checks restore the event tenant explicitly: API contexts have ended by commit.
        c.execute("""
        CREATE FUNCTION wealth_check_event() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        DECLARE old_scope text;
        BEGIN
          old_scope := COALESCE(current_setting('app.tenant_id', true), '');
          PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
          IF EXISTS (SELECT currency FROM public.wealth_journalline WHERE event_id=NEW.id AND tenant_id=NEW.tenant_id GROUP BY currency HAVING SUM(amount) <> 0) THEN
            RAISE EXCEPTION 'Journal is not balanced by currency' USING ERRCODE='23514';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM public.wealth_journalline WHERE event_id=NEW.id AND tenant_id=NEW.tenant_id)
             AND NOT EXISTS (SELECT 1 FROM public.wealth_positionmovement WHERE event_id=NEW.id AND tenant_id=NEW.tenant_id) THEN
            RAISE EXCEPTION 'Financial event has no effect' USING ERRCODE='23514';
          END IF;
          PERFORM set_config('app.tenant_id', old_scope, true);
          RETURN NULL;
        END; $$;
        CREATE CONSTRAINT TRIGGER check_balanced_event AFTER INSERT ON wealth_event
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wealth_check_event();
        """)


class Migration(migrations.Migration):
    dependencies = [("wealth", "0001_initial")]
    operations = [migrations.RunPython(install, migrations.RunPython.noop)]
