#!/usr/bin/env python3
"""Offline tests for the Docker volume report. A fake docker binary, no daemon."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


OPS = Path(__file__).resolve().parents[1]
ROOT = OPS.parents[1]
sys.path.insert(0, str(OPS))

import docker_volume_report as report  # noqa: E402


SHELL = OPS / "docker-volume-report.sh"
PY = OPS / "docker_volume_report.py"
DOC = ROOT / "docs/rollouts/2026-11-12-docker-volume-report.md"
NOW = "2026-11-12T03:00:00Z"
SECRET = "label-value-do-not-print"
C_APP = "a" * 64
C_PLAIN = "b" * 64


def du_bytes(path: Path) -> int:
    out = subprocess.check_output(["/usr/bin/du", "-sB1", "--", str(path)], text=True)
    return int(out.split()[0])


def volume_table(rows: list[tuple[str, str, str]]) -> str:
    headers = ["VOLUME NAME", "LINKS", "SIZE"]
    rendered = [[name, links, size] for name, links, size in rows]
    widths = [len(header) for header in headers]
    for row in rendered:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    def format_row(cells: list[str]) -> str:
        parts: list[str] = []
        for index, cell in enumerate(cells):
            if index == len(cells) - 1:
                parts.append(cell)
            else:
                parts.append(cell.ljust(widths[index] + 3))
        return "".join(parts).rstrip()

    table = "\n".join([format_row(headers), *[format_row(row) for row in rendered]])
    return "Local Volumes space usage:\n\n" + table + "\n"


def container(
    full: str,
    name: str,
    status: str,
    labels: dict[str, str],
    mounts: list[dict[str, object]],
) -> dict[str, object]:
    return {"Id": full, "Name": name, "Status": status, "Labels": labels, "Mounts": mounts}


def volume_ls(name: str, labels: dict[str, str] | None = None, mountpoint: str = "") -> dict[str, object]:
    return {
        "Name": name,
        "Driver": "local",
        "Mountpoint": mountpoint,
        "Labels": labels or {},
    }


def write_snapshot(
    directory: Path,
    *,
    volumes: list[tuple[str, str, str]],
    volume_meta: list[dict[str, object]],
    containers: list[dict[str, object]],
    bind_sizes: dict[str, str] | None = None,
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "df-verbose.txt").write_text(volume_table(volumes), encoding="utf-8")
    lines = [json.dumps(row) for row in volume_meta]
    (directory / "volumes.jsonl").write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")
    ids = [str(row["Id"]) for row in containers]
    (directory / "container-ids.txt").write_text(("\n".join(ids) + "\n") if ids else "", encoding="utf-8")
    body = [json.dumps(row) for row in containers]
    (directory / "containers.jsonl").write_text(("\n".join(body) + "\n") if body else "", encoding="utf-8")
    if bind_sizes is None:
        return
    size_lines = [f"{size}\t{path}" if size.isdigit() else f"{size}\t{path}" for path, size in sorted(bind_sizes.items())]
    text = ("\n".join(size_lines) + "\n") if size_lines else ""
    (directory / "bind-sizes.txt").write_text(text, encoding="utf-8")


FAKE_DOCKER = "\n".join(
    [
        "#!/usr/bin/env python3",
        "import json, os, sys",
        "from pathlib import Path",
        "root = Path(os.environ['FIXTURE'])",
        "log = Path(os.environ['DOCKER_LOG'])",
        "args = sys.argv[1:]",
        "log.parent.mkdir(parents=True, exist_ok=True)",
        "with log.open('a', encoding='utf-8') as handle:",
        "    handle.write(json.dumps(args) + chr(10))",
        "def fail(message):",
        "    sys.stderr.write(message + chr(10))",
        "    sys.exit(3)",
        "banned = {'rm', 'prune', 'kill', 'exec', 'run', 'create', 'stop', 'rmi'}",
        "if any(part in banned for part in args):",
        "    fail('refused mutating argv')",
        "if args == ['system', 'df', '-v']:",
        "    sys.stdout.write((root / 'df-verbose.txt').read_text(encoding='utf-8'))",
        "    sys.exit(0)",
        "if args == ['volume', 'ls', '--format', '{{json .}}']:",
        "    sys.stdout.write((root / 'volumes.jsonl').read_text(encoding='utf-8'))",
        "    sys.exit(0)",
        "if args == ['ps', '-aq', '--no-trunc']:",
        "    sys.stdout.write((root / 'container-ids.txt').read_text(encoding='utf-8'))",
        "    sys.exit(0)",
        "if args[:2] == ['container', 'inspect']:",
        "    if len(args) < 4 or args[2] != '--format':",
        "        fail('inspect argv')",
        "    fmt = args[3]",
        "    if '.Env' in fmt or 'HostConfig' in fmt or '.Options' in fmt:",
        "        fail('inspect format is too wide')",
        "    if '.Mounts' not in fmt or '.Config.Labels' not in fmt or '.Name' not in fmt:",
        "        fail('inspect format is missing fields')",
        "    expected = [line.strip() for line in (root / 'container-ids.txt').read_text(encoding='utf-8').splitlines() if line.strip()]",
        "    if args[4:] != expected:",
        "        fail('inspect ids')",
        "    sys.stdout.write((root / 'containers.jsonl').read_text(encoding='utf-8'))",
        "    sys.exit(0)",
        "fail('unexpected argv ' + ' '.join(args))",
        "",
    ]
)

FAKE_DU = "\n".join(
    [
        "#!/usr/bin/env python3",
        "import json, os, sys",
        "from pathlib import Path",
        "log = Path(os.environ['DU_LOG'])",
        "log.parent.mkdir(parents=True, exist_ok=True)",
        "with log.open('a', encoding='utf-8') as handle:",
        "    handle.write(json.dumps(sys.argv[1:]) + chr(10))",
        "if '/' in sys.argv[1:]:",
        "    sys.stderr.write('refused du /' + chr(10))",
        "    sys.exit(9)",
        "os.execv('/usr/bin/du', ['/usr/bin/du', *sys.argv[1:]])",
        "",
    ]
)


def demo_rows(data: Path, shared: Path) -> tuple[list[tuple[str, str, str]], list[dict[str, object]], list[dict[str, object]]]:
    volumes = [
        ("congress-data", "1", "2GB"),
        ("shared-logs", "2", "5MB"),
        ("orphan-old", "0", "12MB"),
        ("named-orphan", "0", "50MB"),
    ]
    meta = [
        volume_ls("congress-data", mountpoint="/var/lib/docker/volumes/congress-data/_data"),
        volume_ls("shared-logs"),
        volume_ls("orphan-old"),
        volume_ls("named-orphan", {"coolify.resourceName": "old-service", "coolify.token": SECRET}),
    ]
    app_labels = {
        "coolify.resourceName": "congress-trade",
        "coolify.serviceName": "congress-app",
        "coolify.projectName": "fleet",
        "coolify.type": "application",
        "coolify.token": SECRET,
    }
    containers = [
        container(
            C_APP,
            "/congress-app",
            "running",
            app_labels,
            [
                {"Type": "volume", "Name": "congress-data", "Destination": "/data"},
                {"Type": "volume", "Name": "shared-logs", "Destination": "/logs"},
                {"Type": "bind", "Source": str(data), "Destination": "/host-data"},
                {"Type": "bind", "Source": str(shared), "Destination": "/host-shared"},
                {"Type": "tmpfs", "Name": "", "Source": "", "Destination": "/tmp"},
            ],
        ),
        container(
            C_PLAIN,
            "/plain-helper",
            "exited",
            {},
            [
                {"Type": "volume", "Name": "shared-logs", "Destination": "/logs"},
                {"Type": "bind", "Source": str(shared), "Destination": "/host-shared"},
            ],
        ),
    ]
    return volumes, meta, containers


class ReportTests(unittest.TestCase):
    def test_sizes_links_and_label_forms(self) -> None:
        self.assertEqual(report.parse_size("2GB"), 2_000_000_000)
        self.assertEqual(report.parse_size("12.4kB"), 12400)
        self.assertEqual(report.parse_size("1KiB"), 1024)
        self.assertIsNone(report.parse_size("N/A"))
        self.assertIsNone(report.parse_size("n/a"))
        with self.assertRaises(report.SnapshotError):
            report.parse_size("")
        with self.assertRaises(report.SnapshotError):
            report.parse_size("nope")
        self.assertIsNone(report.parse_links("N/A"))
        self.assertEqual(report.parse_links("2"), 2)
        mapped = report.labels_from("map[coolify.resourceName:congress-trade coolify.managed:true]")
        self.assertEqual(mapped["coolify.resourceName"], "congress-trade")
        paired = report.labels_from("coolify.serviceName=congress-app,coolify.managed=true")
        self.assertEqual(paired["coolify.serviceName"], "congress-app")

    def test_volume_size_na_stays_in_the_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            snap = Path(tmp)
            write_snapshot(
                snap,
                volumes=[("plugin-data", "0", "N/A"), ("kept", "0", "1MB")],
                volume_meta=[volume_ls("plugin-data"), volume_ls("kept")],
                containers=[],
                bind_sizes={},
            )
            previous = {
                "version": 1,
                "generated_at": NOW,
                "volumes": [
                    {"name": "plugin-data", "bytes": 10},
                    {"name": "kept", "bytes": 100},
                ],
                "bind_mounts": [],
            }
            previous_path = snap / "previous.json"
            previous_path.write_text(json.dumps(previous), encoding="utf-8")
            built = report.report_from_dir(snap, now=NOW, host="fixture", top=10, previous_path=previous_path)
        by_name = {row["name"]: row for row in built["volumes"]}
        self.assertIsNone(by_name["plugin-data"]["bytes"])
        self.assertTrue(by_name["plugin-data"]["orphan"])
        self.assertIn("docker volume rm", by_name["plugin-data"]["suggested_rm"])
        self.assertEqual(by_name["kept"]["bytes"], 1_000_000)
        self.assertEqual(built["totals"]["volume_bytes"], 1_000_000)
        self.assertEqual([row["name"] for row in built["top_growers"]], ["kept"])
        self.assertIn("| plugin-data | unknown |", report.render_markdown(built))

    def test_volume_missing_from_df_stays_in_the_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            snap = Path(tmp)
            write_snapshot(
                snap,
                volumes=[("kept", "0", "1MB")],
                volume_meta=[volume_ls("kept"), volume_ls("raced")],
                containers=[],
                bind_sizes={},
            )
            built = report.report_from_dir(snap, now=NOW, host="fixture", top=10, previous_path=None)
            write_snapshot(
                snap,
                volumes=[("kept", "0", "1MB"), ("df-only", "0", "2MB")],
                volume_meta=[volume_ls("kept")],
                containers=[],
                bind_sizes={},
            )
            with self.assertRaises(report.SnapshotError) as caught:
                report.report_from_dir(snap, now=NOW, host="fixture", top=10, previous_path=None)
        by_name = {row["name"]: row for row in built["volumes"]}
        self.assertIsNone(by_name["raced"]["bytes"])
        self.assertIsNone(by_name["raced"]["links"])
        self.assertTrue(by_name["raced"]["orphan"])
        self.assertEqual(built["totals"]["volume_bytes"], 1_000_000)
        self.assertIn("listed a volume ls did not", str(caught.exception))

    def test_compose_project_and_service_name_the_app(self) -> None:
        owner = report.owner_from_labels(
            {
                "com.docker.compose.project": "congress",
                "com.docker.compose.service": "worker",
            }
        )
        self.assertIsNotNone(owner)
        assert owner is not None
        self.assertEqual(owner.app, "congress/worker")
        coolify = report.owner_from_labels(
            {
                "coolify.resourceName": "congress-trade",
                "com.docker.compose.project": "congress",
                "com.docker.compose.service": "worker",
            }
        )
        assert coolify is not None
        self.assertEqual(coolify.app, "congress-trade")

    def test_nested_bind_total_counts_the_parent_once(self) -> None:
        sizes = {
            "/srv/app": (100, ""),
            "/srv/app/data": (40, ""),
            "/srv/database": (7, ""),
            "/srv/missing": (None, "error"),
        }
        self.assertEqual(report.bind_bytes_total(sizes), 107)
        self.assertFalse(report._is_bind_descendant("/srv/database", "/srv/data"))
        self.assertTrue(report._is_bind_descendant("/srv/app/data", "/srv/app"))

    def test_partial_du_line_is_marked_and_not_ranked(self) -> None:
        sizes = report.parse_bind_sizes("partial\t500\t/srv/app\n40\t/srv/db\n")
        self.assertEqual(sizes["/srv/app"], (500, "partial"))
        self.assertEqual(sizes["/srv/db"], (40, ""))
        self.assertEqual(report.bind_bytes_total(sizes), 540)

    def test_nested_binds_are_not_ranked_twice(self) -> None:
        sizes = {"/srv/app": (600, ""), "/srv/app/data": (200, ""), "/srv/db": (5, "partial")}
        self.assertEqual(report.bind_roots(sizes), ["/srv/app", "/srv/db"])

    def test_partial_previous_is_not_a_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = Path(tmp) / "prev.json"
            prev.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "volumes": [],
                        "bind_mounts": [
                            {"source": "/srv/app", "bytes": 10, "size_error": "partial"},
                            {"source": "/srv/db", "bytes": 10, "size_error": ""},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            sizes, _ = report.load_previous(prev)
        assert sizes is not None
        self.assertIsNone(sizes[("bind", "/srv/app")])
        self.assertEqual(sizes[("bind", "/srv/db")], 10)

    def test_mapping_orphans_and_growth(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "host-data"
            shared = root / "host-shared"
            data.mkdir()
            shared.mkdir()
            (data / "file").write_bytes(b"x" * 100)
            (shared / "file").write_bytes(b"y" * 50)
            data_bytes = du_bytes(data)
            shared_bytes = du_bytes(shared)
            volumes, meta, containers = demo_rows(data, shared)
            snap = root / "snap"
            write_snapshot(
                snap,
                volumes=volumes,
                volume_meta=meta,
                containers=containers,
                bind_sizes={str(data): str(data_bytes), str(shared): str(shared_bytes)},
            )
            loaded_volumes = report.load_volumes(snap)
            loaded_containers = report.load_containers(snap)
            loaded_binds = report.load_bind_sizes(snap, report.bind_source_list(loaded_containers))
            built = report.report_from_dir(snap, now=NOW, host="fixture", top=10, previous_path=None)
        text = json.dumps(built)
        self.assertNotIn(SECRET, text)
        self.assertTrue(built["read_only"])
        self.assertFalse(built["previous_present"])
        self.assertEqual(built["top_growers"], [])
        by_name = {row["name"]: row for row in built["volumes"]}
        self.assertEqual(by_name["congress-data"]["app"], "congress-trade")
        self.assertEqual(by_name["congress-data"]["service"], "congress-app")
        self.assertEqual(by_name["congress-data"]["project"], "fleet")
        self.assertEqual(by_name["congress-data"]["map_source"], "label")
        self.assertFalse(by_name["congress-data"]["orphan"])
        self.assertEqual(by_name["congress-data"]["bytes"], 2_000_000_000)
        self.assertEqual(by_name["shared-logs"]["map_source"], "mixed")
        self.assertEqual(by_name["shared-logs"]["apps"], ["congress-trade", "plain-helper"])
        self.assertFalse(by_name["shared-logs"]["orphan"])
        self.assertTrue(by_name["orphan-old"]["orphan"])
        self.assertEqual(by_name["orphan-old"]["map_source"], "unmapped")
        self.assertTrue(by_name["named-orphan"]["orphan"])
        self.assertEqual(by_name["named-orphan"]["app"], "old-service")
        self.assertEqual(
            report.orphan_commands(built),
            ["docker volume rm -- named-orphan", "docker volume rm -- orphan-old"],
        )
        binds = {row["source"]: row for row in built["bind_mounts"]}
        self.assertEqual(binds[str(data)]["app"], "congress-trade")
        self.assertEqual(binds[str(data)]["bytes"], data_bytes)
        self.assertEqual(len(binds[str(shared)]["containers"]), 2)
        self.assertEqual(set(binds), {str(data), str(shared)})
        markdown = report.render_markdown(built)
        self.assertIn("\u00a0 ", markdown)
        self.assertIn("This report deletes nothing.", markdown)
        self.assertIn("docker volume rm -- named-orphan", markdown)
        self.assertIn("docker volume rm -- orphan-old", markdown)
        self.assertNotIn("prune", markdown)
        self.assertNotIn("rm -rf", markdown)
        self.assertNotIn(SECRET, markdown)
        self.assertIn("No previous JSON was saved", markdown)

        previous = {
            ("volume", "congress-data"): 1_000_000_000,
            ("volume", "shared-logs"): 5_000_000,
            ("volume", "orphan-old"): 12_000_000,
            ("bind", str(data)): binds[str(data)]["bytes"],
        }
        grown = report.build_report(
            volumes=loaded_volumes,
            containers=loaded_containers,
            bind_sizes=loaded_binds,
            now=NOW,
            host="fixture",
            top=10,
            previous=previous,
            previous_generated_at=NOW,
        )
        growers = grown["top_growers"]
        self.assertEqual(growers[0]["name"], "congress-data")
        self.assertEqual(growers[0]["delta_bytes"], 1_000_000_000)
        names = [row["name"] for row in growers]
        self.assertIn("named-orphan", names)
        self.assertIn(str(shared), names)
        self.assertNotIn("shared-logs", names)
        self.assertNotIn("orphan-old", names)
        self.assertNotIn(str(data), names)

    def test_disagreement_and_unsafe_binds_do_not_suggest_removal(self) -> None:
        held = report.VolumeRec("congress-data", "local", "", {}, 0, 10)
        container = report.ContainerRec(
            C_APP,
            "congress-app",
            "running",
            {},
            [report.MountRec("volume", "congress-data", "", "/data")],
        )
        with self.assertRaises(report.SnapshotError):
            report.build_report(
                volumes=[held],
                containers=[container],
                bind_sizes={},
                now=NOW,
                host="fixture",
                top=10,
                previous=None,
                previous_generated_at=None,
            )
        with self.assertRaises(report.SnapshotError):
            report.normalize_bind_source("/")
        with self.assertRaises(report.SnapshotError):
            report.normalize_bind_source("/data/../etc")
        unknown = report.VolumeRec("loose", "local", "", {}, None, 4)
        built = report.build_report(
            volumes=[unknown],
            containers=[],
            bind_sizes={},
            now=NOW,
            host="fixture",
            top=10,
            previous=None,
            previous_generated_at=None,
        )
        self.assertTrue(built["volumes"][0]["orphan"])
        self.assertEqual(report.orphan_commands(built), ["docker volume rm -- loose"])
        quoted = report.suggested_rm("odd name")
        self.assertEqual(quoted, "docker volume rm -- 'odd name'")
        self.assertNotIn("prune", quoted)

    def test_previous_json_must_be_version_1(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "latest.json"
            path.write_text("{", encoding="utf-8")
            with self.assertRaises(report.SnapshotError):
                report.load_previous(path)
            path.write_text(json.dumps({"version": 2, "volumes": [], "bind_mounts": []}), encoding="utf-8")
            with self.assertRaises(report.SnapshotError):
                report.load_previous(path)

    def test_reporter_source_never_runs_docker(self) -> None:
        text = PY.read_text(encoding="utf-8")
        code = "\n".join(line.split("#", 1)[0] for line in text.splitlines())
        for forbidden in ("subprocess", "os.system", "os.popen", "Popen", "volume prune", "system prune"):
            self.assertNotIn(forbidden, code)
        self.assertIn("docker volume rm -- ", text)

    def test_doc_uses_sentence_gaps(self) -> None:
        data = DOC.read_bytes()
        self.assertGreater(data.count(b"\xc2\xa0 "), 5)


class ShellTests(unittest.TestCase):
    def test_script_never_invokes_removal(self) -> None:
        text = SHELL.read_text(encoding="utf-8")
        code = "\n".join(line.split("#", 1)[0] for line in text.splitlines())
        for forbidden in (
            "volume rm",
            "volume prune",
            "system prune",
            "builder prune",
            "image prune",
            ".Env",
            ".Options",
            "HostConfig",
        ):
            self.assertNotIn(forbidden, code)
        self.assertIn(".Mounts", text)
        self.assertIn("{{json .Config.Labels}}", text)
        self.assertIn('"$src" == "/"', text)

    def test_help_and_bad_config_do_not_call_docker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = root / "called"
            docker = root / "docker"
            docker.write_text("#!/bin/sh\ntouch " + str(marker) + "\nexit 99\n", encoding="utf-8")
            docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
            base = {**os.environ, "PATH": str(root) + os.pathsep + os.environ.get("PATH", "")}
            help_run = subprocess.run(
                ["bash", str(SHELL), "--help"],
                cwd=ROOT,
                env=base,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(help_run.returncode, 0, help_run.stderr)
            self.assertIn("Read-only", help_run.stdout)
            self.assertFalse(marker.exists())
            for env in (
                {"APPLY": "1"},
                {"PRUNE_VOLUMES": "1"},
                {"VOLUME_REPORT_TOP": "0"},
                {"VOLUME_REPORT_DIR": "relative"},
                {"VOLUME_REPORT_NOW": "yesterday"},
            ):
                marker.unlink(missing_ok=True)
                completed = subprocess.run(
                    ["bash", str(SHELL)],
                    cwd=ROOT,
                    env={**base, **env},
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertNotEqual(completed.returncode, 0, env)
                self.assertFalse(marker.exists(), env)
                self.assertNotIn(SECRET, completed.stdout)
                self.assertNotIn("docker volume rm", completed.stdout)

    def test_fake_docker_reports_sizes_growth_and_orphans(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "host-data"
            shared = root / "host-shared"
            data.mkdir()
            shared.mkdir()
            (data / "file").write_bytes(b"x" * 100)
            (shared / "file").write_bytes(b"y" * 50)
            fixture = root / "fixture"
            volumes, meta, containers = demo_rows(data, shared)
            write_snapshot(fixture, volumes=volumes, volume_meta=meta, containers=containers)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            docker = bin_dir / "docker"
            docker.write_text(FAKE_DOCKER, encoding="utf-8")
            docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
            du = bin_dir / "du"
            du.write_text(FAKE_DU, encoding="utf-8")
            du.chmod(du.stat().st_mode | stat.S_IEXEC)
            state = root / "state"
            log = root / "docker-log"
            du_log = root / "du-log"
            env = {
                **os.environ,
                "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
                "FIXTURE": str(fixture),
                "DOCKER_LOG": str(log),
                "DU_LOG": str(du_log),
                "VOLUME_REPORT_DIR": str(state),
                "VOLUME_REPORT_NOW": NOW,
                "VOLUME_REPORT_HOST": "fixture",
                "VOLUME_REPORT_TOP": "10",
            }
            first = subprocess.run(
                ["bash", str(SHELL)],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(
                first.stdout,
                "docker volume rm -- named-orphan\ndocker volume rm -- orphan-old\n",
            )
            self.assertNotIn(SECRET, first.stdout)
            self.assertNotIn(SECRET, first.stderr)
            self.assertNotIn("prune", first.stdout)
            payload = json.loads((state / "latest.json").read_text(encoding="utf-8"))
            markdown = (state / "latest.md").read_text(encoding="utf-8")
            self.assertNotIn(SECRET, json.dumps(payload))
            self.assertNotIn(SECRET, markdown)
            self.assertIn("\u00a0 ", markdown)
            self.assertFalse(payload["previous_present"])
            self.assertEqual(payload["top_growers"], [])
            self.assertEqual(payload["totals"]["orphans"], 2)
            binds = {row["source"]: row["bytes"] for row in payload["bind_mounts"]}
            self.assertEqual(binds[str(data)], du_bytes(data))
            self.assertEqual(binds[str(shared)], du_bytes(shared))
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(
                [call[:2] for call in calls],
                [["system", "df"], ["volume", "ls"], ["ps", "-aq"], ["container", "inspect"]],
            )
            for call in calls:
                self.assertFalse(any(part in {"rm", "prune", "kill", "exec"} for part in call))
            du_calls = [json.loads(line) for line in du_log.read_text(encoding="utf-8").splitlines()]
            sized = [call[-1] for call in du_calls]
            self.assertEqual(sorted(sized), sorted([str(data), str(shared)]))
            self.assertNotIn("/", sized)
            self.assertTrue(all("-sB1" in call and "--" in call for call in du_calls))

            log.unlink()
            du_log.unlink()
            for row in payload["volumes"]:
                if row["name"] == "congress-data":
                    row["bytes"] = 1_000_000_000
            (state / "latest.json").write_text(json.dumps(payload), encoding="utf-8")
            second = subprocess.run(
                ["bash", str(SHELL)],
                cwd=ROOT,
                env={**env, "VOLUME_REPORT_NOW": "2026-11-12T04:00:00Z"},
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(second.stdout, first.stdout)
            grown = json.loads((state / "latest.json").read_text(encoding="utf-8"))
            self.assertTrue(grown["previous_present"])
            self.assertEqual(grown["previous_generated_at"], NOW)
            self.assertEqual(grown["generated_at"], "2026-11-12T04:00:00Z")
            self.assertEqual(len(grown["top_growers"]), 1)
            self.assertEqual(grown["top_growers"][0]["name"], "congress-data")
            self.assertEqual(grown["top_growers"][0]["delta_bytes"], 1_000_000_000)
            grown_md = (state / "latest.md").read_text(encoding="utf-8")
            self.assertIn("congress-data", grown_md)
            self.assertNotIn("No previous JSON was saved", grown_md)

    def test_du_nonzero_keeps_a_printed_size(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            kept = root / "host-data"
            empty = root / "empty-case"
            kept.mkdir()
            empty.mkdir()
            (kept / "file").write_bytes(b"x")
            fixture = root / "fixture"
            write_snapshot(
                fixture,
                volumes=[],
                volume_meta=[],
                containers=[
                    container(
                        C_APP,
                        "/congress-app",
                        "running",
                        {"coolify.resourceName": "congress-trade"},
                        [
                            {"Type": "bind", "Source": str(kept), "Destination": "/data"},
                            {"Type": "bind", "Source": str(empty), "Destination": "/empty"},
                        ],
                    )
                ],
            )
            bin_dir = root / "bin"
            bin_dir.mkdir()
            docker = bin_dir / "docker"
            docker.write_text(FAKE_DOCKER, encoding="utf-8")
            docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
            du = bin_dir / "du"
            du.write_text(
                "\n".join(
                    [
                        "#!/usr/bin/env python3",
                        "import sys",
                        "path = sys.argv[-1]",
                        "if path.endswith('empty-case'):",
                        "    sys.exit(1)",
                        "sys.stdout.write('4096\\t' + path + '\\n')",
                        "sys.exit(1)",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            du.chmod(du.stat().st_mode | stat.S_IEXEC)
            env = {
                **os.environ,
                "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
                "FIXTURE": str(fixture),
                "DOCKER_LOG": str(root / "docker-log"),
                "DU_LOG": str(root / "du-log"),
                "VOLUME_REPORT_DIR": str(root / "state"),
                "VOLUME_REPORT_NOW": NOW,
                "VOLUME_REPORT_HOST": "fixture",
            }
            completed = subprocess.run(
                ["bash", str(SHELL)],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads((root / "state" / "latest.json").read_text(encoding="utf-8"))
        by_source = {row["source"]: row for row in payload["bind_mounts"]}
        self.assertEqual(by_source[str(kept)]["bytes"], 4096)
        self.assertEqual(by_source[str(kept)]["size_error"], "partial")
        self.assertIsNone(by_source[str(empty)]["bytes"])
        self.assertEqual(by_source[str(empty)]["size_error"], "error")
        self.assertEqual(payload["totals"]["bind_bytes"], 4096)

    def test_bad_snapshot_does_not_overwrite_or_print_rm(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "host-data"
            data.mkdir()
            (data / "file").write_bytes(b"x")
            fixture = root / "fixture"
            volumes = [("congress-data", "0", "1MB")]
            meta = [volume_ls("congress-data")]
            containers = [
                container(
                    C_APP,
                    "/congress-app",
                    "running",
                    {"coolify.token": SECRET},
                    [{"Type": "volume", "Name": "congress-data", "Destination": "/data"}],
                )
            ]
            write_snapshot(fixture, volumes=volumes, volume_meta=meta, containers=containers)
            self._refuse(root, fixture, "links disagreed")

            root_fixture = root / "root-bind"
            write_snapshot(
                root_fixture,
                volumes=[],
                volume_meta=[],
                containers=[
                    container(
                        C_APP,
                        "/congress-app",
                        "running",
                        {},
                        [{"Type": "bind", "Source": "/", "Destination": "/host"}],
                    )
                ],
            )
            du_log = root / "du-log"
            du_log.unlink(missing_ok=True)
            completed = self._run(root, root_fixture)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stdout, "")
            self.assertIn("refusing to size /", completed.stderr)
            self.assertFalse((root / "state" / "latest.json").exists())
            self.assertFalse(du_log.exists())

            good = root / "good"
            data2 = root / "other-data"
            data2.mkdir()
            (data2 / "file").write_bytes(b"z")
            shared = root / "other-shared"
            shared.mkdir()
            rows, meta, containers = demo_rows(data2, shared)
            write_snapshot(good, volumes=rows, volume_meta=meta, containers=containers)
            state = root / "state"
            state.mkdir(exist_ok=True)
            (state / "latest.json").write_text("{", encoding="utf-8")
            completed = self._run(root, good)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual((state / "latest.json").read_text(encoding="utf-8"), "{")
            self.assertEqual(completed.stdout, "")
            self.assertIn("previous JSON", completed.stderr)
            self.assertNotIn(SECRET, completed.stderr)

    def _refuse(self, root: Path, fixture: Path, message: str) -> None:
        completed = self._run(root, fixture)
        self.assertNotEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, "")
        self.assertIn(message, completed.stderr)
        self.assertNotIn(SECRET, completed.stdout + completed.stderr)
        self.assertFalse((root / "state" / "latest.json").exists())

    def _run(self, root: Path, fixture: Path) -> subprocess.CompletedProcess[str]:
        bin_dir = root / "bin"
        bin_dir.mkdir(exist_ok=True)
        docker = bin_dir / "docker"
        docker.write_text(FAKE_DOCKER, encoding="utf-8")
        docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
        du = bin_dir / "du"
        du.write_text(FAKE_DU, encoding="utf-8")
        du.chmod(du.stat().st_mode | stat.S_IEXEC)
        env = {
            **os.environ,
            "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
            "FIXTURE": str(fixture),
            "DOCKER_LOG": str(root / "docker-log"),
            "DU_LOG": str(root / "du-log"),
            "VOLUME_REPORT_DIR": str(root / "state"),
            "VOLUME_REPORT_NOW": NOW,
            "VOLUME_REPORT_HOST": "fixture",
        }
        return subprocess.run(
            ["bash", str(SHELL)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )


if __name__ == "__main__":
    unittest.main()
