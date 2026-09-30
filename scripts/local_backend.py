#!/usr/bin/env python3
"""Run commands with private local environment; never prints credentials."""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
env = dict(os.environ)
for line in (ROOT / ".env").read_text().splitlines():
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k] = v
args = sys.argv[1:]
testing = bool(args and args[0] == "test")
if testing:
    args = args[1:]
db = "wealth_test" if testing else "wealth"
env["DATABASE_URL"] = (
    f"postgresql://wealth_app:{env['DB_APP_PASSWORD']}@127.0.0.1:55432/{db}"
)
env["DATABASE_URL_ADMIN"] = (
    f"postgresql://wealth_owner:{env['DB_OWNER_PASSWORD']}@127.0.0.1:55432/{db}"
)
env["DJANGO_ALLOWED_HOSTS"] = "localhost,127.0.0.1,testserver"
env["DJANGO_DEBUG"] = "1"
if testing:
    env["WEALTH_TESTING"] = "1"
cmd = [str(ROOT / ".venv/bin/python")]
if args and args[0] == "pytest":
    cmd += ["-m", "pytest", *args[1:]]
else:
    cmd += ["manage.py", *args]
sys.exit(subprocess.call(cmd, cwd=ROOT / "backend", env=env))
