"""Explicit operator-controlled bootstrap; never infer privilege from a username."""

from django.core.management.base import BaseCommand, CommandError
from django.contrib.auth import get_user_model
from django.db import transaction
from wealth.platform_admin import log_admin
from wealth.models import Membership


class Command(BaseCommand):
    help = "Grant platform administrator privileges to an explicitly selected existing user."

    def add_arguments(self, parser):
        parser.add_argument("--username", required=True)

    def handle(self, *args, **options):
        with transaction.atomic():
            user = (
                get_user_model()
                .objects.select_for_update()
                .filter(username=options["username"], is_active=True)
                .first()
            )
            if not user:
                raise CommandError("Active user not found")
            if Membership.objects.filter(user=user).exists():
                raise CommandError(
                    "Administrator accounts must not belong to any workspace; transfer/remove memberships first."
                )
            if not user.is_superuser:
                user.is_superuser = user.is_staff = True
                user.save(update_fields=["is_superuser", "is_staff"])
                log_admin(
                    user,
                    "operator.platform_admin_granted",
                    user.pk,
                    {"method": "explicit_deployment_command"},
                )
        self.stdout.write(
            self.style.SUCCESS(
                "Platform administrator role verified for the selected user."
            )
        )
