#!/usr/bin/env python3
"""Offline tests for the Docker reclaim planner and its shell wrapper."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


OPS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS))

import docker_reclaim as planner  # noqa: E402


NOW = datetime(2026, 11, 12, tzinfo=timezone.utc)
NOW_TEXT = "2026-11-12T00:00:00Z"
MARKER = "fixture-marker-do-not-print"
APP1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
APP2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
APP3 = "cccccccc-cccc-cccc-cccc-cccccccccccc"
ROOT = OPS.parents[1]
SHELL = OPS / "docker-reclaim.sh"
ZERO = "0001-01-01T00:00:00Z"


def hid(prefix: str, fill: str) -> str:
    if len(prefix) != 12 or len(fill) != 1:
        raise AssertionError("bad id parts")
    return prefix + (fill * 52)


IMG_RUNNING = hid("111111111111", "a")
IMG_PREV = hid("222222222222", "b")
IMG_OLD = hid("333333333333", "c")
IMG_DANGLE = hid("444444444444", "d")
IMG_YOUNG = hid("555555555555", "e")
IMG_NGINX = hid("666666666666", "f")
IMG_STOPPED = hid("777777777777", "1")
IMG_APP2 = hid("888888888888", "2")
IMG_SIB = hid("999999999999", "3")
IMG_DEAD = hid("aaaaaaaaaaaa", "4")
C_RUN = hid("c11111111111", "a")
C_PLAIN = hid("c22222222222", "b")
C_RECENT = hid("c33333333333", "c")
C_SIB = hid("c44444444444", "d")
C_DEAD = hid("c55555555555", "e")
VOL_ANON = "ab" * 32
VOL_COOL = "cd" * 32
VOL_USED = "ef" * 32


def app(uuid: str) -> dict[str, str]:
    return {"coolify.managed": "true", "coolify.applicationId": uuid}


def image(
    full: str,
    created: datetime,
    tags: list[str] | None = None,
    labels: dict[str, str] | None = None,
    containers: int = 0,
    size: int = 1000,
) -> planner.ImageRec:
    tags = list(tags or [])
    return planner.ImageRec(
        full_id=full,
        created=created,
        repo_tags=tags,
        labels=dict(labels or {}),
        inspect_size=size,
        unique_size=size,
        df_containers=containers,
        repos=[planner.repo_of(tag) for tag in tags if tag and tag != "<none>:<none>"],
    )


def container(
    full: str,
    image_id: str,
    status: str,
    *,
    name: str = "/helper",
    created: datetime | None = None,
    finished: datetime | None = None,
    labels: dict[str, str] | None = None,
    df_status: str = "Exited (0) 40 days ago",
    size: int = 10,
) -> planner.ContainerRec:
    return planner.ContainerRec(
        full_id=full,
        image_id=image_id,
        name=name,
        created=created or (NOW - timedelta(days=40)),
        status=status,
        finished_at=finished,
        started_at=created,
        labels=dict(labels or {}),
        df_status=df_status,
        size=size,
    )


def volume(
    name: str,
    *,
    labels: dict[str, str] | None = None,
    links: int | None = 0,
    size: int = 100,
    in_df: bool = True,
) -> planner.VolumeRec:
    return planner.VolumeRec(
        name=name,
        labels=dict(labels or {}),
        links=links,
        size=size,
        in_df=in_df,
    )


def plan(
    images: list[planner.ImageRec],
    containers: list[planner.ContainerRec],
    volumes: list[planner.VolumeRec] | None = None,
    cache: list[planner.CacheRec] | None = None,
    until: str = "72h",
    days: int = 14,
) -> planner.Plan:
    return planner.build_plan(
        summary="TYPE TOTAL\nImages 1\n",
        images=images,
        containers=containers,
        volumes=list(volumes or []),
        cache=list(cache or []),
        now=NOW,
        image_min_age_days=days,
        container_min_age_days=days,
        coolify_recent_days=days,
        build_cache_until=until,
        mode="dry-run",
    )


def action_values(result: planner.Plan, kind: str) -> set[str]:
    return {action.value for action in result.actions if action.kind == kind}


def write_demo(path: Path) -> None:
    images = [
        (IMG_RUNNING, f"{APP1}:deploy-new", "100MB", "1", "2 weeks ago"),
        (IMG_PREV, f"{APP1}:deploy-prev", "90MB", "0", "6 weeks ago"),
        (IMG_OLD, f"{APP1}:deploy-old", "80MB", "0", "3 months ago"),
        (IMG_DANGLE, "<none>:<none>", "70MB", "0", "4 months ago"),
        (IMG_YOUNG, "<none>:<none>", "10MB", "0", "1 day ago"),
        (IMG_NGINX, "nginx:old", "60MB", "0", "10 months ago"),
        (IMG_STOPPED, "scratch:old", "50MB", "1", "5 months ago"),
        (IMG_APP2, f"{APP2}:current", "40MB", "1", "11 days ago"),
        (IMG_SIB, f"{APP1}:deploy-sib", "30MB", "1", "4 months ago"),
        (IMG_DEAD, f"{APP3}:only", "20MB", "1", "5 months ago"),
    ]
    image_rows = []
    for full, ref, size, count, created in images:
        repo, tag = ref.split(":", 1)
        image_rows.append([repo, tag, full[:12], created, size, "0B", size, count])
    image_rows.append(["nginx", "1.25", IMG_NGINX[:12], "10 months ago", "60MB", "0B", "60MB", "0"])
    containers = [
        (C_RUN, f"{APP1}:deploy-new", "Up 12 hours", "congress-app", "1MB"),
        (C_PLAIN, "scratch:old", "Exited (0) 40 days ago", "one-shot", "5MB"),
        (C_RECENT, f"{APP2}:current", "Exited (0) 7 days ago", "app-two", "2MB"),
        (C_SIB, f"{APP1}:deploy-sib", "Exited (0) 40 days ago", "app-one-old", "3MB"),
        (C_DEAD, f"{APP3}:only", "Exited (0) 40 days ago", "app-three", "4MB"),
    ]
    container_rows = [
        [full[:12], ref, MARKER, "0", size, "40 days ago", status, name]
        for full, ref, status, name, size in containers
    ]
    volume_rows = [
        [VOL_ANON, "0", "12MB"],
        [VOL_COOL, "0", "8MB"],
        [VOL_USED, "1", "3MB"],
        ["coolify-db", "1", "2GB"],
        ["my-data", "0", "1GB"],
    ]
    cache_rows = [
        ["cacheold0001", "regular", "2GB", "10 days ago", "10 days ago", "1", "false"],
        ["cache3day001", "regular", "100MB", "3 days ago", "3 days ago", "1", "false"],
        ["cache2hour01", "regular", "500MB", "2 hours ago", "2 hours ago", "1", "true"],
        ["cachenone001", "regular", "50MB", "N/A", "N/A", "0", "false"],
    ]
    verbose = "\n".join(
        [
            "Images space usage:",
            "",
            planner.render_table(
                [
                    "REPOSITORY",
                    "TAG",
                    "IMAGE ID",
                    "CREATED",
                    "SIZE",
                    "SHARED SIZE",
                    "UNIQUE SIZE",
                    "CONTAINERS",
                ],
                image_rows,
            ),
            "",
            "Containers space usage:",
            "",
            planner.render_table(
                [
                    "CONTAINER ID",
                    "IMAGE",
                    "COMMAND",
                    "LOCAL VOLUMES",
                    "SIZE",
                    "CREATED",
                    "STATUS",
                    "NAMES",
                ],
                container_rows,
            ),
            "",
            "Local Volumes space usage:",
            "",
            planner.render_table(["VOLUME NAME", "LINKS", "SIZE"], volume_rows),
            "",
            "Build cache usage: 2.6GB",
            "",
            planner.render_table(
                ["CACHE ID", "CACHE TYPE", "SIZE", "CREATED", "LAST USED", "USAGE", "SHARED"],
                cache_rows,
            ),
            "",
        ]
    )
    (path / "df-verbose.txt").write_text(verbose + "\n", encoding="utf-8")
    (path / "df-summary.txt").write_text(
        "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\n"
        "Images          10        4         1.5GB     900MB (60%)\n"
        "Containers      5         1         20MB      9MB (45%)\n"
        "Local Volumes   5         2         3.2GB     12MB (0%)\n"
        "Build Cache     4         0         2.6GB     BEFORE-TOTAL\n",
        encoding="utf-8",
    )
    (path / "df-summary-after.txt").write_text(
        "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\n"
        "Images          7         4         1.1GB     200MB (18%)\n"
        "Containers      3         1         6MB       0B (0%)\n"
        "Local Volumes   4         2         3.1GB     0B (0%)\n"
        "Build Cache     2         0         600MB     AFTER-TOTAL\n",
        encoding="utf-8",
    )
    image_meta = {
        IMG_RUNNING: ("2026-11-01T00:00:00Z", [f"{APP1}:deploy-new"], app(APP1)),
        IMG_PREV: ("2026-10-01T00:00:00Z", [f"{APP1}:deploy-prev"], app(APP1)),
        IMG_OLD: ("2026-08-01T00:00:00Z", [f"{APP1}:deploy-old"], app(APP1)),
        IMG_DANGLE: ("2026-07-01T00:00:00Z", [], {}),
        IMG_YOUNG: ("2026-11-11T00:00:00Z", [], {}),
        IMG_NGINX: ("2026-01-01T00:00:00Z", ["nginx:old", "nginx:1.25"], {}),
        IMG_STOPPED: ("2026-06-01T00:00:00Z", ["scratch:old"], {}),
        IMG_APP2: ("2026-11-01T00:00:00Z", [f"{APP2}:current"], app(APP2)),
        IMG_SIB: ("2026-07-15T00:00:00Z", [f"{APP1}:deploy-sib"], app(APP1)),
        IMG_DEAD: ("2026-06-15T00:00:00Z", [f"{APP3}:only"], app(APP3)),
    }
    image_lines = []
    for full, (created, tags, labels) in image_meta.items():
        image_lines.append(
            json.dumps(
                {
                    "Id": full,
                    "Created": created,
                    "Size": 1,
                    "RepoTags": tags,
                    "Labels": labels,
                }
            )
        )
    (path / "images.jsonl").write_text("\n".join(image_lines) + "\n", encoding="utf-8")
    image_id_lines = list(image_meta)
    image_id_lines.append(IMG_NGINX)
    (path / "image-ids.txt").write_text("\n".join(image_id_lines) + "\n", encoding="utf-8")
    container_meta = [
        (C_RUN, IMG_RUNNING, "/congress-app", "running", ZERO, "2026-11-11T00:00:00Z", app(APP1)),
        (C_PLAIN, IMG_STOPPED, "/one-shot", "exited", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z", {}),
        (C_RECENT, IMG_APP2, "/app-two", "exited", "2026-11-05T00:00:00Z", "2026-11-01T00:00:00Z", app(APP2)),
        (C_SIB, IMG_SIB, "/app-one-old", "exited", "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z", app(APP1)),
        (C_DEAD, IMG_DEAD, "/app-three", "exited", "2026-07-01T00:00:00Z", "2026-06-15T00:00:00Z", app(APP3)),
    ]
    container_lines = []
    for full, image_id, name, status, finished, started, labels in container_meta:
        container_lines.append(
            json.dumps(
                {
                    "Id": full,
                    "Image": f"sha256:{image_id}",
                    "Name": name,
                    "Created": started,
                    "Status": status,
                    "FinishedAt": finished,
                    "StartedAt": started,
                    "Labels": labels,
                }
            )
        )
    (path / "containers.jsonl").write_text("\n".join(container_lines) + "\n", encoding="utf-8")
    (path / "container-ids.txt").write_text(
        "\n".join(item[0] for item in container_meta) + "\n",
        encoding="utf-8",
    )
    volume_meta = [
        (VOL_ANON, "", "0"),
        (VOL_COOL, "coolify.managed=true,coolify.applicationId=" + APP1, "0"),
        (VOL_USED, "", "1"),
        ("coolify-db", "coolify.managed=true", "1"),
        ("my-data", "", "0"),
    ]
    volume_lines = []
    for name, labels, links in volume_meta:
        volume_lines.append(
            json.dumps(
                {
                    "Name": name,
                    "Labels": labels,
                    "Links": links,
                    "Mountpoint": "/var/lib/docker/volumes/" + name,
                    "Options": MARKER,
                }
            )
        )
    (path / "volumes.jsonl").write_text("\n".join(volume_lines) + "\n", encoding="utf-8")


FAKE_DOCKER = """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

root = Path(os.environ["FIXTURE"])
log = Path(os.environ["DOCKER_LOG"])
state = Path(os.environ["DOCKER_STATE"])
args = sys.argv[1:]
with log.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(args) + "\\n")

def fail(message):
    sys.stderr.write(message + "\\n")
    sys.exit(3)

if any(flag in args for flag in ("-a", "--all", "-af")):
    fail("refused broad flag")
if "prune" in args and args[:2] != ["builder", "prune"]:
    fail("refused prune")
if args[:2] == ["system", "df"] and "-v" not in args and "--verbose" not in args:
    name = "df-summary-after.txt" if (state / "mutated").exists() else "df-summary.txt"
    sys.stdout.write((root / name).read_text(encoding="utf-8"))
    sys.exit(0)
if args[:2] == ["system", "df"] and "-v" in args:
    if "--format" in args:
        fail("json format is not this fixture")
    sys.stdout.write((root / "df-verbose.txt").read_text(encoding="utf-8"))
    sys.exit(0)
if args[:1] == ["ps"] and "--format" in args:
    active = (root / "build-active.txt")
    if active.exists():
        sys.stdout.write(active.read_text(encoding="utf-8"))
    sys.exit(0)
if args[:1] == ["ps"] and "-aq" in args:
    sys.stdout.write((root / "container-ids.txt").read_text(encoding="utf-8"))
    sys.exit(0)
if args[:1] == ["images"] and "-aq" in args:
    sys.stdout.write((root / "image-ids.txt").read_text(encoding="utf-8"))
    sys.exit(0)
if args[:2] == ["container", "inspect"]:
    sys.stdout.write((root / "containers.jsonl").read_text(encoding="utf-8"))
    sys.exit(0)
if args[:2] == ["image", "inspect"]:
    if len(args) < 5 or args[2] != "--format":
        fail("image inspect argv")
    image_ids = args[4:]
    if len(image_ids) != len(set(image_ids)):
        fail("duplicate image id")
    sys.stdout.write((root / "images.jsonl").read_text(encoding="utf-8"))
    sys.exit(0)
if args[:2] == ["volume", "ls"]:
    sys.stdout.write((root / "volumes.jsonl").read_text(encoding="utf-8"))
    sys.exit(0)
if args[:1] == ["rm"] and len(args) == 2 and not args[1].startswith("-"):
    state.mkdir(parents=True, exist_ok=True)
    (state / "mutated").write_text("1", encoding="utf-8")
    sys.exit(0)
if args[:2] == ["image", "rm"] and len(args) == 3 and not args[2].startswith("-"):
    refused = (root / "refuse-image-rm.txt")
    if refused.exists() and args[2] in refused.read_text(encoding="utf-8").splitlines():
        sys.exit(5)
    state.mkdir(parents=True, exist_ok=True)
    (state / "mutated").write_text("1", encoding="utf-8")
    sys.exit(0)
if args[:2] == ["volume", "rm"] and len(args) == 3 and not args[2].startswith("-"):
    state.mkdir(parents=True, exist_ok=True)
    (state / "mutated").write_text("1", encoding="utf-8")
    sys.exit(0)
if args == ["builder", "prune", "-f", "--filter", "until=" + os.environ.get("EXPECT_UNTIL", "72h")]:
    state.mkdir(parents=True, exist_ok=True)
    (state / "mutated").write_text("1", encoding="utf-8")
    sys.exit(0)
fail("unexpected argv " + " ".join(args))
"""


class PlannerTests(unittest.TestCase):
    def test_docker_timestamps(self) -> None:
        parsed = planner.parse_time("2026-11-01T00:00:00.123456789Z")
        self.assertEqual(parsed, datetime(2026, 11, 1, 0, 0, 0, 123456, tzinfo=timezone.utc))
        self.assertIsNone(planner.parse_time("0001-01-01T00:00:00.000000000Z"))
        self.assertEqual(
            planner.parse_time("2026-11-01 00:00:00 +0000 UTC"),
            datetime(2026, 11, 1, tzinfo=timezone.utc),
        )

    def test_sizes_and_relative_times(self) -> None:
        self.assertEqual(planner.parse_size("70MB"), 70_000_000)
        self.assertEqual(planner.parse_size("2GB"), 2_000_000_000)
        self.assertEqual(planner.parse_size("12.4kB"), 12400)
        self.assertEqual(planner.parse_size("1KiB"), 1024)
        self.assertEqual(planner.parse_size("0B"), 0)
        three_days = planner.parse_relative("3 days ago", NOW)
        self.assertIsNotNone(three_days)
        assert three_days is not None
        self.assertFalse(three_days < NOW - timedelta(hours=72))
        ten_days = planner.parse_relative("10 days ago", NOW)
        self.assertIsNotNone(ten_days)
        assert ten_days is not None
        self.assertTrue(ten_days < NOW - timedelta(hours=72))
        self.assertIsNone(planner.parse_relative("N/A", NOW))

    def test_label_forms(self) -> None:
        mapped = planner._labels_from("map[coolify.managed:true coolify.applicationId:abc]")
        self.assertEqual(mapped["coolify.applicationId"], "abc")
        paired = planner._labels_from("coolify.managed=true,coolify.applicationId=abc")
        self.assertEqual(paired["coolify.managed"], "true")
        self.assertFalse(planner.has_coolify({"notcoolify.managed": "true"}))
        self.assertTrue(planner.has_coolify({"coolify.managed": "true"}))

    def test_demo_keeps_rollback_and_live_coolify(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_demo(root)
            result = planner.plan_from_dir(
                root,
                now=NOW,
                image_min_age_days=14,
                container_min_age_days=14,
                coolify_recent_days=14,
                build_cache_until="72h",
                mode="dry-run",
            )
        self.assertNotIn(MARKER, result.report)
        self.assertIn("source: docker system df -v", result.report)
        self.assertIn("BEFORE-TOTAL", result.report)
        self.assertIn("dangling_images count=1 bytes=70000000", result.report)
        self.assertIn("unused_images_older_than count=2 bytes=140000000", result.report)
        self.assertIn("stopped_containers_older_than count=2 bytes=9000000", result.report)
        self.assertIn("dangling_anonymous_volumes count=1 bytes=12000000", result.report)
        self.assertIn("build_cache_older_than count=1 bytes=2000000000", result.report)
        self.assertIn(f"rollback_image {IMG_PREV} repo=", result.report)
        self.assertEqual(action_values(result, "image"), {IMG_OLD, IMG_DANGLE, IMG_NGINX})
        self.assertEqual(action_values(result, "container"), {C_PLAIN, C_DEAD})
        self.assertEqual(action_values(result, "volume"), {VOL_ANON})
        self.assertEqual(action_values(result, "build-cache"), {"72h"})
        self.assertNotIn(IMG_PREV, action_values(result, "image"))
        self.assertNotIn(IMG_RUNNING, action_values(result, "image"))
        self.assertNotIn(IMG_STOPPED, action_values(result, "image"))
        self.assertNotIn(IMG_DEAD, action_values(result, "image"))
        self.assertNotIn(IMG_YOUNG, action_values(result, "image"))
        self.assertNotIn(C_RUN, action_values(result, "container"))
        self.assertNotIn(C_RECENT, action_values(result, "container"))
        self.assertNotIn(C_SIB, action_values(result, "container"))

    def test_previous_is_the_image_before_newest_in_use(self) -> None:
        repo = "dddddddd-dddd-dddd-dddd-dddddddddddd"
        current = image(
            hid("d11111111111", "a"),
            NOW - timedelta(days=10),
            [f"{repo}:current"],
            containers=1,
        )
        previous = image(
            hid("d22222222222", "b"),
            NOW - timedelta(days=20),
            [f"{repo}:previous"],
        )
        ancient = image(
            hid("d33333333333", "c"),
            NOW - timedelta(days=40),
            [f"{repo}:ancient"],
        )
        inflight = image(
            hid("d44444444444", "d"),
            NOW - timedelta(hours=2),
            [f"{repo}:inflight"],
        )
        running = container(
            hid("d55555555555", "e"),
            current.full_id,
            "running",
            name="/app",
            df_status="Up 2 hours",
            labels=app(repo),
        )
        result = plan([inflight, current, previous, ancient], [running])
        self.assertEqual(action_values(result, "image"), {ancient.full_id})
        self.assertEqual(action_values(result, "container"), set())
        self.assertIn(f"rollback_image {previous.full_id} repo=", result.report)

    def test_untagged_labeled_previous_image_is_kept(self) -> None:
        current = image(
            hid("ae1111111111", "a"),
            NOW - timedelta(days=1),
            [f"{APP1}:current"],
            labels=app(APP1),
            containers=1,
        )
        previous = image(
            hid("ae2222222222", "b"),
            NOW - timedelta(days=30),
            [],
            labels=app(APP1),
        )
        older = image(
            hid("ae3333333333", "c"),
            NOW - timedelta(days=60),
            [],
            labels=app(APP1),
        )
        running = container(
            hid("ae4444444444", "d"),
            current.full_id,
            "running",
            name="/app",
            df_status="Up 1 hour",
            labels=app(APP1),
        )
        result = plan([current, previous, older], [running])
        self.assertEqual(action_values(result, "image"), {older.full_id})
        self.assertIn(f"rollback_image {previous.full_id} repo=", result.report)

    def test_orphan_repo_keeps_two_newest(self) -> None:
        repo = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
        newest = image(hid("e11111111111", "a"), NOW - timedelta(days=30), [f"{repo}:new"])
        middle = image(hid("e22222222222", "b"), NOW - timedelta(days=40), [f"{repo}:mid"])
        oldest = image(hid("e33333333333", "c"), NOW - timedelta(days=50), [f"{repo}:old"])
        result = plan([newest, middle, oldest], [])
        self.assertEqual(action_values(result, "image"), {oldest.full_id})
        self.assertIn(f"rollback_image {middle.full_id} repo=", result.report)

    def test_unidentified_coolify_labels_use_unique_fallback_keys(self) -> None:
        repo1 = f"{APP1}:current"
        repo2 = f"{APP2}:current"
        current1 = image(
            hid("af1111111111", "a"),
            NOW - timedelta(days=1),
            [repo1],
            labels={"coolify.managed": "true"},
            containers=1,
        )
        previous1 = image(
            hid("af2222222222", "b"),
            NOW - timedelta(days=30),
            [f"{APP1}:previous"],
            labels={"coolify.managed": "true"},
        )
        current2 = image(
            hid("af3333333333", "c"),
            NOW - timedelta(days=1),
            [repo2],
            labels={"coolify.managed": "true"},
            containers=1,
        )
        previous2 = image(
            hid("af4444444444", "d"),
            NOW - timedelta(days=30),
            [f"{APP2}:previous"],
            labels={"coolify.managed": "true"},
        )
        running1 = container(
            hid("af5555555555", "e"),
            current1.full_id,
            "running",
            labels={"coolify.managed": "true"},
        )
        running2 = container(
            hid("af6666666666", "f"),
            current2.full_id,
            "running",
            labels={"coolify.managed": "true"},
        )
        result = plan(
            [current1, previous1, current2, previous2],
            [running1, running2],
        )
        self.assertIn(f"rollback_image {previous1.full_id}", result.report)
        self.assertIn(f"rollback_image {previous2.full_id}", result.report)
        self.assertNotIn(previous1.full_id, action_values(result, "image"))
        self.assertNotIn(previous2.full_id, action_values(result, "image"))

    def test_verify_df_stable_rejects_a_changed_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_demo(root)
            stable = (root / "df-verbose.txt").read_text(encoding="utf-8")
            planner.verify_df_stable(stable, stable)
            shifted = stable.replace(IMG_OLD[:12], "fffffffffffe", 1)
            with self.assertRaises(planner.SnapshotError):
                planner.verify_df_stable(stable, shifted)

    def test_age_boundary_and_control_plane(self) -> None:
        kept = image(hid("f11111111111", "a"), NOW - timedelta(days=14), [])
        removed = image(hid("f22222222222", "b"), NOW - timedelta(days=14, seconds=1), [])
        control_image = image(
            hid("f33333333333", "c"),
            NOW - timedelta(days=100),
            ["ghcr.io/coollabsio/coolify:4"],
        )
        plain = image(hid("f44444444444", "d"), NOW - timedelta(days=30), ["scratch:tool"])
        control_container = container(
            hid("f55555555555", "e"),
            plain.full_id,
            "exited",
            name="/coolify-proxy",
            finished=NOW - timedelta(days=100),
        )
        old_plain = container(
            hid("f66666666666", "f"),
            plain.full_id,
            "exited",
            name="/helper",
            finished=NOW - timedelta(days=30),
        )
        # The plain image is referenced, so it stays. The dangling images are not.
        plain.df_containers = 1
        result = plan(
            [kept, removed, control_image, plain],
            [control_container, old_plain],
        )
        self.assertIn(removed.full_id, action_values(result, "image"))
        self.assertNotIn(kept.full_id, action_values(result, "image"))
        self.assertNotIn(control_image.full_id, action_values(result, "image"))
        self.assertNotIn(plain.full_id, action_values(result, "image"))
        self.assertEqual(action_values(result, "container"), {old_plain.full_id})
        self.assertNotIn(control_container.full_id, action_values(result, "container"))

    def test_volumes_and_false_coolify_prefix(self) -> None:
        anon = "12" * 32
        labeled = "34" * 32
        false_prefix = "56" * 32
        result = plan(
            [],
            [],
            [
                volume(anon, size=12_000_000),
                volume(labeled, labels={"coolify.managed": "true"}, size=8),
                volume(false_prefix, labels={"notcoolify.managed": "true"}, size=9),
                volume("my-data", links=0, size=50),
                volume("coolify-db", links=1, size=50),
                volume(VOL_USED, links=1, size=3),
                volume("99" * 32, links=None, size=4),
                volume("88" * 32, links=0, in_df=False, size=4),
            ],
        )
        self.assertEqual(action_values(result, "volume"), {anon, false_prefix})

    def test_df_status_disagreement_keeps_container(self) -> None:
        used = image(hid("ab1111111111", "a"), NOW - timedelta(days=3), ["scratch:live"], containers=1)
        stale = container(
            hid("ab2222222222", "b"),
            used.full_id,
            "exited",
            finished=NOW - timedelta(days=40),
            df_status="Up 3 hours",
        )
        result = plan([used], [stale])
        self.assertEqual(action_values(result, "container"), set())
        self.assertIn("reason=df_status_live", result.report)

    def test_inconsistent_snapshot_fails_closed(self) -> None:
        missing = image(hid("ac1111111111", "a"), NOW - timedelta(days=40), [], containers=2)
        with self.assertRaises(planner.SnapshotError):
            plan([missing], [])
        present = image(hid("ac2222222222", "b"), NOW - timedelta(days=40), ["scratch:x"])
        orphan = container(hid("ac3333333333", "c"), hid("ac4444444444", "d"), "exited")
        with self.assertRaises(planner.SnapshotError):
            plan([present], [orphan])

    def test_build_cache_estimate_respects_until(self) -> None:
        rows = [
            planner.CacheRec("old", 2_000_000_000, NOW - timedelta(days=10)),
            planner.CacheRec("boundary", 100_000_000, NOW - timedelta(days=3)),
            planner.CacheRec("young", 500_000_000, NOW - timedelta(hours=2)),
            planner.CacheRec("unknown", 50_000_000, None),
        ]
        at_72 = plan([], [], cache=rows, until="72h")
        self.assertIn("build_cache_older_than count=1 bytes=2000000000", at_72.report)
        at_48 = plan([], [], cache=rows, until="48h")
        self.assertIn("build_cache_older_than count=2 bytes=2100000000", at_48.report)
        self.assertEqual(action_values(at_48, "build-cache"), {"48h"})

    def test_public_repo_does_not_keep_an_unrelated_previous_image(self) -> None:
        current = image(hid("ad1111111111", "a"), NOW - timedelta(days=2), ["nginx:1.27"], containers=1)
        older = image(hid("ad2222222222", "b"), NOW - timedelta(days=40), ["nginx:1.26"])
        running = container(
            hid("ad3333333333", "c"),
            current.full_id,
            "running",
            df_status="Up 1 hour",
        )
        result = plan([current, older], [running])
        self.assertEqual(action_values(result, "image"), {older.full_id})
        self.assertNotIn("rollback_image", result.report)

    def test_ambiguous_df_id_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = hid("abcabcabcabc", "a")
            second = hid("abcabcabcabc", "b")
            self._write_min_snapshot(root, [first, second], df_ids=[first[:12]])
            with self.assertRaises(planner.SnapshotError):
                planner.plan_from_dir(
                    root,
                    now=NOW,
                    image_min_age_days=14,
                    container_min_age_days=14,
                    coolify_recent_days=14,
                    build_cache_until="72h",
                    mode="dry-run",
                )

    def test_repeated_image_rows_merge_when_they_agree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_min_snapshot(
                root,
                [IMG_NGINX],
                df_ids=[IMG_NGINX[:12], IMG_NGINX[:12]],
                df_sizes=["60MB", "60MB"],
                df_counts=["0", "0"],
            )
            recorded = (root / "images.jsonl").read_text(encoding="utf-8")
            (root / "images.jsonl").write_text(recorded + recorded, encoding="utf-8")
            result = planner.plan_from_dir(
                root,
                now=NOW,
                image_min_age_days=14,
                container_min_age_days=14,
                coolify_recent_days=14,
                build_cache_until="72h",
                mode="dry-run",
            )
        self.assertIn("dangling_images count=1 bytes=60000000", result.report)
        self.assertEqual(action_values(result, "image"), {IMG_NGINX})

    def test_repeated_image_rows_fail_when_they_disagree(self) -> None:
        cases = (
            (["60MB", "61MB"], ["0", "0"]),
            (["60MB", "60MB"], ["0", "1"]),
        )
        for sizes, counts in cases:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                self._write_min_snapshot(
                    root,
                    [IMG_NGINX],
                    df_ids=[IMG_NGINX[:12], IMG_NGINX[:12]],
                    df_sizes=sizes,
                    df_counts=counts,
                )
                with self.assertRaises(planner.SnapshotError):
                    planner.plan_from_dir(
                        root,
                        now=NOW,
                        image_min_age_days=14,
                        container_min_age_days=14,
                        coolify_recent_days=14,
                        build_cache_until="72h",
                        mode="dry-run",
                    )

    def test_disagreeing_image_inspect_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_min_snapshot(root, [IMG_NGINX], df_ids=[IMG_NGINX[:12]])
            lines = (root / "images.jsonl").read_text(encoding="utf-8").splitlines()
            other = json.loads(lines[0])
            other["Size"] = 2
            lines.append(json.dumps(other))
            (root / "images.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
            with self.assertRaises(planner.SnapshotError):
                planner.plan_from_dir(
                    root,
                    now=NOW,
                    image_min_age_days=14,
                    container_min_age_days=14,
                    coolify_recent_days=14,
                    build_cache_until="72h",
                    mode="dry-run",
                )

    def _write_min_snapshot(
        self,
        root: Path,
        image_ids: list[str],
        df_ids: list[str],
        df_sizes: list[str] | None = None,
        df_counts: list[str] | None = None,
    ) -> None:
        sizes = df_sizes or ["1MB"] * len(df_ids)
        counts = df_counts or ["0"] * len(df_ids)
        rows = [
            ["repo", f"t{index}", short, "10 days ago", size, "0B", size, count]
            for index, (short, size, count) in enumerate(zip(df_ids, sizes, counts, strict=True))
        ]
        verbose = "\n".join(
            [
                "Images space usage:",
                "",
                planner.render_table(
                    [
                        "REPOSITORY",
                        "TAG",
                        "IMAGE ID",
                        "CREATED",
                        "SIZE",
                        "SHARED SIZE",
                        "UNIQUE SIZE",
                        "CONTAINERS",
                    ],
                    rows,
                ),
                "",
                "Containers space usage:",
                "",
                planner.render_table(
                    [
                        "CONTAINER ID",
                        "IMAGE",
                        "COMMAND",
                        "LOCAL VOLUMES",
                        "SIZE",
                        "CREATED",
                        "STATUS",
                        "NAMES",
                    ],
                    [],
                ),
                "",
                "Local Volumes space usage:",
                "",
                planner.render_table(["VOLUME NAME", "LINKS", "SIZE"], []),
                "",
                "Build cache usage: 0B",
                "",
                planner.render_table(
                    ["CACHE ID", "CACHE TYPE", "SIZE", "CREATED", "LAST USED", "USAGE", "SHARED"],
                    [],
                ),
                "",
            ]
        )
        (root / "df-verbose.txt").write_text(verbose + "\n", encoding="utf-8")
        (root / "df-summary.txt").write_text("TYPE TOTAL\nImages 0\n", encoding="utf-8")
        lines = [
            json.dumps(
                {
                    "Id": full,
                    "Created": "2026-01-01T00:00:00Z",
                    "Size": 1,
                    "RepoTags": [],
                    "Labels": {},
                }
            )
            for full in image_ids
        ]
        (root / "images.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
        (root / "containers.jsonl").write_text("", encoding="utf-8")
        (root / "volumes.jsonl").write_text("", encoding="utf-8")


class ShellTests(unittest.TestCase):
    def test_script_refuses_broad_prunes_and_hides_env(self) -> None:
        text = SHELL.read_text(encoding="utf-8")
        code = "\n".join(line.split("#", 1)[0] for line in text.splitlines())
        for forbidden in (
            "volume prune",
            "system prune",
            "image prune",
            "container prune",
            "rmi",
            "rm -f",
            "--all",
            ".Env",
            ".Mounts",
            "Mountpoint",
            ".Options",
        ):
            self.assertNotIn(forbidden, code)
        self.assertIn("builder prune -f --filter", code)
        self.assertIn("{{json .Config.Labels}}", text)

    def test_bad_config_does_not_call_docker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = root / "called"
            docker = root / "docker"
            docker.write_text(
                "#!/bin/sh\ntouch " + str(marker) + "\nexit 99\n",
                encoding="utf-8",
            )
            docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
            for env in ({"BUILD_CACHE_UNTIL": "3d"}, {"IMAGE_MIN_AGE_DAYS": "0"}, {"APPLY": "1", "CONTAINER_MIN_AGE_DAYS": "nope"}):
                marker.unlink(missing_ok=True)
                completed = subprocess.run(
                    ["bash", str(SHELL)],
                    cwd=ROOT,
                    env={
                    **os.environ,
                    "DOCKER": str(docker),
                    "PATH": str(root) + os.pathsep + os.environ.get("PATH", ""),
                    **env,
                },
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertNotEqual(completed.returncode, 0, env)
                self.assertFalse(marker.exists(), env)
                self.assertNotIn(MARKER, completed.stdout)

    def test_dry_run_and_apply_use_the_fake_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = root / "fixture"
            fixture.mkdir()
            write_demo(fixture)
            state = root / "state"
            log = root / "docker-log"
            fake = root / "docker"
            fake.write_text(FAKE_DOCKER, encoding="utf-8")
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            base_env = {
                **os.environ,
                "DOCKER": str(fake),
                "PATH": str(root) + os.pathsep + os.environ.get("PATH", ""),
                "FIXTURE": str(fixture),
                "DOCKER_LOG": str(log),
                "DOCKER_STATE": str(state),
                "DOCKER_RECLAIM_NOW": NOW_TEXT,
                "EXPECT_UNTIL": "72h",
            }
            dry = subprocess.run(
                ["bash", str(SHELL)],
                cwd=ROOT,
                env={**base_env, "APPLY": "true"},
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertIn("mode=dry-run", dry.stdout)
            self.assertIn("skipped (dry-run; set APPLY=1 to prune)", dry.stdout)
            self.assertIn("BEFORE-TOTAL", dry.stdout)
            self.assertNotIn("AFTER-TOTAL", dry.stdout)
            self.assertNotIn(MARKER, dry.stdout)
            self.assertNotIn(MARKER, dry.stderr)
            dry_calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
            for call in dry_calls:
                self.assertNotIn("rm", call)
                self.assertNotIn("prune", call)
            inspect_calls = [call for call in dry_calls if call[:2] == ["image", "inspect"]]
            self.assertEqual(len(inspect_calls), 1)
            inspected = inspect_calls[0][4:]
            self.assertEqual(len(inspected), len(set(inspected)))
            self.assertEqual(inspected.count(IMG_NGINX), 1)
            self.assertFalse((state / "mutated").exists())

            log.unlink()
            applied = subprocess.run(
                ["bash", str(SHELL)],
                cwd=ROOT,
                env={**base_env, "APPLY": "1"},
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertIn("mode=apply", applied.stdout)
            self.assertIn("BEFORE-TOTAL", applied.stdout)
            self.assertIn("AFTER-TOTAL", applied.stdout)
            self.assertNotIn(MARKER, applied.stdout)
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
            removed_containers = {call[1] for call in calls if call[:1] == ["rm"]}
            removed_images = {call[2] for call in calls if call[:2] == ["image", "rm"]}
            removed_volumes = {call[2] for call in calls if call[:2] == ["volume", "rm"]}
            self.assertEqual(removed_containers, {C_PLAIN, C_DEAD})
            self.assertEqual(removed_images, {IMG_OLD, IMG_DANGLE, IMG_NGINX})
            self.assertEqual(removed_volumes, {VOL_ANON})
            self.assertIn(["builder", "prune", "-f", "--filter", "until=72h"], calls)
            self.assertLess(calls.index(["builder", "prune", "-f", "--filter", "until=72h"]), len(calls) - 1)
            self.assertEqual(calls[-1], ["system", "df"])
            df_verbose_calls = [
                call for call in calls if call[:2] == ["system", "df"] and "-v" in call
            ]
            self.assertGreaterEqual(len(df_verbose_calls), 2)

    def test_apply_continues_after_a_failed_removal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = root / "fixture"
            fixture.mkdir()
            write_demo(fixture)
            (fixture / "refuse-image-rm.txt").write_text(IMG_DANGLE + "\n", encoding="utf-8")
            state = root / "state"
            log = root / "docker-log"
            fake = root / "docker"
            fake.write_text(FAKE_DOCKER, encoding="utf-8")
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            completed = subprocess.run(
                ["bash", str(SHELL)],
                cwd=ROOT,
                env={
                    **os.environ,
                    "DOCKER": str(fake),
                    "PATH": str(root) + os.pathsep + os.environ.get("PATH", ""),
                    "FIXTURE": str(fixture),
                    "DOCKER_LOG": str(log),
                    "DOCKER_STATE": str(state),
                    "DOCKER_RECLAIM_NOW": NOW_TEXT,
                    "EXPECT_UNTIL": "72h",
                    "APPLY": "1",
                },
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("apply_failures count=1", completed.stderr)
            self.assertIn("AFTER-TOTAL", completed.stdout)
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
            removed_images = {call[2] for call in calls if call[:2] == ["image", "rm"]}
            self.assertEqual(removed_images, {IMG_OLD, IMG_DANGLE, IMG_NGINX})
            self.assertEqual(calls[-1], ["system", "df"])

    def test_apply_refuses_an_active_build(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = root / "fixture"
            fixture.mkdir()
            write_demo(fixture)
            (fixture / "build-active.txt").write_text("coolify-builder\n", encoding="utf-8")
            state = root / "state"
            log = root / "docker-log"
            fake = root / "docker"
            fake.write_text(FAKE_DOCKER, encoding="utf-8")
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            completed = subprocess.run(
                ["bash", str(SHELL)],
                cwd=ROOT,
                env={
                    **os.environ,
                    "DOCKER": str(fake),
                    "PATH": str(root) + os.pathsep + os.environ.get("PATH", ""),
                    "FIXTURE": str(fixture),
                    "DOCKER_LOG": str(log),
                    "DOCKER_STATE": str(state),
                    "DOCKER_RECLAIM_NOW": NOW_TEXT,
                    "APPLY": "1",
                },
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("refused to apply while a Coolify build or deploy is active", completed.stderr)
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
            for call in calls:
                self.assertNotIn("rm", call)
                self.assertNotIn("prune", call)

    def test_apply_does_not_prune_when_the_plan_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = root / "fixture"
            fixture.mkdir()
            write_demo(fixture)
            (fixture / "df-verbose.txt").write_text("not a docker table\n", encoding="utf-8")
            state = root / "state"
            log = root / "docker-log"
            fake = root / "docker"
            fake.write_text(FAKE_DOCKER, encoding="utf-8")
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            completed = subprocess.run(
                ["bash", str(SHELL)],
                cwd=ROOT,
                env={
                    **os.environ,
                    "DOCKER": str(fake),
                    "PATH": str(root) + os.pathsep + os.environ.get("PATH", ""),
                    "FIXTURE": str(fixture),
                    "DOCKER_LOG": str(log),
                    "DOCKER_STATE": str(state),
                    "DOCKER_RECLAIM_NOW": NOW_TEXT,
                    "APPLY": "1",
                },
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertNotIn(MARKER, completed.stdout)
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
            self.assertTrue(calls)
            for call in calls:
                self.assertNotIn("rm", call)
                self.assertNotIn("prune", call)
            self.assertFalse((state / "mutated").exists())


if __name__ == "__main__":
    unittest.main()
