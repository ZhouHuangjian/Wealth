#!/usr/bin/env python3
"""Measure 10,000 synthetic import rows inside a rolled-back test transaction.

Run without printing connection secrets:
  .venv/bin/python scripts/local_backend.py test shell -c \
    "import runpy; runpy.run_path('../scripts/benchmark_import.py', run_name='__main__')"

The script refuses all databases except wealth_test. It creates no financial
facts, uses temporary private storage, and rolls back users, spaces and imports.
"""

import csv
from datetime import date, datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django

django.setup()

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection, transaction
from django.test import override_settings

from wealth.common import tenant_context
from wealth.imports import create_batch, preview
from wealth.models import Account, Event, JournalLine, Membership, Workspace


ROWS = 10_000
PREVIEW_TARGET_SECONDS = 60


class QueryCounter:
    """Count round trips without retaining SQL text or financial parameters."""

    def __init__(self):
        self.count = 0

    def __call__(self, execute, sql, params, many, context):
        self.count += 1
        return execute(sql, params, many, context)


def hardware():
    result = {
        "os": platform.platform(),
        "architecture": platform.machine(),
        "logical_cpus": os.cpu_count(),
        "python": platform.python_version(),
        "django": django.get_version(),
        "database_location": "local PostgreSQL test instance",
    }
    if platform.system() == "Darwin":
        for key, name in [
            ("hw.memsize", "host_memory_bytes"),
            ("machdep.cpu.brand_string", "cpu"),
        ]:
            try:
                value = subprocess.check_output(
                    ["sysctl", "-n", key], text=True, stderr=subprocess.DEVNULL
                ).strip()
                result[name] = int(value) if name == "host_memory_bytes" else value
            except (OSError, subprocess.CalledProcessError, ValueError):
                result[name] = "unavailable"
    with connection.cursor() as cursor:
        cursor.execute("SHOW server_version")
        result["postgresql"] = cursor.fetchone()[0]
    return result


def run():
    if settings.DATABASES["default"]["NAME"] != "wealth_test":
        raise RuntimeError(
            "性能测量只允许隔离的 wealth_test 数据库，请使用文档中的 test 启动方式"
        )
    if connection.in_atomic_block:
        raise RuntimeError("性能测量须从独立命令启动，不能混入其他事务")
    hardware_details = hardware()
    content = io.StringIO(newline="")
    writer = csv.writer(content)
    writer.writerow(
        ["date", "amount", "currency", "kind", "description", "external_id", "category"]
    )
    for index in range(ROWS):
        writer.writerow(
            [
                (date(2026, 1, 1) + timedelta(days=index % 90)).isoformat(),
                "12.34",
                "CNY",
                "expense",
                "合成性能样本",
                f"BENCH-{index:05d}",
                "测试消费",
            ]
        )
    data = content.getvalue().encode("utf-8-sig")
    username = f"benchmark-{uuid.uuid4().hex}"
    result = {
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "dataset": {
            "rows": ROWS,
            "file_bytes": len(data),
            "format": "UTF-8 BOM CSV",
            "real_user_data": False,
            "fields": 7,
            "existing_ledger_events": 0,
        },
        "conditions": hardware_details,
        "scope": "Single 10k-row upload and mapping preview; no commit, concurrency or full-scale claim",
    }
    with tempfile.TemporaryDirectory(prefix="wealth-import-benchmark-") as storage:
        with override_settings(PRIVATE_MEDIA_ROOT=Path(storage)):
            with transaction.atomic():
                user = get_user_model().objects.create_user(username=username)
                space = Workspace.objects.create(name="临时合成导入性能空间")
                space_id = space.pk
                Membership.objects.create(workspace=space, user=user, role="owner")
                with tenant_context(space.pk):
                    account = Account.objects.create(
                        tenant=space,
                        created_by=user,
                        name="合成账户",
                        kind="bank",
                        currency="CNY",
                    )
                    upload_counter = QueryCounter()
                    started = time.perf_counter()
                    with connection.execute_wrapper(upload_counter):
                        batch = create_batch(
                            space,
                            user,
                            SimpleUploadedFile("synthetic-10000.csv", data),
                            "generic",
                            account.pk,
                        )
                    upload_seconds = time.perf_counter() - started
                    preview_counter = QueryCounter()
                    started = time.perf_counter()
                    with connection.execute_wrapper(preview_counter):
                        output = preview(
                            space, user, batch, {"account_id": str(account.pk)}
                        )
                    preview_seconds = time.perf_counter() - started
                    if output["row_count"] != ROWS or len(output["rows"]) != ROWS:
                        raise RuntimeError("预览返回行数与合成输入不一致")
                    if any(row["errors"] for row in output["rows"]):
                        raise RuntimeError("合成输入出现预览错误")
                    if (
                        Event.objects.filter(tenant=space).exists()
                        or JournalLine.objects.filter(tenant=space).exists()
                    ):
                        raise RuntimeError("预览不应创建任何实账")
                    result["upload"] = {
                        "seconds": round(upload_seconds, 4),
                        "queries": upload_counter.count,
                    }
                    result["preview"] = {
                        "seconds": round(preview_seconds, 4),
                        "queries": preview_counter.count,
                        "returned_rows": len(output["rows"]),
                        "error_rows": 0,
                        "target_seconds": PREVIEW_TARGET_SECONDS,
                        "target_met": preview_seconds <= PREVIEW_TARGET_SECONDS,
                    }
                transaction.set_rollback(True)
    if (
        Workspace.objects.filter(pk=space_id).exists()
        or get_user_model().objects.filter(username=username).exists()
    ):
        raise RuntimeError("合成性能数据未回滚，请检查测试数据库")
    result["cleanup"] = {
        "database_rolled_back": True,
        "temporary_files_removed": True,
        "financial_events_posted": 0,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["preview"]["target_met"] else 1


if __name__ == "__main__":
    raise SystemExit(run())
