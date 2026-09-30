#!/usr/bin/env python3
"""Quiesced Compose backup, authenticated encryption, verification and restore.

No secret values are passed as command-line arguments. OpenSSL reads an external
key file. A separate HMAC key is derived from that secret and authenticates the
ciphertext before decryption. Application services stay stopped after restore.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MAGIC = b"WEALTH-BACKUP-V1\n"
CHUNK = 1024 * 1024
SERVICES = ("web", "worker", "beat")


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            value.update(chunk)
    return value.hexdigest()


def safe_name(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("Backup contains an unsafe archive path")
    return path


def read_key(path: Path) -> bytes:
    path = path.resolve(strict=True)
    if path.is_relative_to(ROOT):
        raise ValueError("Keep the backup key outside the repository")
    if not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError("Backup key must be a private regular file (chmod 600)")
    key = path.read_bytes().rstrip(b"\r\n")
    if len(key) < 32 or b"\n" in key or b"\r" in key or b"\0" in key:
        raise ValueError("Key must contain a single line of at least 32 random bytes")
    return key


def auth_key(key: bytes) -> bytes:
    return hmac.new(key, b"wealth-backup-v1/authentication", hashlib.sha256).digest()


def openssl_command(
    binary: str, key_path: Path, source: Path, destination: Path, decrypt=False
):
    command = [binary, "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-salt"]
    if decrypt:
        command.append("-d")
    return command + [
        "-pass",
        f"file:{key_path}",
        "-in",
        str(source),
        "-out",
        str(destination),
    ]


def encrypt(source: Path, destination: Path, key_path: Path, binary: str):
    key = read_key(key_path)
    if destination.exists():
        raise ValueError("Destination already exists; refusing to overwrite it")
    with tempfile.TemporaryDirectory(prefix="wealth-encrypt-") as directory:
        cipher = Path(directory) / "cipher"
        subprocess.run(openssl_command(binary, key_path, source, cipher), check=True)
        mac = hmac.new(auth_key(key), MAGIC, hashlib.sha256)
        with cipher.open("rb") as stream:
            for chunk in iter(lambda: stream.read(CHUNK), b""):
                mac.update(chunk)
        temporary = destination.with_suffix(destination.suffix + ".partial")
        try:
            with temporary.open("xb") as output, cipher.open("rb") as stream:
                output.write(MAGIC + mac.digest())
                shutil.copyfileobj(stream, output, CHUNK)
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


def decrypt(source: Path, destination: Path, key_path: Path, binary: str):
    key = read_key(key_path)
    with tempfile.TemporaryDirectory(prefix="wealth-decrypt-") as directory:
        cipher = Path(directory) / "cipher"
        mac = hmac.new(auth_key(key), MAGIC, hashlib.sha256)
        with source.open("rb") as stream, cipher.open("wb") as output:
            if stream.read(len(MAGIC)) != MAGIC:
                raise ValueError("Unknown backup format")
            expected = stream.read(32)
            for chunk in iter(lambda: stream.read(CHUNK), b""):
                mac.update(chunk)
                output.write(chunk)
        if not hmac.compare_digest(expected, mac.digest()):
            raise ValueError("Backup authentication failed: wrong key or altered file")
        subprocess.run(
            openssl_command(binary, key_path, cipher, destination, True), check=True
        )


def media_inventory(path: Path) -> dict:
    result = {}
    seen = set()
    with tarfile.open(path, "r:*") as archive:
        for member in archive:
            name = str(safe_name(member.name))
            if name in seen:
                raise ValueError("Duplicate path in media archive")
            seen.add(name)
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(
                    "Media archive may contain only directories and regular files"
                )
            value = hashlib.sha256()
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError("Missing archived file")
            with stream:
                for chunk in iter(lambda: stream.read(CHUNK), b""):
                    value.update(chunk)
            result[name] = {"size": member.size, "sha256": value.hexdigest()}
    return result


def unpack_and_verify(bundle: Path, destination: Path) -> dict:
    required = {"database.dump", "private-media.tar", "manifest.json"}
    with tarfile.open(bundle, "r:*") as archive:
        members = archive.getmembers()
        if len(members) != 3 or {member.name for member in members} != required:
            raise ValueError(
                "Backup bundle must contain exactly the three expected files"
            )
        for member in members:
            safe_name(member.name)
            if not member.isfile():
                raise ValueError("Backup bundle contains a link or special file")
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("Missing backup member")
            with source, (destination / member.name).open("xb") as output:
                shutil.copyfileobj(source, output, CHUNK)
    manifest = json.loads((destination / "manifest.json").read_text())
    if manifest.get("format_version") != 1:
        raise ValueError("Unsupported manifest version")
    for name in ("database.dump", "private-media.tar"):
        path = destination / name
        metadata = manifest["files"][name]
        if (
            path.stat().st_size != metadata["size"]
            or digest(path) != metadata["sha256"]
        ):
            raise ValueError(f"Checksum mismatch: {name}")
    if (
        media_inventory(destination / "private-media.tar")
        != manifest["media_inventory"]
    ):
        raise ValueError("Media inventory does not match the manifest")
    return manifest


class Compose:
    def __init__(self, args):
        self.command = [
            "docker",
            "compose",
            "--project-directory",
            str(ROOT),
            "-f",
            str(ROOT / "compose.yaml"),
        ]
        if args.project_name:
            self.command += ["--project-name", args.project_name]
        self.command += ["--env-file", str(Path(args.env_file).resolve())]

    def run(self, *args, **kwargs):
        return subprocess.run(self.command + list(args), check=True, **kwargs)

    def output(self, *args) -> str:
        return self.run(*args, stdout=subprocess.PIPE, text=True).stdout.strip()

    def sql(self, query: str) -> str:
        return self.output(
            "exec",
            "-T",
            "db",
            "sh",
            "-c",
            'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"',
            "sh",
            query,
        )


MEDIA_EXPORT = r"""
import pathlib, sys, tarfile
root = pathlib.Path('/app/private-media')
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as archive:
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError('Private storage contains a link or special file')
        archive.add(path, arcname=str(path.relative_to(root)), recursive=False)
"""

MEDIA_RESTORE = r"""
import os, pathlib, shutil, sys, tarfile, tempfile
root = pathlib.Path('/app/private-media')
stage = pathlib.Path(tempfile.mkdtemp(prefix='.restore-', dir=root))
try:
    with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
        for member in archive:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or '\\' in member.name:
                raise ValueError('Unsafe media path')
            target = stage.joinpath(*name.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with archive.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o600)
            else:
                raise ValueError('Links and special files are not accepted')
    for path in root.iterdir():
        if path == stage:
            continue
        if path.is_symlink() or path.is_file():
            path.unlink()
        else:
            shutil.rmtree(path)
    for path in stage.iterdir():
        path.rename(root / path.name)
finally:
    shutil.rmtree(stage, ignore_errors=True)
"""


def backup(args):
    compose = Compose(args)
    compose.run("config", "--quiet")
    output_directory = Path(args.output_dir).resolve()
    output_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    key_path = Path(args.key_file).resolve(strict=True)
    read_key(key_path)
    if key_path.is_relative_to(output_directory):
        raise ValueError("Keep the encryption key separate from backup storage")
    active = set(compose.output("ps", "--services", "--status", "running").splitlines())
    resume = [service for service in SERVICES if service in active]
    if "db" not in active:
        raise ValueError("Database service is not running")
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = output_directory / f"wealth-{stamp}.backup.enc"
    print(
        "Pausing application writers for a consistent database and file backup.",
        flush=True,
    )
    if resume:
        compose.run("stop", "--timeout", "120", *resume)
    try:
        with tempfile.TemporaryDirectory(prefix="wealth-backup-") as directory:
            stage = Path(directory)
            with (stage / "database.dump").open("wb") as output:
                compose.run(
                    "exec",
                    "-T",
                    "db",
                    "sh",
                    "-c",
                    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl',
                    stdout=output,
                )
            with (stage / "private-media.tar").open("wb") as output:
                compose.run(
                    "run",
                    "--rm",
                    "--no-deps",
                    "-T",
                    "web",
                    "python",
                    "-c",
                    MEDIA_EXPORT,
                    stdout=output,
                )
            manifest = {
                "format_version": 1,
                "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "consistency": "application web/worker/beat stopped; no external writers permitted",
                "database_version": compose.sql("SHOW server_version"),
                "image_ids": compose.output("images", "--quiet").splitlines(),
                "files": {
                    name: {
                        "sha256": digest(stage / name),
                        "size": (stage / name).stat().st_size,
                    }
                    for name in ("database.dump", "private-media.tar")
                },
                "media_inventory": media_inventory(stage / "private-media.tar"),
            }
            (stage / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
            )
            bundle = stage / "bundle.tar"
            with tarfile.open(bundle, "w") as archive:
                for name in ("database.dump", "private-media.tar", "manifest.json"):
                    archive.add(stage / name, arcname=name, recursive=False)
            encrypt(bundle, destination, key_path, args.openssl)
        print(f"Backup created: {destination}")
        print(f"SHA-256: {digest(destination)}")
    finally:
        if resume:
            compose.run("start", *resume)


@contextlib.contextmanager
def verified_bundle(args):
    with tempfile.TemporaryDirectory(prefix="wealth-verify-") as directory:
        stage = Path(directory)
        decrypt(
            Path(args.backup_file).resolve(strict=True),
            stage / "bundle.tar",
            Path(args.key_file).resolve(strict=True),
            args.openssl,
        )
        manifest = unpack_and_verify(stage / "bundle.tar", stage)
        yield stage, manifest


def verify(args):
    with verified_bundle(args) as (_, manifest):
        print(
            f"Authenticated backup and {len(manifest['media_inventory'])} private files verified."
        )
        print(f"Snapshot completed at: {manifest['created_at']}")
        print(
            "Verification alone is not a restore drill; database consistency and authorization need the drill."
        )


def restore(args):
    compose = Compose(args)
    compose.run("config", "--quiet")
    active = set(compose.output("ps", "--services", "--status", "running").splitlines())
    if active.intersection(SERVICES):
        raise ValueError(
            "Stop web, worker and beat before restore; they will not be restarted automatically"
        )
    if "db" not in active:
        raise ValueError("Start a clean database service before restoring")
    tables = int(
        compose.sql("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
    )
    if tables and args.confirm_replace != "REPLACE_TARGET_DATABASE_AND_FILES":
        raise ValueError(
            "Target is not empty; use a clean restore project or the explicit replacement confirmation"
        )
    with verified_bundle(args) as (stage, manifest):
        with (stage / "database.dump").open("rb") as source:
            compose.run(
                "exec",
                "-T",
                "db",
                "sh",
                "-c",
                'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --role=wealth_owner --no-owner --no-acl --clean --if-exists --single-transaction --exit-on-error',
                stdin=source,
            )
        # A transaction ID in an archive belongs to its original cluster. Mark
        # restored events closed so a future XID collision cannot append effects.
        # Only technical metadata changes, while all application writers are off.
        compose.sql("""DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wealth_event' AND column_name='posted_txid') THEN
            ALTER TABLE public.wealth_event DISABLE TRIGGER immutable_fact;
            UPDATE public.wealth_event SET posted_txid='0'::xid8;
            ALTER TABLE public.wealth_event ENABLE TRIGGER immutable_fact;
          END IF;
        END $$;""")
        # Restored schema belongs to the migration owner. Reapply runtime grants;
        # RLS remains in the dump, and the app role remains a non-owner.
        compose.sql(
            "GRANT USAGE ON SCHEMA public TO wealth_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wealth_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wealth_app;"
        )
        with (stage / "private-media.tar").open("rb") as source:
            compose.run(
                "run",
                "--rm",
                "--no-deps",
                "-T",
                "web",
                "python",
                "-c",
                MEDIA_RESTORE,
                stdin=source,
            )
        # Read the restored volume back, then compare every hash to the snapshot.
        with (stage / "restored-media.tar").open("wb") as output:
            compose.run(
                "run",
                "--rm",
                "--no-deps",
                "-T",
                "web",
                "python",
                "-c",
                MEDIA_EXPORT,
                stdout=output,
            )
        if media_inventory(stage / "restored-media.tar") != manifest["media_inventory"]:
            raise ValueError(
                "Restored files failed checksum verification; leave services stopped"
            )
    print("Database and private files restored; application services remain stopped.")
    print(
        "Follow docs/RUNBOOK.md: role/RLS, balances, references, queue and idempotency checks are required before reopening."
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-name", help="Compose project; use a new name for a restore drill"
    )
    parser.add_argument("--env-file", default=str(ROOT / ".env"))
    parser.add_argument(
        "--openssl", default=os.environ.get("WEALTH_OPENSSL", "openssl")
    )
    sub = parser.add_subparsers(dest="action", required=True)
    for name in ("backup", "verify", "restore"):
        command = sub.add_parser(name)
        command.add_argument(
            "--key-file",
            default=os.environ.get("WEALTH_BACKUP_KEY_FILE"),
            required=not os.environ.get("WEALTH_BACKUP_KEY_FILE"),
        )
        if name == "backup":
            command.add_argument("--output-dir", required=True)
        else:
            command.add_argument("backup_file")
        if name == "restore":
            command.add_argument("--confirm-replace")
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        globals()[args.action](args)
    except (
        ValueError,
        OSError,
        subprocess.CalledProcessError,
        tarfile.TarError,
        KeyError,
    ) as error:
        print(f"Backup operation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
