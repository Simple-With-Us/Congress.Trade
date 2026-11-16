#!/usr/bin/env python3
"""Temp-dir fixtures for local backup retention. No host and no network."""

from __future__ import annotations

import contextlib
import fcntl
import io
import os
import re
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "ops"))
import local_backup_retention as retention  # noqa: E402

SCRIPT = REPO / "scripts" / "ops" / "local-backup-retention.sh"
NOW = 1_800_000_000
HOUR = 3600
DAY = 86400
SECRET = "fixture-key-do-not-print"


def aged(path: Path, size: int, age_seconds: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    stamp = NOW - age_seconds
    os.utime(path, (stamp, stamp))
    return path


def summary(text: str) -> dict[str, str]:
    for line in text.splitlines():
        if line.startswith("SUMMARY\t"):
            return dict(part.split("=", 1) for part in line.split("\t")[1:])
    raise AssertionError("missing SUMMARY in:\n" + text)


def deleted(text: str) -> list[str]:
    return [line.split("\t")[2] for line in text.splitlines() if line.startswith("DELETE\t")]


class RetentionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_py(self, root: str, **extra: str) -> tuple[int, str]:
        env = {
            "BACKUP_RETENTION_ROOTS": root,
            "PATH": "/usr/bin:/bin",
            "RETENTION_NOW": str(NOW),
        }
        env.update(extra)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            try:
                code = retention.run(env)
            except retention.ConfigError as exc:
                return 2, f"ERROR\t{exc}"
        return code, buf.getvalue()

    def run_shell(self, root: str, **extra: str) -> tuple[int, str, str]:
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.tmp),
            "LANG": "C",
            "LC_ALL": "C",
            "BACKUP_RETENTION_ROOTS": root,
            "BACKUP_RETENTION_LOAD_ENV": "0",
            "BACKUP_RETENTION_LOCK": str(self.tmp / "retention.lock"),
            "RETENTION_NOW": str(NOW),
        }
        env.update(extra)
        proc = subprocess.run(
            ["bash", str(SCRIPT)],
            env=env,
            capture_output=True,
            text=True,
            cwd=str(REPO),
            check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr

    def test_stamp_parser_and_default_roots(self) -> None:
        self.assertEqual(
            retention.split_stamp("congress-trade-20261110T031509Z.db.zst"),
            ("congress-trade", "20261110T031509Z"),
        )
        self.assertEqual(
            retention.split_stamp("congress-trade-20261110T031509Z.db.sha256"),
            ("congress-trade", "20261110T031509Z"),
        )
        self.assertEqual(
            retention.split_stamp("appdb-2026-11-10-03-15-09.sql.gz"),
            ("appdb", "2026-11-10-03-15-09"),
        )
        self.assertEqual(
            retention.split_stamp("appdb-2026-11-10_03-15-09.sql.gz"),
            ("appdb", "2026-11-10_03-15-09"),
        )
        self.assertIsNone(retention.split_stamp("notes.txt"))
        script = (REPO / "scripts" / "ops" / "fleet-sqlite-backup.sh").read_text()
        match = re.search(r'^ROOT="([^"]+)"', script, re.M)
        self.assertIsNotNone(match)
        assert match is not None
        self.assertIn(match.group(1), retention.DEFAULT_ROOTS)
        self.assertEqual(retention.DEFAULT_ROOTS[0], "/data/coolify/backups")
        self.assertFalse(retention.same_device(1, 2))
        self.assertTrue(retention.same_device(3, 3))

    def test_dry_run_lists_bytes_and_leaves_files(self) -> None:
        root = self.tmp / "root"
        old = aged(root / "congress" / "congress-trade-20261101T000000Z.db.zst", 100, 10 * DAY)
        old_sha = aged(root / "congress" / "congress-trade-20261101T000000Z.db.sha256", 20, 10 * DAY)
        journal = aged(root / "congress" / "congress-trade-20261101T000000Z.db-journal", 5, 10 * DAY)
        mid = aged(root / "congress" / "congress-trade-20261110T000000Z.db.zst", 80, 30 * HOUR)
        new = aged(root / "congress" / "congress-trade-20261112T000000Z.db.zst", 90, HOUR)
        note = aged(root / "congress" / "notes.txt", 4, 10 * DAY)
        code, out = self.run_py(str(root), KEEP_COUNT="2", MIN_AGE_HOURS="48")
        self.assertEqual(code, 0)
        info = summary(out)
        self.assertEqual(info["mode"], "dry-run")
        self.assertEqual(info["delete_bytes"], "125")
        self.assertIn(str(old), deleted(out))
        self.assertIn(str(old_sha), deleted(out))
        self.assertIn(str(journal), deleted(out))
        self.assertNotIn(str(mid), deleted(out))
        self.assertNotIn(str(new), deleted(out))
        for path in (old, old_sha, journal, mid, new, note):
            self.assertTrue(path.exists(), path)

    def test_apply_keeps_newest_sets_and_min_age(self) -> None:
        root = self.tmp / "root"
        old = aged(root / "congress" / "congress-trade-20261101T000000Z.db.zst", 100, 10 * DAY)
        old_sha = aged(root / "congress" / "congress-trade-20261101T000000Z.db.sha256", 20, 10 * DAY)
        journal = aged(root / "congress" / "congress-trade-20261101T000000Z.db-journal", 5, 10 * DAY)
        kept_journal = aged(root / "congress" / "congress-trade-20261112T000000Z.db-journal", 5, HOUR)
        mid = aged(root / "congress" / "congress-trade-20261110T000000Z.db.zst", 80, 30 * HOUR)
        new = aged(root / "congress" / "congress-trade-20261112T000000Z.db.zst", 90, HOUR)
        kv = aged(root / "congress" / "kv-20261101T000000Z.sqlite", 15, 10 * DAY)
        code, out, err = self.run_shell(
            str(root), APPLY="1", KEEP_COUNT="2", MIN_AGE_HOURS="48"
        )
        self.assertEqual(code, 0, out + err)
        self.assertEqual(summary(out)["mode"], "apply")
        self.assertFalse(old.exists())
        self.assertFalse(old_sha.exists())
        self.assertFalse(journal.exists())
        self.assertTrue(mid.exists())
        self.assertTrue(new.exists())
        self.assertTrue(kept_journal.exists())
        self.assertTrue(kv.exists())
        self.assertNotIn(SECRET, out + err)

    def test_groups_and_roots_do_not_share_slots(self) -> None:
        root = self.tmp / "root"
        other = self.tmp / "other"
        app_old = aged(root / "db" / "appdb-2026-11-01-00-00-00.sql.gz", 10, 10 * DAY)
        app_new = aged(root / "db" / "appdb-2026-11-12-00-00-00.sql.gz", 10, 10 * DAY)
        other_db = aged(root / "db" / "otherdb-2026-11-01-00-00-00.sql.gz", 10, 10 * DAY)
        a_old = aged(other / "a" / "dump-20261101T000000Z.db", 10, 10 * DAY)
        a_new = aged(other / "a" / "dump-20261102T000000Z.db", 10, 9 * DAY)
        code, out = self.run_py(
            f"{root}:{other}", KEEP_COUNT="1", MIN_AGE_HOURS="0", APPLY="1"
        )
        self.assertEqual(code, 0, out)
        self.assertFalse(app_old.exists())
        self.assertTrue(app_new.exists())
        self.assertTrue(other_db.exists())
        self.assertFalse(a_old.exists())
        self.assertTrue(a_new.exists())
        self.assertEqual(summary(out)["delete_count"], "2")

    def test_keep_zero_still_keeps_the_newest_file(self) -> None:
        root = self.tmp / "root"
        oldest = aged(root / "db" / "app-20261101T000000Z.db", 10, 12 * DAY)
        middle = aged(root / "db" / "app-20261102T000000Z.db", 10, 11 * DAY)
        newest = aged(root / "db" / "app-20261103T000000Z.db", 10, 10 * DAY)
        code, out = self.run_py(str(root), KEEP_COUNT="0", MIN_AGE_HOURS="0", APPLY="1")
        self.assertEqual(code, 0, out)
        self.assertFalse(oldest.exists())
        self.assertFalse(middle.exists())
        self.assertTrue(newest.exists())

    def test_min_age_keeps_files_inside_the_window(self) -> None:
        root = self.tmp / "root"
        files = {
            "1h": aged(root / "db" / "app-20261112T010000Z.db", 10, HOUR),
            "24h": aged(root / "db" / "app-20261111T000000Z.db", 10, 24 * HOUR),
            "30h": aged(root / "db" / "app-20261110T180000Z.db", 10, 30 * HOUR),
            "exact": aged(root / "db" / "app-20261110T000000Z.db", 10, 48 * HOUR),
            "72h": aged(root / "db" / "app-20261109T000000Z.db", 10, 72 * HOUR),
        }
        code, out = self.run_py(str(root), KEEP_COUNT="2", MIN_AGE_HOURS="48", APPLY="1")
        self.assertEqual(code, 0, out)
        self.assertTrue(files["1h"].exists())
        self.assertTrue(files["24h"].exists())
        self.assertTrue(files["30h"].exists())
        self.assertFalse(files["exact"].exists())
        self.assertFalse(files["72h"].exists())

    def test_incomplete_newest_does_not_authorize_delete(self) -> None:
        root = self.tmp / "root"
        fresh = aged(root / "db" / "app-20261112T000000Z.db", 40, 600)
        old = aged(root / "db" / "app-20261101T000000Z.db", 40, 10 * DAY)
        code, out = self.run_py(str(root), KEEP_COUNT="0", MIN_AGE_HOURS="0", APPLY="1")
        self.assertEqual(code, 0, out)
        self.assertTrue(fresh.exists())
        self.assertTrue(old.exists())
        self.assertIn("no-newer-complete", out)

        root2 = self.tmp / "root2"
        done = aged(root2 / "db" / "app-20261112T000000Z.db", 40, 601)
        older = aged(root2 / "db" / "app-20261101T000000Z.db", 40, 10 * DAY)
        code, out = self.run_py(str(root2), KEEP_COUNT="0", MIN_AGE_HOURS="0", APPLY="1")
        self.assertEqual(code, 0, out)
        self.assertTrue(done.exists())
        self.assertFalse(older.exists())

    def test_zero_byte_does_not_authorize_delete(self) -> None:
        root = self.tmp / "root"
        empty = aged(root / "db" / "app-20261112T000000Z.db", 0, HOUR)
        old = aged(root / "db" / "app-20261101T000000Z.db", 40, 10 * DAY)
        code, out = self.run_py(str(root), KEEP_COUNT="0", MIN_AGE_HOURS="0", APPLY="1")
        self.assertEqual(code, 0, out)
        self.assertTrue(empty.exists())
        self.assertTrue(old.exists())

    def test_in_progress_does_not_consume_a_keep_slot(self) -> None:
        root = self.tmp / "root"
        partial = aged(root / "db" / "app-20261112T030000Z.db", 50, 30)
        first = aged(root / "db" / "app-20261109T000000Z.db", 50, 3 * DAY)
        second = aged(root / "db" / "app-20261108T000000Z.db", 50, 4 * DAY)
        third = aged(root / "db" / "app-20261107T000000Z.db", 50, 5 * DAY)
        code, out = self.run_py(str(root), KEEP_COUNT="2", MIN_AGE_HOURS="1", APPLY="1")
        self.assertEqual(code, 0, out)
        self.assertTrue(partial.exists())
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())
        self.assertFalse(third.exists())

    def test_symlink_and_directory_escape_are_refused(self) -> None:
        root = self.tmp / "root"
        outside = aged(self.tmp / "outside" / "secret-20261101T000000Z.db", 30, 10 * DAY)
        link = root / "db" / "secret-20261101T000000Z.db"
        link.parent.mkdir(parents=True)
        link.symlink_to(outside)
        newest = aged(root / "db" / "secret-20261112T000000Z.db", 30, HOUR)
        outside_dir = self.tmp / "outside-dir"
        hidden = aged(outside_dir / "hidden-20261101T000000Z.db", 30, 10 * DAY)
        (root / "escaped").symlink_to(outside_dir, target_is_directory=True)
        code, out = self.run_py(str(root), KEEP_COUNT="0", MIN_AGE_HOURS="0", APPLY="1")
        self.assertEqual(code, 0, out)
        self.assertTrue(outside.exists())
        self.assertEqual(outside.read_bytes(), b"x" * 30)
        self.assertTrue(link.is_symlink())
        self.assertTrue(hidden.exists())
        self.assertTrue(newest.exists())
        self.assertIn("REFUSE\t", out)
        self.assertIn("outside-root", out)

    def test_in_root_symlink_deletes_the_target(self) -> None:
        root = self.tmp / "root"
        target = aged(root / "db" / "app-20261101T000000Z.db", 25, 10 * DAY)
        link_dir = root / "a-link"
        link_dir.mkdir()
        link = link_dir / "app-20261101T000000Z.db"
        link.symlink_to(target)
        aged(root / "db" / "app-20261112T000000Z.db", 25, HOUR)
        code, out = self.run_py(str(root), KEEP_COUNT="1", MIN_AGE_HOURS="1", APPLY="1")
        self.assertEqual(code, 0, out)
        self.assertFalse(target.exists())
        self.assertFalse(link.exists())

    def test_apply_must_be_exactly_one(self) -> None:
        root = self.tmp / "root"
        old = aged(root / "db" / "app-20261101T000000Z.db", 10, 10 * DAY)
        aged(root / "db" / "app-20261112T000000Z.db", 10, HOUR)
        code, out = self.run_py(str(root), APPLY="true", KEEP_COUNT="0", MIN_AGE_HOURS="0")
        self.assertEqual(code, 0, out)
        self.assertEqual(summary(out)["mode"], "dry-run")
        self.assertTrue(old.exists())

    def test_unsafe_roots_exit_before_delete(self) -> None:
        with self.assertRaises(retention.ConfigError):
            retention.validate_root("/tmp")
        with self.assertRaises(retention.ConfigError):
            retention.validate_root("backups")
        slash = self.tmp / "to-root"
        slash.symlink_to("/")
        with self.assertRaises(retention.ConfigError):
            retention.validate_root(str(slash))
        code, out, err = self.run_shell("/tmp")
        self.assertEqual(code, 2, out + err)
        self.assertIn("too shallow", out + err)
        self.assertNotIn("DELETE\t", out)
        code, out, err = self.run_shell("backups")
        self.assertEqual(code, 2, out + err)
        self.assertNotIn("DELETE\t", out)

    def test_b2_requirement_fails_closed(self) -> None:
        root = self.tmp / "root"
        first = aged(root / "db" / "app-20261101T000000Z.db", 10, 10 * DAY)
        second = aged(root / "db" / "app-20261102T000000Z.db", 11, 9 * DAY)
        third = aged(root / "db" / "app-20261103T000000Z.db", 12, 8 * DAY)
        stub = self.tmp / "bin"
        stub.mkdir()
        log = self.tmp / "b2.log"
        (stub / "b2").write_text(
            textwrap.dedent(
                f"""\
                #!/bin/sh
                printf '%s\\n' "$@" >> {log}
                echo hetzner/app-20261101T000000Z.db
                """
            )
        )
        (stub / "b2").chmod(0o755)
        common = {
            "APPLY": "1",
            "KEEP_COUNT": "1",
            "MIN_AGE_HOURS": "0",
            "REQUIRE_B2_COPY": "1",
            "B2_BUCKET": "fixture-bucket",
            "B2_PREFIX": "hetzner",
            "PATH": f"{stub}:/usr/bin:/bin",
        }
        code, out = self.run_py(str(root), **common)
        self.assertEqual(code, 0, out)
        self.assertIn("b2-creds-absent", out)
        self.assertFalse(log.exists())
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())
        self.assertTrue(third.exists())

        listed = dict(common)
        listed["B2_APPLICATION_KEY_ID"] = "fixture-id"
        listed["B2_APPLICATION_KEY"] = SECRET
        code, out = self.run_py(str(root), **listed)
        self.assertEqual(code, 0, out)
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        self.assertTrue(third.exists())
        self.assertNotIn(SECRET, out)
        self.assertIn("b2://fixture-bucket/hetzner", log.read_text())
        self.assertNotIn(SECRET, log.read_text())

        log.unlink()
        (stub / "b2").write_text("#!/bin/sh\nexit 1\n")
        (stub / "b2").chmod(0o755)
        second.write_bytes(b"x" * 11)
        os.utime(second, (NOW - 9 * DAY, NOW - 9 * DAY))
        code, out = self.run_py(str(root), **listed)
        self.assertEqual(code, 0, out)
        self.assertIn("b2-list-failed", out)
        self.assertTrue(second.exists())
        self.assertTrue(third.exists())

    def test_b2_keeps_a_generation_unless_every_file_is_listed(self) -> None:
        root = self.tmp / "root"
        old_db = aged(root / "congress" / "congress-trade-20261101T000000Z.db.zst", 40, 10 * DAY)
        old_sha = aged(root / "congress" / "congress-trade-20261101T000000Z.db.sha256", 8, 10 * DAY)
        new_db = aged(root / "congress" / "congress-trade-20261112T000000Z.db.zst", 40, HOUR)
        stub = self.tmp / "bin"
        stub.mkdir()
        (stub / "b2").write_text(
            "#!/bin/sh\necho hetzner/congress-trade-20261101T000000Z.db.zst\n"
        )
        (stub / "b2").chmod(0o755)
        code, out = self.run_py(
            str(root),
            APPLY="1",
            KEEP_COUNT="1",
            MIN_AGE_HOURS="1",
            REQUIRE_B2_COPY="1",
            B2_BUCKET="fixture-bucket",
            B2_APPLICATION_KEY_ID="fixture-id",
            B2_APPLICATION_KEY=SECRET,
            PATH=f"{stub}:/usr/bin:/bin",
        )
        self.assertEqual(code, 0, out)
        self.assertTrue(old_db.exists())
        self.assertTrue(old_sha.exists())
        self.assertTrue(new_db.exists())
        self.assertIn("b2-copy-missing", out)

    def test_duplicate_basenames_need_a_path_match(self) -> None:
        root = self.tmp / "root"
        a_old = aged(root / "a" / "db-20261101T000000Z.db", 10, 10 * DAY)
        aged(root / "a" / "db-20261103T000000Z.db", 10, HOUR)
        b_old = aged(root / "b" / "db-20261101T000000Z.db", 10, 10 * DAY)
        aged(root / "b" / "db-20261103T000000Z.db", 10, HOUR)
        stub = self.tmp / "bin"
        stub.mkdir()
        (stub / "b2").write_text(
            "#!/bin/sh\necho hetzner/a/db-20261101T000000Z.db\n"
        )
        (stub / "b2").chmod(0o755)
        code, out = self.run_py(
            str(root),
            APPLY="1",
            KEEP_COUNT="1",
            MIN_AGE_HOURS="1",
            REQUIRE_B2_COPY="1",
            B2_BUCKET="fixture-bucket",
            B2_APPLICATION_KEY_ID="fixture-id",
            B2_APPLICATION_KEY=SECRET,
            PATH=f"{stub}:/usr/bin:/bin",
        )
        self.assertEqual(code, 0, out)
        self.assertFalse(a_old.exists())
        self.assertTrue(b_old.exists())

    def test_aws_s3api_when_b2_is_absent(self) -> None:
        root = self.tmp / "root"
        old = aged(root / "db" / "app-20261101T000000Z.sql.gz", 15, 10 * DAY)
        new = aged(root / "db" / "app-20261112T000000Z.sql.gz", 15, HOUR)
        stub = self.tmp / "bin"
        stub.mkdir()
        log = self.tmp / "aws.log"
        (stub / "aws").write_text(
            textwrap.dedent(
                f"""\
                #!/bin/sh
                printf '%s\\n' "$@" >> {log}
                printf '%s\\n' '{{"IsTruncated": false, "Contents": [{{"Key": "hetzner/app-20261101T000000Z.sql.gz"}}]}}'
                """
            )
        )
        (stub / "aws").chmod(0o755)
        code, out = self.run_py(
            str(root),
            APPLY="1",
            KEEP_COUNT="1",
            MIN_AGE_HOURS="1",
            REQUIRE_B2_COPY="1",
            B2_BUCKET="fixture-bucket",
            B2_PREFIX="hetzner",
            AWS_ACCESS_KEY_ID="fixture-id",
            AWS_SECRET_ACCESS_KEY=SECRET,
            PATH=f"{stub}:/usr/bin:/bin",
        )
        self.assertEqual(code, 0, out)
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())
        recorded = log.read_text()
        self.assertIn("s3api", recorded)
        self.assertIn("list-objects-v2", recorded)
        self.assertNotIn(SECRET, recorded)
        self.assertNotIn(SECRET, out)

    def test_requirement_off_does_not_call_b2(self) -> None:
        root = self.tmp / "root"
        old = aged(root / "db" / "app-20261101T000000Z.db", 10, 10 * DAY)
        aged(root / "db" / "app-20261112T000000Z.db", 10, HOUR)
        stub = self.tmp / "bin"
        stub.mkdir()
        log = self.tmp / "called"
        (stub / "b2").write_text(f"#!/bin/sh\ntouch {log}\nexit 9\n")
        (stub / "b2").chmod(0o755)
        code, out = self.run_py(
            str(root),
            APPLY="1",
            KEEP_COUNT="1",
            MIN_AGE_HOURS="1",
            B2_APPLICATION_KEY_ID="fixture-id",
            B2_APPLICATION_KEY=SECRET,
            B2_BUCKET="fixture-bucket",
            PATH=f"{stub}:/usr/bin:/bin",
        )
        self.assertEqual(code, 0, out)
        self.assertFalse(log.exists())
        self.assertFalse(old.exists())

    def test_env_file_does_not_override_or_print_secrets(self) -> None:
        env_file = self.tmp / "retention.env"
        env_file.write_text(
            'APPLY="1"\nKEEP_COUNT=3\nB2_APPLICATION_KEY=' + SECRET + "\n"
        )
        code, out, err = self.run_shell(
            str(self.tmp / "unused"),
            BACKUP_RETENTION_LOAD_ENV="1",
            BACKUP_RETENTION_ENV=str(env_file),
            BACKUP_RETENTION_PRINT_CONFIG="1",
            KEEP_COUNT="9",
        )
        self.assertEqual(code, 0, out + err)
        self.assertIn("apply=1", out)
        self.assertIn("keep=9", out)
        self.assertNotIn(SECRET, out + err)

    def test_lock_skips_without_deleting(self) -> None:
        root = self.tmp / "root"
        old = aged(root / "db" / "app-20261101T000000Z.db", 10, 10 * DAY)
        aged(root / "db" / "app-20261112T000000Z.db", 10, HOUR)
        lock = self.tmp / "held.lock"
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, out, err = self.run_shell(
                str(root),
                APPLY="1",
                KEEP_COUNT="1",
                MIN_AGE_HOURS="1",
                BACKUP_RETENTION_LOCK=str(lock),
            )
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        self.assertEqual(code, 0, out + err)
        self.assertIn("already-running", out)
        self.assertTrue(old.exists())

    def test_systemd_units_stay_dry_run(self) -> None:
        unit_dir = REPO / "scripts" / "ops" / "systemd.noindex"
        service = (unit_dir / "fleet-local-backup-retention.service").read_text()
        timer = (unit_dir / "fleet-local-backup-retention.timer").read_text()
        active_service = "\n".join(
            line for line in service.splitlines() if not line.strip().startswith("#")
        )
        active_timer = "\n".join(
            line for line in timer.splitlines() if not line.strip().startswith("#")
        )
        self.assertIn("ExecStart=/usr/local/sbin/local-backup-retention.sh", active_service)
        self.assertIn(
            "EnvironmentFile=-/etc/fleet-local-backup-retention.env", active_service
        )
        self.assertNotIn("APPLY=1", active_service)
        self.assertIn("OnCalendar=daily", active_timer)
        self.assertIn("Unit=fleet-local-backup-retention.service", active_timer)
        self.assertNotIn("Requires=", active_timer)
        self.assertNotIn("WantedBy=", active_service)
        self.assertNotRegex(active_timer, r"^APPLY=")
        self.assertNotIn("APPLY=1", active_timer)
        self.assertTrue(stat.S_ISREG(os.stat(SCRIPT).st_mode))

    def test_unstamped_files_do_not_share_a_keep_slot(self) -> None:
        root = self.tmp / "root"
        older = aged(root / "db" / "manual-a.sql.gz", 40, 10 * DAY)
        middle = aged(root / "db" / "manual-b.sql.gz", 40, 9 * DAY)
        newest = aged(root / "db" / "manual-c.sql.gz", 40, 8 * DAY)
        code, out = self.run_py(str(root), APPLY="1", KEEP_COUNT="2", MIN_AGE_HOURS="48")
        self.assertEqual(code, 0)
        self.assertEqual(deleted(out), [])
        self.assertTrue(older.exists())
        self.assertTrue(middle.exists())
        self.assertTrue(newest.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
