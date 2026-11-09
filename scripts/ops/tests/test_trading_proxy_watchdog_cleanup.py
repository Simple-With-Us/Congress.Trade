import os
import signal
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "trading-proxy-watchdog" / "public-liveness-watch.sh"


class WatchdogAuthConfigCleanupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="watchdog-cleanup-test-")
        self.processes = []
        self.root = Path(self.tmp.name)
        self.ops = self.root / "ops"
        self.script_dir = self.ops / "trading-proxy-watchdog"
        self.bin_dir = self.root / "bin"
        self.state_dir = self.ops / "state"
        self.marker_dir = self.root / "markers"
        self.script_dir.mkdir(parents=True)
        self.bin_dir.mkdir()
        self.marker_dir.mkdir()
        (self.script_dir / "public-liveness-watch.sh").write_bytes(SCRIPT.read_bytes())
        token_file = self.root / "dummy-token"
        token_file.write_text("dummy-only-test-value\n")
        token_file.chmod(0o600)
        (self.ops / "watchdog.env").write_text(
            "COOLIFY_API=http://coolify.invalid/api/v1\n"
            "COOLIFY_APP_UUID=dummy-app\n"
            f"COOLIFY_TOKEN_FILE={token_file}\n"
            "PUBLIC_LIVENESS_HOST=socratictrade.invalid\n"
            "PUBLIC_FAIL_THRESHOLD=1\n"
            "RESTART_COOLDOWN_S=0\n"
        )
        (self.state_dir).mkdir()
        (self.state_dir / "public-liveness.state").write_text(
            "consecutive_failures=0\n"
            "consecutive_dest_transport_failures=0\n"
            "consecutive_proxy_failures=0\n"
            "last_restart_epoch=0\n"
        )
        curl = self.bin_dir / "curl"
        curl.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, signal, sys, time\n"
            "args = sys.argv[1:]\n"
            "markers = pathlib.Path(os.environ['FAKE_MARKERS'])\n"
            "if '-K' in args:\n"
            "    cfg = args[args.index('-K') + 1]\n"
            "    (markers / 'restart-config-path').write_text(cfg)\n"
            "    (markers / 'restart-entered').touch()\n"
            "    if os.environ.get('FAKE_RESTART_BLOCK') == '1':\n"
            "        while True: time.sleep(1)\n"
            "    print('dummy curl failure', file=sys.stderr)\n"
            "    sys.exit(22)\n"
            "url = next((arg for arg in reversed(args) if arg.startswith(('http://', 'https://'))), '')\n"
            "if url.endswith('/api/live'):\n"
            "    code, body = '503', b'dummy unavailable'\n"
            "elif url.endswith('/api/proxy-use'):\n"
            "    code, body = '404', b''\n"
            "elif url.endswith('/api/v1/'):\n"
            "    code, body = '200', b''\n"
            "    with (markers / 'exit-proxy-check').open('a') as event:\n"
            "        event.write('checked\\n')\n"
            "elif 'example.com' in url:\n"
            "    code, body = '200', b''\n"
            "else:\n"
            "    code, body = '200', b''\n"
            "if '-o' in args:\n"
            "    output = args[args.index('-o') + 1]\n"
            "    if output != '/dev/null': pathlib.Path(output).write_bytes(body)\n"
            "if '-w' in args: print(code)\n"
        )
        curl.chmod(0o755)
        self.env = os.environ.copy()
        self.env.update(
            {
                "PATH": f"{self.bin_dir}:{self.env['PATH']}",
                "FAKE_MARKERS": str(self.marker_dir),
                "HTTPS_PROXY": "http://proxy.invalid:8080",
                "PUBLIC_LIVENESS_WATCH": "1",
            }
        )

    def tearDown(self):
        for proc in self.processes:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if proc.poll() is None:
                try:
                    proc.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
        self.tmp.cleanup()

    def run_watchdog(self, **env):
        test_env = self.env | env
        return subprocess.run(
            ["/bin/bash", str(self.script_dir / "public-liveness-watch.sh")],
            cwd=self.root,
            env=test_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
        )

    def start_watchdog(self, script=None, env=None):
        proc = subprocess.Popen(
            ["/bin/bash", str(script or (self.script_dir / "public-liveness-watch.sh"))],
            cwd=self.root,
            env=env or self.env,
            start_new_session=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.processes.append(proc)
        return proc

    def wait_for_restart(self, proc):
        marker = self.marker_dir / "restart-entered"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if marker.exists():
                cfg = Path((self.marker_dir / "restart-config-path").read_text())
                self.assertTrue(cfg.exists())
                self.assertEqual(stat.S_IMODE(cfg.stat().st_mode), 0o600)
                return cfg
            if proc.poll() is not None:
                self.fail(f"watchdog exited before restart request: {proc.returncode}")
            time.sleep(0.02)
        self.fail("watchdog did not reach the restart request")

    def assert_exit_proxy_check_once(self):
        events = self.marker_dir / "exit-proxy-check"
        self.assertTrue(events.exists())
        self.assertEqual(events.read_text().splitlines(), ["checked"])

    def test_normal_restart_failure_removes_config_and_runs_exit_check(self):
        result = self.run_watchdog()
        self.assertEqual(result.returncode, 0, result.stderr)
        cfg = Path((self.marker_dir / "restart-config-path").read_text())
        self.assertFalse(cfg.exists())
        self.assert_exit_proxy_check_once()

    def test_term_removes_config_preserves_status_and_runs_exit_check(self):
        env = self.env | {"FAKE_RESTART_BLOCK": "1"}
        proc = self.start_watchdog(env=env)
        cfg = self.wait_for_restart(proc)
        os.killpg(proc.pid, signal.SIGTERM)
        _, stderr = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 143, stderr)
        self.assertFalse(cfg.exists())
        self.assert_exit_proxy_check_once()

    def test_int_removes_config_and_preserves_signal_status(self):
        env = self.env | {"FAKE_RESTART_BLOCK": "1"}
        proc = self.start_watchdog(env=env)
        cfg = self.wait_for_restart(proc)
        os.killpg(proc.pid, signal.SIGINT)
        _, stderr = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 130, stderr)
        self.assertFalse(cfg.exists())
        self.assert_exit_proxy_check_once()

    def test_hup_removes_config_and_preserves_signal_status(self):
        env = self.env | {"FAKE_RESTART_BLOCK": "1"}
        proc = self.start_watchdog(env=env)
        cfg = self.wait_for_restart(proc)
        os.killpg(proc.pid, signal.SIGHUP)
        _, stderr = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 129, stderr)
        self.assertFalse(cfg.exists())
        self.assert_exit_proxy_check_once()

    def test_signal_status_survives_failure_in_exit_check(self):
        script = self.script_dir / "failing-exit-check.sh"
        source = (self.script_dir / "public-liveness-watch.sh").read_text()
        source = source.replace(
            "trap watchdog_exit EXIT",
            'check_trading_proxy_path() { printf "called\\n" >> "$FAKE_MARKERS/failed-exit-check"; return 37; }\n'
            "trap watchdog_exit EXIT",
            1,
        )
        script.write_text(source)
        env = self.env | {"FAKE_RESTART_BLOCK": "1"}
        proc = self.start_watchdog(script=script, env=env)
        cfg = self.wait_for_restart(proc)
        os.killpg(proc.pid, signal.SIGTERM)
        _, stderr = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 143, stderr)
        self.assertFalse(cfg.exists())
        self.assertEqual((self.marker_dir / "failed-exit-check").read_text().splitlines(), ["called"])


if __name__ == "__main__":
    unittest.main()
