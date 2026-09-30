"""Offline tests: encryption authentication and untrusted archive handling."""

import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "wealth_backup", Path(__file__).with_name("backup.py")
)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wealth-backup-test-")
        self.directory = Path(self.temporary.name)
        self.key = self.directory / "secret.key"
        self.key.write_text(secrets.token_hex(32))
        self.key.chmod(0o600)

    def tearDown(self):
        self.temporary.cleanup()

    def write_archive(self, path, entries):
        with tarfile.open(path, "w") as archive:
            for name, value in entries:
                member = tarfile.TarInfo(name)
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))

    @unittest.skipUnless(
        shutil.which(os.environ.get("WEALTH_OPENSSL", "openssl")), "OpenSSL is required"
    )
    def test_encrypt_roundtrip_and_reject_tampering_before_decryption(self):
        original = self.directory / "input"
        original.write_bytes(b"synthetic backup payload\n")
        cipher = self.directory / "backup.enc"
        binary = os.environ.get("WEALTH_OPENSSL", "openssl")
        backup.encrypt(original, cipher, self.key, binary)
        output = self.directory / "roundtrip"
        backup.decrypt(cipher, output, self.key, binary)
        self.assertEqual(original.read_bytes(), output.read_bytes())
        corrupted = bytearray(cipher.read_bytes())
        corrupted[-1] ^= 1
        cipher.write_bytes(corrupted)
        with self.assertRaisesRegex(ValueError, "authentication failed"):
            backup.decrypt(cipher, self.directory / "must-not-exist", self.key, binary)
        self.assertFalse((self.directory / "must-not-exist").exists())

    def test_reject_world_readable_key(self):
        self.key.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private regular file"):
            backup.read_key(self.key)

    def test_reject_traversal_absolute_and_backslash_paths(self):
        for name in (
            "../outside",
            "/etc/passwd",
            "safe/../../outside",
            "safe\\outside",
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                backup.safe_name(name)

    def test_media_inventory_rejects_links_and_duplicate_paths(self):
        path = self.directory / "media.tar"
        with tarfile.open(path, "w") as archive:
            member = tarfile.TarInfo("link")
            member.type = tarfile.SYMTYPE
            member.linkname = "/etc/passwd"
            archive.addfile(member)
        with self.assertRaises(ValueError):
            backup.media_inventory(path)
        self.write_archive(path, [("same", b"first"), ("same", b"second")])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            backup.media_inventory(path)

    def test_bundle_verifies_every_file_and_manifest_hash(self):
        media = self.directory / "private-media.tar"
        self.write_archive(media, [("space-1/sample.txt", b"synthetic content")])
        database = self.directory / "database.dump"
        database.write_bytes(b"synthetic database dump")
        manifest = {
            "format_version": 1,
            "files": {
                path.name: {"size": path.stat().st_size, "sha256": backup.digest(path)}
                for path in (media, database)
            },
            "media_inventory": backup.media_inventory(media),
        }
        manifest_path = self.directory / "manifest.json"
        manifest_path.write_text(json.dumps(manifest))
        bundle = self.directory / "bundle.tar"
        with tarfile.open(bundle, "w") as archive:
            for path in (media, database, manifest_path):
                archive.add(path, arcname=path.name)
        target = self.directory / "verified"
        target.mkdir()
        self.assertEqual(backup.unpack_and_verify(bundle, target), manifest)
        database.write_bytes(b"altered dump")
        with tarfile.open(bundle, "w") as archive:
            for path in (media, database, manifest_path):
                archive.add(path, arcname=path.name)
        other = self.directory / "rejected"
        other.mkdir()
        with self.assertRaisesRegex(ValueError, "Checksum"):
            backup.unpack_and_verify(bundle, other)


if __name__ == "__main__":
    unittest.main()
