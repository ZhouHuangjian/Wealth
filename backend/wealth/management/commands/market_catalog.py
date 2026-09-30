from django.core.management.base import BaseCommand

from wealth.catalog import refresh_catalog


class Command(BaseCommand):
    help = "Populate shared public product metadata; never copies user instruments or holdings."

    def add_arguments(self, parser):
        parser.add_argument("--seed-only", action="store_true")
        parser.add_argument("--limit", type=int, default=40000)
        parser.add_argument("--force", action="store_true")

    def handle(self, *args, **options):
        result = refresh_catalog(
            limit=options["limit"],
            include_funds=not options["seed_only"],
            force=options["force"],
        )
        self.stdout.write(str(result))
