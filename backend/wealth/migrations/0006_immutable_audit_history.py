from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("wealth", "0005_outbox_lease")]
    operations = [
        migrations.RunSQL("""
        CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON wealth_resourcerevision
        FOR EACH ROW EXECUTE FUNCTION wealth_no_fact_mutation();
        CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON wealth_audit
        FOR EACH ROW EXECUTE FUNCTION wealth_no_fact_mutation();
    """)
    ]
