from django.db import migrations


SQL = r"""
CREATE FUNCTION public.wealth_purge_business_record(
  operator bigint, wanted uuid, root_table text, target uuid,
  expected bigint, expected_version bigint, confirmation text, removal jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  previous_scope text; row_data jsonb; entry record; ids uuid[];
  found_count bigint; is_deleted boolean := false; actual_name text;
  orphaned_financial_fact boolean;
  allowed text[] := ARRAY[
    'wealth_account','wealth_instrument','wealth_event','wealth_journalline',
    'wealth_positionmovement','wealth_sourcefact','wealth_evidencelink',
    'wealth_sourcerecord','wealth_occurrence','wealth_snapshot','wealth_price',
    'wealth_fxrate','wealth_resourcerevision','wealth_resource','wealth_importbatch'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.auth_user WHERE id=operator AND is_active AND is_superuser) THEN
    RAISE EXCEPTION 'Active platform administrator required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.wealth_workspace WHERE id=wanted AND deleted_at IS NULL AND revision=expected FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current active workspace required' USING ERRCODE='23514'; END IF;
  IF root_table NOT IN ('wealth_account','wealth_instrument','wealth_event','wealth_price','wealth_fxrate','wealth_snapshot','wealth_resource')
     OR jsonb_typeof(removal) <> 'object' THEN
    RAISE EXCEPTION 'Unsupported business record' USING ERRCODE='23514';
  END IF;
  previous_scope := COALESCE(current_setting('app.tenant_id', true), '');
  PERFORM set_config('app.tenant_id', wanted::text, true);
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE tenant_id=$1 AND id=$2 FOR UPDATE', root_table)
    INTO row_data USING wanted,target;
  IF row_data IS NULL OR (row_data->>'version')::bigint <> expected_version
     OR NOT COALESCE((removal->root_table) @> jsonb_build_array(target::text), false) THEN
    RAISE EXCEPTION 'Existing root and current version required' USING ERRCODE='23514';
  END IF;
  actual_name := COALESCE(NULLIF(row_data->>'name',''), NULLIF(row_data#>>'{data,name}',''),
    NULLIF(row_data#>>'{data,title}',''), NULLIF(row_data->>'description',''),
    NULLIF(row_data#>>'{data,description}',''), confirmation);
  IF confirmation IS NULL OR length(confirmation)=0 OR actual_name <> confirmation THEN
    RAISE EXCEPTION 'Exact record name required' USING ERRCODE='23514';
  END IF;
  IF root_table IN ('wealth_account','wealth_instrument') THEN
    SELECT EXISTS (SELECT 1 FROM public.wealth_resource WHERE tenant_id=wanted
      AND kind='catalog_deletions' AND data->>'target_id'=target::text
      AND data->>'target_kind'=CASE WHEN root_table='wealth_account' THEN 'accounts' ELSE 'instruments' END
      AND data->>'status'='deleted') INTO is_deleted;
  ELSIF root_table='wealth_resource' THEN
    is_deleted := COALESCE((row_data#>>'{data,_administration_deleted}')::boolean,false);
  ELSIF root_table='wealth_event' THEN
    is_deleted := row_data->>'reverses_id' IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.wealth_event WHERE tenant_id=wanted AND reverses_id=target);
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.wealth_resource WHERE tenant_id=wanted
      AND kind='administration_observations' AND data->>'target_id'=target::text
      AND data->>'model'=replace(root_table,'wealth_','')
      AND data->>'status' IN ('deleted','superseded')) INTO is_deleted;
  END IF;
  IF NOT is_deleted THEN RAISE EXCEPTION 'Soft deletion required first' USING ERRCODE='23514'; END IF;
  FOR entry IN SELECT * FROM jsonb_each(removal) LOOP
    IF NOT entry.key=ANY(allowed) OR jsonb_typeof(entry.value)<>'array'
       OR jsonb_array_length(entry.value)>20000 THEN
      RAISE EXCEPTION 'Invalid deletion table or scope' USING ERRCODE='23514';
    END IF;
    SELECT array_agg(value::uuid) INTO ids FROM jsonb_array_elements_text(entry.value);
    IF entry.key IN ('wealth_account','wealth_instrument') AND
       (entry.key<>root_table OR cardinality(ids)<>1 OR ids[1]<>target) THEN
      RAISE EXCEPTION 'Only the selected catalog may be removed' USING ERRCODE='23514';
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id=$1 AND id=ANY($2)', entry.key)
      INTO found_count USING wanted,ids;
    IF found_count<>jsonb_array_length(entry.value) THEN
      RAISE EXCEPTION 'Cross-space or stale deletion manifest' USING ERRCODE='23514';
    END IF;
    -- The application computes a whole-event closure, but this privileged
    -- function must enforce it independently. INSERT-time balance checks do
    -- not detect a single deleted journal leg on an otherwise retained event.
    -- SourceFact also has an event_id FK and must not lose permanent import
    -- identity while its financial event remains authoritative.
    IF entry.key IN ('wealth_journalline','wealth_positionmovement','wealth_sourcefact') THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.%I WHERE tenant_id=$1 AND id=ANY($2)
          AND NOT (COALESCE($3, ''[]''::jsonb) @> jsonb_build_array(event_id::text)))',
        entry.key
      ) INTO orphaned_financial_fact USING wanted,ids,removal->'wealth_event';
      IF orphaned_financial_fact THEN
        RAISE EXCEPTION 'Financial fact deletion requires its whole event' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO public.wealth_cleanup_scope VALUES (pg_backend_pid(),txid_current(),wanted,NULL);
  FOR entry IN SELECT * FROM jsonb_each(removal) LOOP
    SELECT array_agg(value::uuid) INTO ids FROM jsonb_array_elements_text(entry.value);
    EXECUTE format('DELETE FROM public.%I WHERE tenant_id=$1 AND id=ANY($2)',entry.key) USING wanted,ids;
  END LOOP;
  DELETE FROM public.wealth_cleanup_scope WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current();
  -- Check the complete graph before returning, then restore the connection's
  -- normal deferred ledger constraints. No mutation trigger is disabled.
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('app.tenant_id',previous_scope,true);
END; $$;
REVOKE ALL ON FUNCTION public.wealth_purge_business_record(bigint,uuid,text,uuid,bigint,bigint,text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wealth_app') THEN
    GRANT EXECUTE ON FUNCTION public.wealth_purge_business_record(bigint,uuid,text,uuid,bigint,bigint,text,jsonb) TO wealth_app;
  END IF;
END $$;
"""


class Migration(migrations.Migration):
    dependencies = [("wealth", "0010_independent_administration")]
    operations = [
        migrations.RunSQL(
            SQL,
            "DROP FUNCTION IF EXISTS public.wealth_purge_business_record(bigint,uuid,text,uuid,bigint,bigint,text,jsonb)",
        )
    ]
