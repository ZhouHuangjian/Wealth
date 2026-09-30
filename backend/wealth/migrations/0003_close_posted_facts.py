from django.db import migrations


SQL = """
ALTER TABLE wealth_event ADD COLUMN posted_txid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE FUNCTION wealth_fact_same_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event_tx xid8;
BEGIN
  SELECT posted_txid INTO event_tx FROM public.wealth_event
    WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id;
  IF event_tx IS NULL OR event_tx <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'A posted event cannot acquire additional financial effects' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER closed_event BEFORE INSERT ON wealth_journalline
FOR EACH ROW EXECUTE FUNCTION wealth_fact_same_transaction();
CREATE TRIGGER closed_event BEFORE INSERT ON wealth_positionmovement
FOR EACH ROW EXECUTE FUNCTION wealth_fact_same_transaction();
CREATE FUNCTION wealth_source_raw_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.raw IS DISTINCT FROM OLD.raw OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
    OR NEW.row_number IS DISTINCT FROM OLD.row_number OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'Original source evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER original_evidence BEFORE UPDATE ON wealth_sourcerecord
FOR EACH ROW EXECUTE FUNCTION wealth_source_raw_immutable();
"""


class Migration(migrations.Migration):
    dependencies = [("wealth", "0002_tenant_and_ledger_guards")]
    operations = [migrations.RunSQL(SQL)]
