from django.core.management.base import BaseCommand
from wealth.tasks import scan_all, dispatch_all, evaluate_signals_all


class Command(BaseCommand):
    help = "Scan due intentions and process the durable outbox locally; never executes external payments."

    def handle(self, *args, **options):
        from wealth.market_sync import refresh_due

        from wealth.dividends import refresh_due_dividends

        refresh_due_dividends(inline=True)
        market = refresh_due(inline=True, limit=10)
        signals = evaluate_signals_all()
        due = scan_all()
        jobs = dispatch_all(inline=True)
        self.stdout.write(
            f"待处理期次 {due['pending']}；已处理任务 {jobs['dispatched']}；行情更新 {market['scheduled']}；条件检查 {signals['evaluated']}"
        )
