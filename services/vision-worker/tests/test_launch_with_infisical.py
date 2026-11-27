from __future__ import annotations

import io
import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

TESTS_DIR = pathlib.Path(__file__).resolve().parent
WORKER_DIR = TESTS_DIR.parent
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

import launch_with_infisical as lwi  # noqa: E402


class _FakeHTTPResponse(io.BytesIO):
    def __init__(self, payload: dict, status: int = 200) -> None:
        super().__init__(json.dumps(payload).encode("utf-8"))
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()


class CustodyTests(unittest.TestCase):
    def test_custody_accepts_0600_file_in_private_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tdir = pathlib.Path(tmp) / "tokens"
            tdir.mkdir(mode=0o700)
            tfile = tdir / "vision-worker-ct-ro.token"
            tfile.write_text("st.fake.value\n", encoding="utf-8")
            os.chmod(tfile, 0o600)
            self.assertEqual(lwi.read_custody_token_file(tfile), "st.fake.value")

    def test_custody_rejects_world_readable_token_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tdir = pathlib.Path(tmp) / "tokens"
            tdir.mkdir(mode=0o700)
            tfile = tdir / "vision-worker-ct-ro.token"
            tfile.write_text("st.fake.value\n", encoding="utf-8")
            os.chmod(tfile, 0o644)
            with self.assertRaises(lwi.LauncherError):
                lwi.read_custody_token_file(tfile)

    def test_custody_rejects_symlink_token_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tdir = pathlib.Path(tmp) / "tokens"
            tdir.mkdir(mode=0o700)
            real = tdir / "real.token"
            real.write_text("st.fake.value\n", encoding="utf-8")
            os.chmod(real, 0o600)
            link = tdir / "link.token"
            link.symlink_to(real)
            with self.assertRaises(lwi.LauncherError):
                lwi.read_custody_token_file(link)

    def test_resolve_prefers_keychain_then_falls_back_to_default_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            default_file = pathlib.Path(tmp) / "tokens" / "vision-worker-ct-ro.token"
            default_file.parent.mkdir(mode=0o700)
            default_file.write_text("st.file.token\n", encoding="utf-8")
            os.chmod(default_file, 0o600)

            with mock.patch.object(lwi, "read_keychain_token", return_value="st.keychain.token"):
                tok = lwi.resolve_service_token(env={}, default_token_file=default_file)
            self.assertEqual(tok, "st.keychain.token")

            with mock.patch.object(lwi, "read_keychain_token", return_value=None):
                tok = lwi.resolve_service_token(env={}, default_token_file=default_file)
            self.assertEqual(tok, "st.file.token")


class EnvAndInfisicalTests(unittest.TestCase):
    def test_build_child_env_strips_ambient_secrets_and_infisical_vars(self) -> None:
        base_env = {
            "PATH": "/usr/bin",
            "ADMIN_TOKEN": "stale-ambient-admin",
            "CT_ADMIN_TOKEN": "stale-ambient-ct",
            "OPENROUTER_API_KEY": "stale-openrouter",
            "INFISICAL_TOKEN": "stale-infisical",
            "INFISICAL_CLIENT_ID": "legacy-ua-id",
            lwi.TOKEN_FILE_ENV: "/tmp/some-path",
        }
        fetched = {
            "CT_ADMIN_TOKEN": "fresh-admin",
            "CT_OPENROUTER_API_KEY": "fresh-or",
            "PUSHOVER_APP_TOKEN": "fresh-push-app",
        }
        child = lwi.build_child_env(base_env, fetched)
        self.assertEqual(child["PATH"], "/usr/bin")
        self.assertEqual(child["ADMIN_TOKEN"], "fresh-admin")
        self.assertEqual(child["OPENROUTER_API_KEY"], "fresh-or")
        self.assertEqual(child["PUSHOVER_APP_TOKEN"], "fresh-push-app")
        self.assertNotIn("CT_ADMIN_TOKEN", child)
        self.assertNotIn("INFISICAL_TOKEN", child)
        self.assertNotIn("INFISICAL_CLIENT_ID", child)
        self.assertNotIn(lwi.TOKEN_FILE_ENV, child)
        self.assertNotIn("PUSHOVER_USER_KEY", child)

    def test_build_child_env_never_falls_back_to_ambient_admin_token(self) -> None:
        with self.assertRaises(lwi.LauncherError):
            lwi.build_child_env({"ADMIN_TOKEN": "ambient"}, {"OPENROUTER_API_KEY": "or"})

    def test_build_infisical_url_rejects_non_prod_and_non_pinned_host(self) -> None:
        url = lwi.build_infisical_url()
        self.assertIn("environment=prod", url)
        self.assertIn("include_imports=true", url)
        self.assertIn("expandSecretReferences=true", url)
        with self.assertRaises(lwi.LauncherError):
            lwi.build_infisical_url(environment="dev")
        with self.assertRaises(lwi.LauncherError):
            lwi.build_infisical_url(base_url="https://evil.example/api/v3/secrets/raw")

    def test_fetch_infisical_secrets_maps_entries(self) -> None:
        fake_payload = {
            "secrets": [
                {"secretKey": "ADMIN_TOKEN", "secretValue": "adm-123"},
                {"secretKey": "OPENROUTER_API_KEY", "secretValue": "or-456"},
            ]
        }

        class FakeOpener:
            def open(self, req, timeout=0):
                self.req = req
                self.timeout = timeout
                return _FakeHTTPResponse(fake_payload)

        opener = FakeOpener()
        got = lwi.fetch_infisical_secrets("tok-xyz", opener=opener)
        self.assertEqual(got, {"ADMIN_TOKEN": "adm-123", "OPENROUTER_API_KEY": "or-456"})
        self.assertEqual(opener.req.headers.get("Authorization"), "Bearer tok-xyz")

    def test_no_redirect_handler_refuses_3xx(self) -> None:
        handler = lwi._NoRedirectHandler()
        req = lwi.urllib.request.Request(lwi.INFISICAL_RAW_URL)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            handler.redirect_request(req, None, 302, "Found", {}, "https://evil.example/")
        self.assertEqual(ctx.exception.code, 302)

    def test_main_refuses_non_prod_infisical_environment_without_exec(self) -> None:
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {"INFISICAL_ENVIRONMENT": "staging"}, clear=False):
            with mock.patch("sys.stderr", stderr):
                rc = lwi.main(["worker.py"])
        self.assertEqual(rc, 2)
        self.assertIn("prod", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
