from django.db import migrations

SQL = """
ALTER TABLE wealth_event ADD COLUMN posted_tx_started timestamptz NOT NULL DEFAULT transaction_timestamp();
CREATE OR REPLACE FUNCTION wealth_fact_same_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event_tx xid8; event_started timestamptz;
BEGIN
  SELECT posted_txid,posted_tx_started INTO event_tx,event_started FROM public.wealth_event
    WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id;
  IF event_tx IS NULL OR event_tx <> pg_current_xact_id() OR event_started <> transaction_timestamp() THEN
    RAISE EXCEPTION 'A posted event cannot acquire additional financial effects' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
"""


class Migration(migrations.Migration):
    dependencies = [("wealth", "0003_close_posted_facts")]
    operations = [migrations.RunSQL(SQL)]
