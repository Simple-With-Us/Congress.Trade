import json
import os
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


REPORT_PY = Path(__file__).resolve().parents[1] / "root-disk-usage-report.py"


class RootDiskUsageReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="root-disk-usage-test-")
        self.root = Path(self.tmp.name) / "scan"
        self.root.mkdir()
        self.mock_bin = Path(self.tmp.name) / "mock-bin"
        self.mock_bin.mkdir()
        self.json_out = Path(self.tmp.name) / "report.json"
        self.md_out = Path(self.tmp.name) / "report.md"

        # Fixture tree
        (self.root / "data" / "heavy").mkdir(parents=True)
        (self.root / "var" / "log").mkdir(parents=True)
        heavy = self.root / "data" / "heavy" / "big.bin"
        heavy.write_bytes(b"x" * 2_000_000)
        small = self.root / "var" / "log" / "app.log"
        small.write_bytes(b"log\n")
        old = self.root / "data" / "old.dat"
        old.write_bytes(b"y" * 600_000)
        old_ts = time.time() - (40 * 86400)
        os.utime(old, (old_ts, old_ts))

        overlay_c1 = Path(self.tmp.name) / "docker" / "overlay" / "c1-upper"
        overlay_c1.mkdir(parents=True)
        (overlay_c1 / "layer.dat").write_bytes(b"z" * 800_000)
        vol_data = (
            Path(self.tmp.name) / "docker" / "volumes" / "mydata" / "_data"
        )
        vol_data.mkdir(parents=True)
        (vol_data / "vol.bin").write_bytes(b"v" * 400_000)

        self.env = os.environ.copy()
        self.env.update(
            {
                "PATH": f"{self.mock_bin}:{self.env.get('PATH', '')}",
                "FIXTURE_SCAN_ROOT": str(self.root),
                "FIXTURE_TMP": str(self.tmp.name),
            }
        )
        self._write_mock_df()
        self._write_mock_du()
        self._write_mock_find()
        self._write_mock_docker()
        self._write_pass_through()

    def tearDown(self):
        self.tmp.cleanup()

    def _write_pass_through(self):
        script = self.mock_bin / "pass-through"
        script.write_text(
            "#!/usr/bin/env bash\n"
            'cmd="$(basename "$0")"\n'
            'if [[ "$cmd" == "nice" ]]; then shift 2; fi\n'
            'if [[ "$cmd" == "ionice" ]]; then shift; fi\n'
            'exec "$@"\n'
        )
        script.chmod(stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        for name in ("nice", "ionice"):
            link = self.mock_bin / name
            if link.exists():
                link.unlink()
            link.symlink_to("pass-through")

    def _write_mock_df(self):
        script = self.mock_bin / "df"
        script.write_text(
            "#!/usr/bin/env bash\n"
            'set -euo pipefail\n'
            'mount="${@: -1}"\n'
            'printf "Filesystem 1024-blocks Used Available Use%% Mounted on\\n"\n'
            'printf "filesystem 102400 51200 46080 53%% %s\\n" "$mount"\n'
        )
        script.chmod(0o755)

    def _write_mock_du(self):
        script = self.mock_bin / "du"
        script.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            "depth=1\n"
            "sum_only=0\n"
            "paths=()\n"
            'while [[ $# -gt 0 ]]; do\n'
            '  case "$1" in\n'
            "    -x) shift ;;\n"
            "    -s) sum_only=1; shift ;;\n"
            "    -B1) shift ;;\n"
            "    --max-depth=*) depth=\"${1#*=}\"; shift ;;\n"
            "    *) paths+=(\"$1\"); shift ;;\n"
            "  esac\n"
            "done\n"
            'export DU_MAX_DEPTH="$depth"\n'
            "python3 - \"${paths[@]}\" <<'PY'\n"
            "import os, sys\n"
            "from pathlib import Path\n"
            "def dir_size(p):\n"
            "    total = 0\n"
            "    for root, _, files in os.walk(p, onerror=lambda e: None):\n"
            "        for f in files:\n"
            "            try:\n"
            "                total += Path(root, f).stat().st_size\n"
            "            except OSError:\n"
            "                pass\n"
            "    return total\n"
            "paths = sys.argv[1:]\n"
            "if len(paths) == 1 and '--' not in sys.argv:\n"
            "    p = paths[0]\n"
            "    if os.path.isdir(p):\n"
            "        max_depth = int(os.environ.get('DU_MAX_DEPTH', '2'))\n"
            "        base = Path(p)\n"
            "        for root, dirs, _ in os.walk(p, topdown=True):\n"
            "            rel = len(Path(root).relative_to(base).parts)\n"
            "            if rel > max_depth:\n"
            "                dirs[:] = []\n"
            "                continue\n"
            "            print(f\"{dir_size(root)}\\t{root}\")\n"
            "    sys.exit(0)\n"
            "for p in paths:\n"
            "    if os.path.isdir(p):\n"
            "        print(f\"{dir_size(p)}\\t{p}\")\n"
            "PY\n"
        )
        script.chmod(0o755)
        self.env["DU_MAX_DEPTH"] = "2"

    def _write_mock_find(self):
        script = self.mock_bin / "find"
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import os, sys, time\n"
            "from pathlib import Path\n"
            "argv = sys.argv[1:]\n"
            "root = argv[0]\n"
            "min_bytes = 0\n"
            "min_days = 0\n"
            "i = 1\n"
            "while i < len(argv):\n"
            "    if argv[i] == '-xdev':\n"
            "        i += 1\n"
            "    elif argv[i] == '-type' and argv[i+1] == 'f':\n"
            "        i += 2\n"
            "    elif argv[i] == '-size' and argv[i+1].endswith('c'):\n"
            "        min_bytes = int(argv[i+1][1:-1]) + 1\n"
            "        i += 2\n"
            "    elif argv[i] == '-mtime' and argv[i+1].startswith('+'):\n"
            "        min_days = int(argv[i+1][1:])\n"
            "        i += 2\n"
            "    elif argv[i] == '-printf':\n"
            "        break\n"
            "    else:\n"
            "        i += 1\n"
            "now = time.time()\n"
            "for dirpath, _, files in os.walk(root):\n"
            "    for name in files:\n"
            "        p = Path(dirpath) / name\n"
            "        try:\n"
            "            st = p.stat()\n"
            "        except OSError:\n"
            "            continue\n"
            "        if st.st_size < min_bytes:\n"
            "            continue\n"
            "        age_days = (now - st.st_mtime) / 86400\n"
            "        if min_days and age_days <= min_days:\n"
            "            continue\n"
            "        sys.stdout.write(f'{st.st_size}\\t{st.st_mtime:.6f}\\t{p}\\0')\n"
        )
        script.chmod(0o755)

    def _write_mock_docker(self):
        script = self.mock_bin / "docker"
        script.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            'tmp="${FIXTURE_TMP:?}"\n'
            'case "${1:-}" in\n'
            "  ps)\n"
            '    [[ "${2:-}" == "-aq" ]] && echo "c1"\n'
            "    ;;\n"
            "  volume)\n"
            '    case "${2:-}" in\n'
            '      ls) [[ "${3:-}" == "-q" ]] && echo "vol1" ;;\n'
            "      inspect)\n"
            '        fmt=""\n'
            "        shift 2\n"
            "        while [[ $# -gt 0 ]]; do\n"
            '          case "$1" in\n'
            '            -f) fmt="$2"; shift 2 ;;\n'
            "            *) shift ;;\n"
            "          esac\n"
            "        done\n"
            '        case "$fmt" in\n'
            "          *Name*) echo \"mydata\" ;;\n"
            '          *Mountpoint*) echo "${tmp}/docker/volumes/mydata/_data" ;;\n'
            "        esac\n"
            "        ;;\n"
            "    esac\n"
            "    ;;\n"
            "  inspect)\n"
            '    fmt=""\n'
            "    shift\n"
            "    while [[ $# -gt 0 ]]; do\n"
            '      case "$1" in\n'
            '        -f) fmt="$2"; shift 2 ;;\n'
            "        *) shift ;;\n"
            "      esac\n"
            "    done\n"
            '    case "$fmt" in\n'
            "      *Name*) echo \"/web\" ;;\n"
            '      *UpperDir*) echo "${tmp}/docker/overlay/c1-upper" ;;\n'
            '      *WorkDir*) echo "${tmp}/docker/overlay/c1-work" ;;\n'
            "    esac\n"
            "    ;;\n"
            "esac\n"
        )
        script.chmod(0o755)

    def _run_report(self, extra_args: list[str] | None = None) -> dict:
        args = [
            "python3",
            str(REPORT_PY),
            "--scan-root",
            str(self.root),
            "--dir-depth",
            "2",
            "--top-directories",
            "5",
            "--largest-files",
            "5",
            "--stale-min-bytes",
            "500000",
            "--stale-min-days",
            "30",
            "--stale-limit",
            "10",
            "--timeout-sec",
            "120",
            "--json-out",
            str(self.json_out),
            "--md-out",
            str(self.md_out),
            "--nice-cmd",
            "nice -n 19",
            "--ionice-cmd",
            "ionice -c3",
            "--du-cmd",
            "du",
            "--find-cmd",
            "find",
            "--df-cmd",
            "df",
            "--docker-cmd",
            "docker",
        ]
        if extra_args:
            args.extend(extra_args)
        proc = subprocess.run(
            args,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            proc.returncode,
            0,
            msg=proc.stderr or proc.stdout,
        )
        self.assertTrue(self.json_out.is_file())
        return json.loads(self.json_out.read_text(encoding="utf-8"))

    def test_report_json_and_docker_names(self):
        doc = self._run_report()
        self.assertEqual(doc["schema_version"], 1)
        self.assertEqual(doc["report_kind"], "root_disk_usage")
        self.assertFalse(doc["timed_out"])
        self.assertTrue(doc["filesystem"])
        self.assertGreaterEqual(len(doc["top_directories"]), 1)
        paths = {row["path"] for row in doc["largest_files"]}
        self.assertIn(str(self.root / "data" / "heavy" / "big.bin"), paths)
        stale_paths = {row["path"] for row in doc["stale_large_files"]}
        self.assertIn(str(self.root / "data" / "old.dat"), stale_paths)
        docker = doc["docker"]
        self.assertTrue(docker["available"])
        cnames = {row["name"] for row in docker["by_container"]}
        self.assertIn("web", cnames)
        vnames = {row["volume_name"] for row in docker["by_volume"]}
        self.assertIn("mydata", vnames)
        self.assertTrue(self.md_out.is_file())
        md = self.md_out.read_text(encoding="utf-8")
        self.assertIn("web", md)
        self.assertIn("mydata", md)

    def test_timeout_marks_partial(self):
        proc = subprocess.run(
            [
                "python3",
                "-c",
                (
                    "import time, runpy; "
                    f"mod = runpy.run_path({str(REPORT_PY)!r}); "
                    "r = mod['Runner'](); "
                    "r.deadline = time.monotonic() - 0.001; "
                    "r._check_deadline()"
                ),
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("TimeoutError", proc.stderr + proc.stdout)


if __name__ == "__main__":
    unittest.main()
