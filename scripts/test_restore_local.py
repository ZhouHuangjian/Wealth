#!/usr/bin/env python3
"""Real, isolated PostgreSQL restore drill; never uses the main Wealth ledger.

Run with .venv/bin/python scripts/test_restore_local.py. The only databases this
script creates or drops are wealth_restore_source_test/wealth_restore_target_test.
Existing databases without this drill's marker are never replaced. All financial
values are synthetic, and the source and target are removed after the drill.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

import backup
import local_dev

SOURCE = "wealth_restore_source_test"
TARGET = "wealth_restore_target_test"
MARKER = "wealth-local-restore-drill-v1-synthetic-only"

SEED = r"""
import django, hashlib, json
django.setup()
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from wealth.common import tenant_context
from wealth.models import Workspace, Membership, Account, Instrument, Price
from wealth.ledger import post_event
from wealth.planning import save_resource, confirm_occurrence
from wealth.imports import create_batch
User=get_user_model()
owner=User.objects.create_user(username='restore-synthetic-owner', password='restore-only-synthetic-password')
viewer=User.objects.create_user(username='restore-synthetic-viewer', password='restore-only-synthetic-password')
a=Workspace.objects.create(name='恢复演练 A：合成数据')
b=Workspace.objects.create(name='恢复演练 B：隔离合成数据')
Membership.objects.create(workspace=a,user=owner,role='owner')
Membership.objects.create(workspace=a,user=viewer,role='viewer')
other=User.objects.create_user(username='restore-other-space',password='restore-only-synthetic-password')
Membership.objects.create(workspace=b,user=other,role='owner')
with tenant_context(a.pk):
    bank=Account.objects.create(tenant=a,created_by=owner,name='合成银行',kind='bank',currency='CNY')
    loan=Account.objects.create(tenant=a,created_by=owner,name='合成贷款',kind='loan',currency='CNY')
    fund=Instrument.objects.create(tenant=a,created_by=owner,name='合成基金',code='DRILL-SYNTHETIC',kind='fund',currency='CNY')
    def post(kind,account=bank,**data):
        return post_event(a,owner,{'kind':kind,'account_id':str(account.pk),'economic_date':'2026-01-01',**data})
    post('opening',amount='10000')
    post('opening',loan,amount='1200')
    debit=post('fund_debit',amount='1000')
    post('fund_confirm',amount='1000',quantity='495',price='2',fee='10',instrument_id=str(fund.pk),related_event_id=str(debit.pk))
    Price.objects.create(tenant=a,created_by=owner,instrument=fund,value='2',kind='official_nav',economic_date='2026-01-01',source='restore-synthetic-fixture')
    plan=save_resource(a,owner,'plans',{'name':'合成月度支出','kind':'expense','account_id':str(bank.pk),'amount':'100','currency':'CNY','start_date':'2026-01-01','frequency':'monthly','count':1,'status':'active'})
    expense=post('expense',amount='100')
    confirm_occurrence(a,owner,plan.occurrences.get(sequence=1),expense.pk)
    content=b'date,type,amount,currency\n2026-01-01,expense,100,CNY\n'
    batch=create_batch(a,owner,SimpleUploadedFile('restore-proof.csv',content,content_type='text/csv'),'generic',str(bank.pk))
with tenant_context(b.pk):
    separate=Account.objects.create(tenant=b,created_by=other,name='隔离银行',currency='CNY')
    post_event(b,other,{'kind':'opening','account_id':str(separate.pk),'amount':'2500','economic_date':'2026-01-01'})
print(json.dumps({'a':str(a.pk),'b':str(b.pk),'bank':str(bank.pk),'loan':str(loan.pk),'fund':str(fund.pk),'owner':owner.pk,'viewer':viewer.pk,'batch':str(batch.pk),'file':batch.storage_key,'file_sha256':hashlib.sha256(content).hexdigest(),'expected_net_assets':'8690','expected_cash':'8900','expected_loan':'1200','expected_quantity':'495','expected_cost':'1000'},ensure_ascii=False))
"""

VERIFY = r"""
import django, hashlib, json, os
from decimal import Decimal
django.setup()
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import connection, transaction, IntegrityError
from django.db.migrations.recorder import MigrationRecorder
from django.test import Client
from wealth.common import tenant_context
from wealth.models import Workspace, Account, Instrument, Event, JournalLine, Occurrence, ImportBatch, ResourceRevision
from wealth.ledger import balance,position
from wealth.reporting import overview
f=json.loads(os.environ['WEALTH_DRILL_FIXTURE'])
with connection.cursor() as c:
    c.execute('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    user,superuser,bypass=c.fetchone()
    assert user=='wealth_app' and not superuser and not bypass,'Runtime role bypasses isolation'
    c.execute("SELECT pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='wealth_account'")
    owner,rls,force=c.fetchone()
    assert owner=='wealth_owner' and rls and force,'Restored table lost its owner or forced RLS'
assert Account.objects.count()==0,'No tenant context must see no private accounts'
a=Workspace.objects.get(pk=f['a'])
with tenant_context(a.pk):
    assert not Account.objects.filter(tenant_id=f['b']).exists(),'Cross-space rows visible'
    bank=Account.objects.get(pk=f['bank']);loan=Account.objects.get(pk=f['loan']);fund=Instrument.objects.get(pk=f['fund'])
    cash=balance(a,bank,'cash');debt=-balance(a,loan,'liability');quantity,cost=position(a,bank,fund)
    total=Decimal(overview(a,'2026-01-01')['net_assets'])
    assert cash==Decimal(f['expected_cash']) and debt==Decimal(f['expected_loan'])
    assert quantity==Decimal(f['expected_quantity']) and cost==Decimal(f['expected_cost'])
    assert total==Decimal(f['expected_net_assets'])
    events=list(Event.objects.filter(tenant=a))
    for event in events:
        sums={}
        for line in event.lines.all(): sums[line.currency]=sums.get(line.currency,Decimal(0))+line.amount
        assert all(amount==0 for amount in sums.values()),'Restored journal no longer balances'
    batch=ImportBatch.objects.get(pk=f['batch'])
    assert hashlib.sha256((settings.PRIVATE_MEDIA_ROOT/batch.storage_key).read_bytes()).hexdigest()==f['file_sha256']
    try:
        with transaction.atomic():
            Event.objects.filter(pk=events[0].pk).update(description='must-not-change')
    except IntegrityError: pass
    else: raise AssertionError('Restored immutable fact trigger is missing')
    try:
        with transaction.atomic():
            JournalLine.objects.create(tenant=a,event=events[0],account=bank,code='cash',currency='CNY',amount='1')
    except IntegrityError: pass
    else: raise AssertionError('Restored closed-event trigger allowed new effects')
    assert Occurrence.objects.filter(tenant=a,event__isnull=False).count()==1
    assert ResourceRevision.objects.filter(tenant=a).exists()
    counts={'events':len(events),'journal_lines':JournalLine.objects.filter(tenant=a).count(),'confirmed_occurrences':1}
client=Client()
client.force_login(get_user_model().objects.get(pk=f['owner']))
assert client.get('/api/v1/spaces/'+f['b']+'/accounts').status_code==404,'Non-member API access allowed'
client.force_login(get_user_model().objects.get(pk=f['viewer']))
assert client.get('/api/v1/spaces/'+f['a']+'/accounts').status_code==200,'Viewer cannot read restored accounts'
assert client.post('/api/v1/spaces/'+f['a']+'/events',data=json.dumps({'kind':'expense','amount':'1','account_id':f['bank']}),content_type='application/json').status_code==403,'Viewer can write'
assert client.get('/api/v1/spaces/'+f['a']+'/imports/'+f['batch']+'/file').status_code==403,'Viewer can download raw evidence'
print(json.dumps({'runtime_role':user,'table_owner':owner,'forced_rls':True,'no_context_denied':True,'cross_space_denied':True,'viewer_write_denied':True,'viewer_raw_file_denied':True,'immutable_trigger':True,'closed_event_trigger':True,'media_hash_verified':True,'net_assets':str(total),'cash':str(cash),'loan_principal':str(debt),'fund_quantity':str(quantity),'fund_management_cost':str(cost),'wealth_migrations':list(MigrationRecorder.Migration.objects.filter(app='wealth').order_by('name').values_list('name',flat=True)),**counts},ensure_ascii=False))
"""


def _database_marker(name):
    with local_dev.admin_connection() as connection:
        return connection.execute(
            "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=%s",
            [name],
        ).fetchone()


def _drop_database(name):
    if name not in {SOURCE, TARGET}:
        raise RuntimeError("拒绝删除非演练数据库")
    marker = _database_marker(name)
    if marker is None:
        return
    if marker[0] != MARKER:
        raise RuntimeError("同名数据库不属于本演练，拒绝删除")
    from psycopg import sql

    with local_dev.admin_connection() as connection:
        connection.execute(
            sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name))
        )


def _backend(script, database, media, fixture=None):
    env = local_dev.backend_env(database, media)
    if fixture is not None:
        env["WEALTH_DRILL_FIXTURE"] = json.dumps(fixture)
    result = subprocess.run(
        [str(local_dev.python_path()), "-c", script],
        cwd=local_dev.ROOT / "backend",
        env=env,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        with (local_dev.RUNTIME / "restore-drill.log").open("a") as output:
            output.write(result.stderr)
        raise RuntimeError(
            "演练验证失败，详细诊断已写入私有 .runtime/restore-drill.log"
        )
    return json.loads(result.stdout.strip().splitlines()[-1])


def _pg_command(command, database, *arguments, **kwargs):
    values = local_dev.load_env()
    env = dict(
        os.environ,
        PGHOST="127.0.0.1",
        PGPORT=str(local_dev.PORT),
        PGUSER=local_dev.ADMIN_ROLE,
        PGPASSWORD=values["POSTGRES_PASSWORD"],
        PGDATABASE=database,
    )
    result = subprocess.run(
        [str(local_dev.pg_bin(values) / command), *arguments],
        env=env,
        capture_output=True,
        text=True,
        **kwargs,
    )
    if result.returncode:
        with (local_dev.RUNTIME / "restore-drill.log").open("a") as output:
            output.write(result.stderr)
        raise RuntimeError(f"{command} 失败，详细诊断已写入私有演练日志")
    return result


def _archive_media(source, destination):
    with tarfile.open(destination, "w") as archive:
        for path in sorted(source.rglob("*")):
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise RuntimeError("演练媒体包含不支持的特殊文件")
            archive.add(path, arcname=str(path.relative_to(source)), recursive=False)


def run(reset=False, keep=False):
    os.umask(0o077)
    local_dev.RUNTIME.mkdir(exist_ok=True, mode=0o700)
    for name in (SOURCE, TARGET):
        if _database_marker(name) is not None:
            if not reset:
                raise RuntimeError(
                    "演练数据库已存在；核对后可传 --reset-drill，仅替换本演练标记的数据"
                )
            _drop_database(name)
    created = []
    started = time.monotonic()
    try:
        for name in (SOURCE, TARGET):
            local_dev.configure_database(name, marker=MARKER)
            created.append(name)
        local_dev.manage(
            SOURCE, "migrate", "--noinput", owner=True, stdout=subprocess.DEVNULL
        )
        with tempfile.TemporaryDirectory(prefix="wealth-restore-drill-") as directory:
            work = Path(directory)
            source_media = work / "source-media"
            target_media = work / "target-media"
            source_media.mkdir(mode=0o700)
            target_media.mkdir(mode=0o700)
            fixture = _backend(SEED, SOURCE, source_media)
            before = _backend(VERIFY, SOURCE, source_media, fixture)
            backup_started = time.monotonic()
            _pg_command(
                "pg_dump",
                SOURCE,
                "--format=custom",
                "--no-owner",
                "--no-acl",
                "--file",
                str(work / "database.dump"),
            )
            _archive_media(source_media, work / "private-media.tar")
            captured_at = dt.datetime.now(dt.timezone.utc)
            manifest = {
                "format_version": 1,
                "created_at": captured_at.isoformat(),
                "consistency": "dedicated synthetic source, no writers after seed",
                "files": {
                    name: {
                        "sha256": backup.digest(work / name),
                        "size": (work / name).stat().st_size,
                    }
                    for name in ("database.dump", "private-media.tar")
                },
                "media_inventory": backup.media_inventory(work / "private-media.tar"),
            }
            (work / "manifest.json").write_text(json.dumps(manifest))
            with tarfile.open(work / "bundle.tar", "w") as archive:
                for name in ("database.dump", "private-media.tar", "manifest.json"):
                    archive.add(work / name, arcname=name, recursive=False)
            key = work / "independent.key"
            key.write_text(secrets.token_hex(32) + "\n")
            key.chmod(0o600)
            encrypted = work / "synthetic.backup.enc"
            binary = os.getenv("WEALTH_OPENSSL", "openssl")
            backup.encrypt(work / "bundle.tar", encrypted, key, binary)
            backup_seconds = time.monotonic() - backup_started
            restore_started = time.monotonic()
            recovered = work / "recovered"
            recovered.mkdir(mode=0o700)
            backup.decrypt(encrypted, work / "decrypted.tar", key, binary)
            verified_manifest = backup.unpack_and_verify(
                work / "decrypted.tar", recovered
            )
            _pg_command(
                "pg_restore",
                TARGET,
                "--role=wealth_owner",
                "--no-owner",
                "--no-acl",
                "--single-transaction",
                "--exit-on-error",
                "--dbname",
                TARGET,
                str(recovered / "database.dump"),
            )
            with local_dev.admin_connection(TARGET) as connection:
                with connection.transaction():
                    connection.execute(
                        "ALTER TABLE wealth_event DISABLE TRIGGER immutable_fact"
                    )
                    connection.execute("UPDATE wealth_event SET posted_txid='0'::xid8")
                    connection.execute(
                        "ALTER TABLE wealth_event ENABLE TRIGGER immutable_fact"
                    )
                assert (
                    connection.execute(
                        "SELECT count(*) FROM wealth_event WHERE posted_txid<>'0'::xid8"
                    ).fetchone()[0]
                    == 0
                )
            local_dev.configure_database(TARGET)
            with tarfile.open(recovered / "private-media.tar") as archive:
                # Archive paths and members were independently validated above.
                archive.extractall(target_media, filter="data")
            after = _backend(VERIFY, TARGET, target_media, fixture)
            if before != after:
                raise RuntimeError("恢复前后的账务、权限或附件核对不一致")
            for _ in range(2):
                local_dev.manage(
                    TARGET, "tick", media=target_media, stdout=subprocess.DEVNULL
                )
            repeated = _backend(VERIFY, TARGET, target_media, fixture)
            if after != repeated:
                raise RuntimeError("重复任务补跑改变了已确认事实")
            restore_seconds = time.monotonic() - restore_started
            report = {
                "status": "passed",
                "tested_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "mode": "native PostgreSQL, synthetic isolated databases",
                "databases": [SOURCE, TARGET],
                "python": platform.python_version(),
                "platform": platform.platform(),
                "backup_encrypted_and_authenticated": True,
                "manifest_files": len(verified_manifest["media_inventory"]),
                "database_dump_sha256": manifest["files"]["database.dump"]["sha256"],
                "snapshot_at": captured_at.isoformat(),
                "backup_seconds": round(backup_seconds, 3),
                "restore_and_verify_seconds": round(restore_seconds, 3),
                "total_drill_seconds": round(time.monotonic() - started, 3),
                "task_replay_count": 2,
                "task_replay_preserved_facts": True,
                "before": before,
                "after": after,
                "limits": [
                    "合成小数据演练，不代表生产规模 RPO/RTO",
                    "Docker 容器恢复尚未实测",
                    "不包含未知旧系统的数据迁移验收",
                ],
            }
            evidence = local_dev.RUNTIME / "restore-drill-result.json"
            evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(
                json.dumps(
                    {
                        "status": report["status"],
                        "evidence": str(evidence),
                        "net_assets": after["net_assets"],
                        "restore_and_verify_seconds": report[
                            "restore_and_verify_seconds"
                        ],
                        "permissions_and_media_verified": True,
                        "task_replay_preserved_facts": True,
                    },
                    ensure_ascii=False,
                )
            )
            return report
    finally:
        if not keep:
            for name in reversed(created):
                _drop_database(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset-drill", action="store_true")
    parser.add_argument("--keep-databases", action="store_true")
    args = parser.parse_args()
    try:
        run(args.reset_drill, args.keep_databases)
    except Exception as error:
        # Avoid interpreter traceback locals exposing connection credentials.
        print(f"本地恢复演练未通过：{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
