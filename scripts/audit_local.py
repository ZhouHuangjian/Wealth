#!/usr/bin/env python3
"""Opt-in audit harness. Only synthetic local databases, independent credentials.

Uses existing Python dependencies and the project's database bootstrap. Never
reads the checkout's .env or contacts a production DB, broker or market source.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile

import local_dev as dev


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-port", type=int, default=55441)
    parser.add_argument("--web-port", type=int, default=18091)
    parser.add_argument(
        "action",
        choices=(
            "init",
            "check",
            "test",
            "probe",
            "restore-drill",
            "web",
            "stop",
            "status",
        ),
    )
    options, arguments = parser.parse_known_args()
    if not 1024 <= options.pg_port <= 65535 or options.pg_port == 55432:
        parser.error(
            "use an independent, unprivileged audit DB port; 55432 is reserved"
        )
    if not 1024 <= options.web_port <= 65535 or options.web_port == options.pg_port:
        parser.error("invalid web port")
    if sys.version_info < (3, 12):
        parser.error("run with the already-installed project Python >= 3.12")
    # macOS bounds a Unix socket pathname to 104 bytes. Managed worktree paths
    # can exceed it; a root-specific, private temporary directory stays short.
    identity = hashlib.sha256(str(dev.ROOT.resolve()).encode()).hexdigest()[:12]
    state = Path(tempfile.gettempdir()) / f"wealth-audit-{os.getuid()}-{identity}"
    os.umask(0o077)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (
        state.is_symlink()
        or state.stat().st_uid != os.getuid()
        or state.stat().st_mode & 0o077
    ):
        raise RuntimeError("audit state must be an owned private directory")
    dev.RUNTIME = state
    dev.STATE = state / "local-services.json"
    dev.PORT = options.pg_port
    dev.python_path = lambda: Path(sys.executable)

    def dependencies():
        import django  # noqa: F401
        import psycopg  # noqa: F401

    dev.setup_dependencies = dependencies

    def private_env(create=False):
        path = state / "audit.env"
        if not path.exists():
            if not create:
                raise RuntimeError("run audit_local.py init first")
            names = {
                "POSTGRES_PASSWORD",
                "DB_OWNER_PASSWORD",
                "DB_APP_PASSWORD",
                "RABBITMQ_PASSWORD",
                "DJANGO_SECRET_KEY",
            }
            content = dev.ROOT.joinpath(".env.example").read_text()
            content = (
                "\n".join(
                    f"{line.split('=', 1)[0]}={secrets.token_hex(32)}"
                    if line.split("=", 1)[0] in names
                    else line
                    for line in content.splitlines()
                )
                + "\n"
            )
            with path.open("x") as output:
                output.write(content)
            path.chmod(0o600)
        if path.stat().st_mode & 0o077:
            raise RuntimeError("audit.env must have mode 0600")
        env = dict(os.environ)
        for line in path.read_text().splitlines():
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                env[key] = value
        env.update(
            WEALTH_MARKET_DATA_ENABLED="0", WEALTH_LOCAL_PORT=str(options.web_port)
        )
        return env

    dev.load_env = private_env
    original_backend_env = dev.backend_env

    def backend_env(database="wealth_test", media=None, *, owner=False):
        return original_backend_env(
            database, media=media or state / "private", owner=owner
        )

    dev.backend_env = backend_env
    if options.action == "init":
        if arguments:
            parser.error("unexpected init arguments")
        dev.initialize()
        dev.configure_database(
            "wealth_ui_test", marker="synthetic system-audit probe database"
        )
        dev.manage("wealth_ui_test", "migrate", "--noinput", owner=True)
    elif options.action == "check":
        if arguments:
            parser.error("unexpected check arguments")
        dev.manage("wealth_test", "check")
        dev.manage("wealth_test", "makemigrations", "--check", "--dry-run", owner=True)
    elif options.action == "test":
        return subprocess.call(
            [sys.executable, "-m", "pytest", *arguments],
            cwd=dev.ROOT / "backend",
            env=dev.backend_env("wealth_test"),
        )
    elif options.action == "probe":
        choices = {
            "concurrency",
            "dca-top-up-concurrency",
            "restart-prepare",
            "restart-completed-prepare",
            "restart-recover",
            "ui-prepare",
            "ui-completed",
            "ui-nav",
            "ui-facts",
        }
        if len(arguments) != 1 or arguments[0] not in choices:
            parser.error("probe needs one of: " + ", ".join(sorted(choices)))
        module = "ui_probe" if arguments[0].startswith("ui-") else "probes"
        command = (
            "from audit_scenarios."
            + module
            + " import main; main("
            + repr(arguments[0])
            + ")"
        )
        dev.manage("wealth_ui_test", "shell", "-c", command)
    elif options.action == "restore-drill":
        if arguments:
            parser.error("unexpected restore-drill arguments")
        from test_restore_local import run

        run()
    elif options.action == "web":
        if arguments:
            parser.error("unexpected web arguments")
        return subprocess.call(
            [
                sys.executable,
                "-m",
                "gunicorn",
                "config.wsgi:application",
                "--bind",
                f"127.0.0.1:{options.web_port}",
                "--workers",
                "1",
                "--timeout",
                "120",
            ],
            cwd=dev.ROOT / "backend",
            env=dev.backend_env("wealth_ui_test"),
        )
    else:
        if arguments:
            parser.error("unexpected lifecycle arguments")
        return subprocess.call(
            [
                str(dev.pg_bin() / "pg_ctl"),
                "-D",
                str(state / "pgdata"),
                "-w",
                options.action,
            ]
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
