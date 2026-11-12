#!/usr/bin/env python3
"""Keep the newest local Coolify and fleet sqlite backups on their current disk.

Dry-run unless APPLY=1. A timestamped payload and its sidecars count as one
snapshot, so the newest N per app/database are N snapshots. The newest file in
a group is never deleted, and a file is deleted only when a newer complete
file already exists in that group.

fleet-sqlite-backup.sh stores dumps under ROOT=/data/backups. This tool reads
that directory. It does not modify that script.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field

DEFAULT_ROOTS = ("/data/coolify/backups", "/data/backups")
DEFAULT_KEEP = 2
DEFAULT_MIN_AGE_HOURS = 48
DEFAULT_IN_PROGRESS_MINUTES = 10
MAX_KEEP = 10000
MAX_AGE_HOURS = 24 * 365 * 10
MAX_PROGRESS_MINUTES = 24 * 60
B2_LIST_TIMEOUT_SECONDS = 30
B2_MAX_STDOUT = 20_000_000
B2_MAX_PAGES = 50

REASON_RANK = {
    "newest-file": 0,
    "in-progress": 1,
    "no-newer-complete": 2,
    "within-min-age": 3,
    "within-keep-count": 4,
    "b2-copy-missing": 5,
    "b2-creds-absent": 5,
    "b2-tool-absent": 5,
    "b2-bucket-unset": 5,
    "b2-list-failed": 5,
    "beyond-keep": 9,
}

_FLEET_STAMP = re.compile(
    r"^(?:(?P<prefix>.*?)[-_])?(?P<stamp>\d{8}T\d{6}Z)(?P<rest>(?:\.[A-Za-z0-9]+)+)$"
)
_COOLIFY_STAMP = re.compile(
    r"^(?:(?P<prefix>.*?)[-_])?(?P<stamp>\d{4}-\d{2}-\d{2}[-_T]\d{2}-\d{2}-\d{2})"
    r"(?P<rest>(?:\.[A-Za-z0-9]+)+)$"
)
_COMPACT_STAMP = re.compile(
    r"^(?:(?P<prefix>.*?)[-_])?(?P<stamp>\d{4}-\d{2}-\d{2}[-_]\d{6})"
    r"(?P<rest>(?:\.[A-Za-z0-9]+)+)$"
)
_BACKUP_SUFFIXES = (
    ".sql",
    ".sql.gz",
    ".sql.zst",
    ".sql.bz2",
    ".dump",
    ".dump.gz",
    ".dmp",
    ".backup",
    ".bak",
    ".db",
    ".db.zst",
    ".db.gz",
    ".sqlite",
    ".sqlite.zst",
    ".sqlite3",
    ".tar",
    ".tar.gz",
    ".tgz",
    ".zip",
    ".sha256",
    ".gz",
    ".zst",
    ".custom",
    ".xb",
)
_SIDE_SUFFIXES = ("-journal", "-wal", "-shm", ".partial", ".zst.partial")


class ConfigError(Exception):
    pass


@dataclass
class FileRec:
    path: str
    real: str
    name: str
    rel: str
    group: str
    display_group: str
    generation: str
    size: int
    mtime: float
    is_payload: bool
    dev: int
    aliases: list[str] = field(default_factory=list)


@dataclass
class Action:
    rec: FileRec
    action: str
    reason: str


def emit(line: str) -> None:
    sys.stdout.write(line + "\n")


def flag_exact(env: MappingEnv, name: str) -> bool:
    return env.get(name, "") == "1"


class MappingEnv(dict):
    """os.environ or a plain dict. Both support .get."""


def parse_bounded_int(raw: str | None, default: int, name: str, upper: int) -> int:
    text = (raw if raw is not None else "").strip()
    if text == "":
        value = default
    elif re.fullmatch(r"\d+", text):
        value = int(text)
    else:
        raise ConfigError(f"non-integer {name}")
    if value < 0 or value > upper:
        raise ConfigError(f"{name} out of range")
    return value


def split_roots(raw: str) -> list[str]:
    parts = re.split(r"[:\n]+", raw)
    return [part.strip() for part in parts if part.strip()]


def configured_roots(env: MappingEnv) -> list[str]:
    if "BACKUP_RETENTION_ROOTS" in env:
        roots = split_roots(env.get("BACKUP_RETENTION_ROOTS", ""))
        if not roots:
            raise ConfigError("BACKUP_RETENTION_ROOTS is empty")
    else:
        roots = list(DEFAULT_ROOTS)
    extra = env.get("BACKUP_RETENTION_EXTRA_ROOTS", "").strip()
    if extra:
        roots.extend(split_roots(extra))
    return roots


def validate_root(path: str) -> str | None:
    """Return the real directory, None if the path is missing, or raise."""
    if not os.path.isabs(path):
        raise ConfigError(f"root is not absolute: {path}")
    normalized = os.path.normpath(path)
    if len([part for part in normalized.split(os.sep) if part]) < 2:
        raise ConfigError(f"root is too shallow: {path}")
    if not os.path.lexists(path):
        return None
    real = os.path.realpath(path)
    if real == os.sep or not real.startswith(os.sep):
        raise ConfigError(f"root resolves outside a safe directory: {path}")
    if not os.path.isdir(real):
        raise ConfigError(f"root is not a directory: {path}")
    return real


def looks_like_backup(name: str) -> bool:
    lower = name.lower()
    if lower.endswith((".partial", ".tmp", ".filepart", ".lock")):
        return False
    if lower.endswith(("-journal", "-wal", "-shm")):
        return False
    if split_stamp(name) is not None:
        return True
    return lower.endswith(_BACKUP_SUFFIXES)


def is_payload_name(name: str) -> bool:
    lower = name.lower()
    if lower.endswith(".sha256"):
        return False
    if lower.endswith((".partial", ".tmp", ".filepart", ".lock")):
        return False
    if lower.endswith(("-journal", "-wal", "-shm")):
        return False
    return True


def split_stamp(name: str) -> tuple[str, str] | None:
    for pattern in (_FLEET_STAMP, _COOLIFY_STAMP, _COMPACT_STAMP):
        match = pattern.match(name)
        if match:
            return match.group("prefix") or "", match.group("stamp")
    return None


def under_root(real: str, root_real: str) -> bool:
    real_norm = os.path.normpath(real)
    root_norm = os.path.normpath(root_real)
    return real_norm.startswith(root_norm + os.sep)


def same_device(file_dev: int, root_dev: int) -> bool:
    return file_dev == root_dev


def logical_group(parent: str, prefix: str, stamped: bool, name: str = "") -> str:
    if stamped:
        parts = [part for part in (parent, prefix) if part and part != "."]
        return "/".join(parts) if parts else "."
    # No recognized stamp means this file is not a member of a snapshot series.
    # Its own name is the group, so KEEP_COUNT cannot delete a neighbor.
    parts = [part for part in (parent, name) if part and part != "."]
    return "/".join(parts) if parts else "."


def discover(root_real: str) -> tuple[list[FileRec], list[Action], int]:
    records: dict[str, FileRec] = {}
    refuses: list[Action] = []
    ignored = 0
    root_dev = os.stat(root_real).st_dev

    def note_walk_error(err: OSError) -> None:
        emit(f"WALK_FAIL\t{err.filename}")

    for dirpath, _dirnames, filenames in os.walk(
        root_real, onerror=note_walk_error, followlinks=False
    ):
        for name in filenames:
            path = os.path.join(dirpath, name)
            try:
                lst = os.lstat(path)
            except OSError:
                emit(f"WALK_FAIL\t{path}")
                continue
            if not stat.S_ISREG(lst.st_mode) and not stat.S_ISLNK(lst.st_mode):
                ignored += 1
                continue
            if not looks_like_backup(name):
                ignored += 1
                continue
            real = os.path.realpath(path)
            if not under_root(real, root_real):
                refuses.append(
                    Action(
                        _refuse_rec(path, name, root_real),
                        "refuse",
                        "outside-root",
                    )
                )
                continue
            try:
                st = os.stat(real)
            except OSError:
                emit(f"WALK_FAIL\t{path}")
                continue
            if not stat.S_ISREG(st.st_mode):
                ignored += 1
                continue
            if not same_device(st.st_dev, root_dev):
                refuses.append(
                    Action(
                        _refuse_rec(path, name, root_real),
                        "refuse",
                        "other-device",
                    )
                )
                continue
            rel = os.path.relpath(real, root_real)
            parent = os.path.dirname(rel)
            stamped = split_stamp(name)
            if stamped:
                prefix, stamp = stamped
                logical = logical_group(parent, prefix, True)
                generation = logical + "|" + stamp
            else:
                logical = logical_group(parent, "", False, name)
                generation = logical + "|file|" + name
            display = logical
            if real in records:
                if path not in records[real].aliases:
                    records[real].aliases.append(path)
                continue
            records[real] = FileRec(
                path=path,
                real=real,
                name=name,
                rel=rel.replace(os.sep, "/"),
                group=root_real + "\n" + logical,
                display_group=display,
                generation=root_real + "\n" + generation,
                size=st.st_size,
                mtime=st.st_mtime,
                is_payload=is_payload_name(name),
                dev=st.st_dev,
                aliases=[path],
            )
    return list(records.values()), refuses, ignored


def _refuse_rec(path: str, name: str, root_real: str) -> FileRec:
    return FileRec(
        path=path,
        real=path,
        name=name,
        rel=name,
        group=root_real + "\nrefuse",
        display_group="refuse",
        generation=root_real + "\nrefuse|" + path,
        size=0,
        mtime=0,
        is_payload=False,
        dev=-1,
    )


def _protect(actions: dict[str, Action], rec: FileRec, reason: str) -> None:
    current = actions[rec.real]
    if current.action == "refuse":
        return
    if current.action == "keep" and REASON_RANK[current.reason] <= REASON_RANK[reason]:
        return
    actions[rec.real] = Action(rec, "keep", reason)


def plan(
    records: list[FileRec],
    now: float,
    keep: int,
    min_age_seconds: float,
    progress_seconds: float,
) -> list[Action]:
    actions = {rec.real: Action(rec, "delete", "beyond-keep") for rec in records}
    groups: dict[str, list[FileRec]] = defaultdict(list)
    for rec in records:
        groups[rec.group].append(rec)
    progress_cutoff = now - progress_seconds
    age_cutoff = now - min_age_seconds

    for members in groups.values():
        newest = max(members, key=lambda rec: (rec.mtime, rec.path))
        generations: dict[str, list[FileRec]] = defaultdict(list)
        for rec in members:
            generations[rec.generation].append(rec)

        def in_progress(items: list[FileRec]) -> bool:
            return any(item.mtime >= progress_cutoff for item in items)

        def complete(items: list[FileRec]) -> bool:
            if in_progress(items):
                return False
            return any(
                item.is_payload and item.size > 0 and item.mtime < progress_cutoff
                for item in items
            )

        def sort_key(items: list[FileRec]) -> tuple[float, str]:
            payloads = [item for item in items if item.is_payload and item.size > 0]
            pool = payloads or items
            top = max(pool, key=lambda rec: (rec.mtime, rec.path))
            return (top.mtime, top.path)

        complete_gens = [items for items in generations.values() if complete(items)]
        complete_gens.sort(key=sort_key, reverse=True)
        for items in complete_gens[:keep]:
            for item in items:
                _protect(actions, item, "within-keep-count")

        for items in generations.values():
            if in_progress(items):
                for item in items:
                    _protect(actions, item, "in-progress")
            payloads = [item for item in items if item.is_payload] or items
            if max(item.mtime for item in payloads) > age_cutoff:
                for item in items:
                    _protect(actions, item, "within-min-age")

        for item in generations[newest.generation]:
            _protect(actions, item, "newest-file")
        _protect(actions, newest, "newest-file")

        complete_files = [
            item
            for item in members
            if item.is_payload and item.size > 0 and item.mtime < progress_cutoff
        ]
        for items in generations.values():
            if all(actions[item.real].action == "keep" for item in items):
                continue

            def has_newer(target: FileRec) -> bool:
                target_key = (target.mtime, target.path)
                for other in complete_files:
                    if other.generation == target.generation:
                        continue
                    if (other.mtime, other.path) > target_key:
                        return True
                return False

            if not all(has_newer(item) for item in items):
                for item in items:
                    _protect(actions, item, "no-newer-complete")

    return list(actions.values())


def sidecar_candidates(payload_path: str) -> list[str]:
    bases = [payload_path]
    if payload_path.endswith(".zst"):
        bases.append(payload_path[: -len(".zst")])
    if payload_path.endswith(".gz"):
        bases.append(payload_path[: -len(".gz")])
    found: list[str] = []
    for base in bases:
        for suffix in _SIDE_SUFFIXES:
            found.append(base + suffix)
    return found


def _b2_buckets(env: MappingEnv) -> list[str]:
    raw = env.get("B2_BUCKET", "") or env.get("B2_BUCKETS", "")
    return [part.strip() for part in raw.split(",") if part.strip()]


def _credentials_present(env: MappingEnv) -> bool:
    if env.get("B2_APPLICATION_KEY_ID") and env.get("B2_APPLICATION_KEY"):
        return True
    if env.get("AWS_ACCESS_KEY_ID") and env.get("AWS_SECRET_ACCESS_KEY"):
        return True
    return False


def _run_list(cmd: list[str], env: MappingEnv) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=B2_LIST_TIMEOUT_SECONDS,
            env=dict(env),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def _keys_from_b2(stdout: str) -> set[str]:
    keys: set[str] = set()
    for line in stdout.splitlines():
        parts = line.strip().split()
        if not parts or parts[-1].startswith("{"):
            continue
        keys.add(parts[-1])
    return keys


def _aws_page(bucket: str, prefix: str, token: str | None, env: MappingEnv) -> tuple[set[str], str | None, bool] | None:
    cmd = [
        "aws",
        "s3api",
        "list-objects-v2",
        "--bucket",
        bucket,
        "--output",
        "json",
        "--max-keys",
        "1000",
    ]
    if prefix:
        cmd.extend(["--prefix", prefix])
    if token:
        cmd.extend(["--continuation-token", token])
    completed = _run_list(cmd, env)
    if completed is None or completed.returncode != 0:
        return None
    if len(completed.stdout) > B2_MAX_STDOUT:
        return None
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        return None
    keys: set[str] = set()
    for item in payload.get("Contents") or []:
        key = item.get("Key") if isinstance(item, dict) else None
        if isinstance(key, str) and key:
            keys.add(key)
    next_token = payload.get("NextContinuationToken")
    truncated = bool(payload.get("IsTruncated"))
    if truncated and not isinstance(next_token, str):
        return None
    return keys, (next_token if isinstance(next_token, str) else None), truncated


def list_remote_keys(env: MappingEnv) -> tuple[str, set[str]]:
    """Return (status, keys). status is ok or a keep reason. No secret text."""
    if not _credentials_present(env):
        return "b2-creds-absent", set()
    buckets = _b2_buckets(env)
    if not buckets:
        return "b2-bucket-unset", set()
    path = env.get("PATH", "")
    b2 = shutil.which("b2", path=path)
    aws = shutil.which("aws", path=path)
    if b2 is None and aws is None:
        return "b2-tool-absent", set()
    prefix = env.get("B2_PREFIX", "").strip().strip("/")
    keys: set[str] = set()
    if b2 is not None:
        for bucket in buckets:
            url = f"b2://{bucket}"
            if prefix:
                url = f"{url}/{prefix}"
            completed = _run_list([b2, "ls", "--recursive", url], env)
            if completed is None or completed.returncode != 0:
                return "b2-list-failed", set()
            if len(completed.stdout) > B2_MAX_STDOUT:
                return "b2-list-failed", set()
            keys.update(_keys_from_b2(completed.stdout))
        return "ok", keys
    for bucket in buckets:
        token: str | None = None
        for _page in range(B2_MAX_PAGES):
            page = _aws_page(bucket, prefix + "/" if prefix else "", token, env)
            if page is None:
                return "b2-list-failed", set()
            page_keys, token, truncated = page
            keys.update(page_keys)
            if not truncated:
                break
        else:
            return "b2-list-failed", set()
    return "ok", keys


def remote_confirms(rec: FileRec, keys: set[str], basename_counts: dict[str, int]) -> bool:
    rel = rec.rel
    base = rec.name
    for key in keys:
        tail = key.rstrip("/").split("/")[-1]
        if tail != base and key != base:
            continue
        if basename_counts[base] > 1:
            if key == rel or key.endswith("/" + rel):
                return True
            continue
        return True
    return False


def apply_b2(actions: list[Action], env: MappingEnv) -> list[Action]:
    if not flag_exact(env, "REQUIRE_B2_COPY"):
        return actions
    deletes = [item for item in actions if item.action == "delete"]
    if not deletes:
        return actions
    status, keys = list_remote_keys(env)
    by_real = {item.rec.real: item for item in actions}
    if status != "ok":
        for item in deletes:
            _protect(by_real, item.rec, status)
        return list(by_real.values())
    counts: dict[str, int] = defaultdict(int)
    for item in deletes:
        counts[item.rec.name] += 1
    generations: dict[str, list[Action]] = defaultdict(list)
    for item in deletes:
        generations[item.rec.generation].append(item)
    for items in generations.values():
        if all(remote_confirms(item.rec, keys, counts) for item in items):
            continue
        for item in items:
            _protect(by_real, item.rec, "b2-copy-missing")
    return list(by_real.values())


def extra_sidecar_actions(
    actions: list[Action],
    root_devs: dict[str, int],
    now: float,
    progress_seconds: float,
) -> list[Action]:
    known = {item.rec.real for item in actions}
    extras: list[Action] = []
    busy: set[str] = set()
    progress_cutoff = now - progress_seconds
    delete_payloads = [
        item for item in actions if item.action == "delete" and item.rec.is_payload
    ]
    for item in delete_payloads:
        root_real = item.rec.group.split("\n", 1)[0]
        root_dev = root_devs.get(root_real)
        for cand in sidecar_candidates(item.rec.path):
            if not os.path.lexists(cand):
                continue
            real = os.path.realpath(cand)
            if real in known:
                continue
            if root_dev is None or not under_root(real, root_real):
                extras.append(
                    Action(
                        _refuse_rec(cand, os.path.basename(cand), root_real),
                        "refuse",
                        "outside-root",
                    )
                )
                continue
            try:
                st = os.stat(real)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode) or not same_device(st.st_dev, root_dev):
                extras.append(
                    Action(
                        _refuse_rec(cand, os.path.basename(cand), root_real),
                        "refuse",
                        "other-device",
                    )
                )
                continue
            if st.st_mtime >= progress_cutoff:
                # A fresh journal means this snapshot is still being written.
                busy.add(item.rec.generation)
                continue
            rec = FileRec(
                path=cand,
                real=real,
                name=os.path.basename(cand),
                rel=os.path.relpath(real, root_real).replace(os.sep, "/"),
                group=item.rec.group,
                display_group=item.rec.display_group,
                generation=item.rec.generation,
                size=st.st_size,
                mtime=st.st_mtime,
                is_payload=False,
                dev=st.st_dev,
                aliases=[cand],
            )
            extras.append(Action(rec, "delete", "beyond-keep"))
            known.add(real)
    if not busy:
        return actions + extras
    kept: list[Action] = []
    for existing in actions:
        if existing.action == "delete" and existing.rec.generation in busy:
            kept.append(Action(existing.rec, "keep", "in-progress"))
        else:
            kept.append(existing)
    kept.extend(extra for extra in extras if extra.rec.generation not in busy)
    return kept


def _still_same(rec: FileRec) -> bool:
    if not os.path.lexists(rec.path):
        return False
    real = os.path.realpath(rec.path)
    if real != rec.real:
        return False
    try:
        st = os.stat(real)
    except OSError:
        return False
    if not stat.S_ISREG(st.st_mode):
        return False
    if st.st_size != rec.size:
        return False
    if abs(st.st_mtime - rec.mtime) > 1e-6:
        return False
    return True


def unlink_action(action: Action, root_devs: dict[str, int]) -> str:
    """Return applied, skipped, or failed. Unlink only the planned inside path."""
    root_real = action.rec.group.split("\n", 1)[0]
    root_dev = root_devs.get(root_real)
    if root_dev is None or not under_root(action.rec.real, root_real):
        return "skipped"
    if not same_device(action.rec.dev, root_dev) and action.rec.dev != -1:
        return "skipped"
    if not os.path.lexists(action.rec.path):
        return "applied"
    if not _still_same(action.rec):
        return "skipped"
    try:
        # A directory entry may be a symlink to the real dump. Remove the
        # in-root target, then the extra names. Never unlink a path whose
        # real location is outside the root (that case is a refuse).
        if action.rec.path != action.rec.real and os.path.islink(action.rec.path):
            if under_root(action.rec.real, root_real) and os.path.lexists(action.rec.real):
                os.unlink(action.rec.real)
        if os.path.lexists(action.rec.path):
            os.unlink(action.rec.path)
    except OSError:
        return "failed"
    for alias in action.rec.aliases:
        if alias == action.rec.path or not os.path.lexists(alias):
            continue
        alias_real = os.path.realpath(alias)
        if alias_real != action.rec.real or not under_root(alias, root_real):
            continue
        try:
            if stat.S_ISLNK(os.lstat(alias).st_mode) or os.path.isfile(alias):
                os.unlink(alias)
        except OSError:
            return "failed"
    return "applied"


def print_config(env: MappingEnv, keep: int, min_age: int, progress: int) -> None:
    roots = ",".join(configured_roots(env))
    emit(
        "CONFIG"
        f"\tapply={1 if flag_exact(env, 'APPLY') else 0}"
        f"\tkeep={keep}"
        f"\tmin_age_hours={min_age}"
        f"\tin_progress_minutes={progress}"
        f"\trequire_b2={1 if flag_exact(env, 'REQUIRE_B2_COPY') else 0}"
        f"\troots={roots}"
    )


def _now(env: MappingEnv) -> float:
    raw = env.get("RETENTION_NOW", "").strip()
    if raw == "":
        return time.time()
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError("non-numeric RETENTION_NOW") from exc


def run(env: MappingEnv) -> int:
    keep = parse_bounded_int(env.get("KEEP_COUNT"), DEFAULT_KEEP, "KEEP_COUNT", MAX_KEEP)
    min_age_hours = parse_bounded_int(
        env.get("MIN_AGE_HOURS"), DEFAULT_MIN_AGE_HOURS, "MIN_AGE_HOURS", MAX_AGE_HOURS
    )
    progress_minutes = parse_bounded_int(
        env.get("IN_PROGRESS_MINUTES"),
        DEFAULT_IN_PROGRESS_MINUTES,
        "IN_PROGRESS_MINUTES",
        MAX_PROGRESS_MINUTES,
    )
    if flag_exact(env, "BACKUP_RETENTION_PRINT_CONFIG"):
        print_config(env, keep, min_age_hours, progress_minutes)
        return 0

    now = _now(env)
    apply = flag_exact(env, "APPLY")
    root_devs: dict[str, int] = {}
    records: list[FileRec] = []
    refuses: list[Action] = []
    ignored = 0
    seen_roots: set[str] = set()
    for configured in configured_roots(env):
        real = validate_root(configured)
        if real is None:
            emit(f"ROOT_MISSING\t{configured}")
            continue
        if real in seen_roots:
            continue
        seen_roots.add(real)
        root_devs[real] = os.stat(real).st_dev
        emit(f"ROOT\t{real}")
        found, refused, skipped = discover(real)
        records.extend(found)
        refuses.extend(refused)
        ignored += skipped

    actions = plan(
        records,
        now,
        keep,
        min_age_hours * 3600,
        progress_minutes * 60,
    )
    actions.extend(refuses)
    actions = apply_b2(actions, env)
    actions = extra_sidecar_actions(actions, root_devs, now, progress_minutes * 60)

    delete_count = 0
    delete_bytes = 0
    keep_count = 0
    refuse_count = 0
    failures = 0
    for item in sorted(actions, key=lambda action: (action.action, action.rec.path)):
        if item.action == "delete":
            emit(
                f"DELETE\t{item.rec.size}\t{item.rec.path}\t{item.rec.display_group}\t{item.reason}"
            )
            delete_count += 1
            delete_bytes += item.rec.size
        elif item.action == "keep":
            emit(f"KEEP\t{item.rec.path}\t{item.rec.display_group}\t{item.reason}")
            keep_count += 1
        else:
            emit(f"REFUSE\t{item.rec.path}\t{item.reason}")
            refuse_count += 1

    applied = 0
    if apply:
        for item in actions:
            if item.action != "delete":
                continue
            result = unlink_action(item, root_devs)
            if result == "applied":
                applied += 1
            elif result == "failed":
                failures += 1
                emit(f"APPLY_FAIL\t{item.rec.path}")
            else:
                emit(f"APPLY_SKIP\t{item.rec.path}\tchanged")
        emit(f"APPLIED\t{applied}")

    mode = "apply" if apply else "dry-run"
    emit(
        "SUMMARY"
        f"\tmode={mode}"
        f"\tdelete_count={delete_count}"
        f"\tdelete_bytes={delete_bytes}"
        f"\tkeep_count={keep_count}"
        f"\trefuse_count={refuse_count}"
        f"\tignored={ignored}"
    )
    if failures:
        return 1
    return 0


def main() -> int:
    try:
        return run(os.environ)
    except ConfigError as exc:
        emit(f"ERROR\t{exc}")
        return 2
    except Exception as exc:
        emit("ERROR\tretention failed")
        sys.stderr.write(f"local-backup-retention: {type(exc).__name__}: {exc}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
