from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("wealth", "0004_transaction_epoch")]
    operations = [
        migrations.AddField(
            model_name="outbox",
            name="dispatched_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
