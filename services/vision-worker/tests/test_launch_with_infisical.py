from __future__ import annotations

import io
import json
import os
import pathlib
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


class ArgParsingTests(unittest.TestCase):
    def test_parse_args_finds_token_file_and_check_after_worker_path(self) -> None:
        token_file, check_only, cmd = lwi.parse_args(
            ["/path/worker.py", "--token-file", "/tmp/tok", "--check"]
        )
        self.assertEqual(token_file, "/tmp/tok")
        self.assertTrue(check_only)
        self.assertEqual(cmd, ["/path/worker.py"])

    def test_parse_args_supports_equals_form(self) -> None:
        token_file, check_only, cmd = lwi.parse_args(
            ["/path/worker.py", "--token-file=/tmp/tok"]
        )
        self.assertEqual(token_file, "/tmp/tok")
        self.assertFalse(check_only)
        self.assertEqual(cmd, ["/path/worker.py"])

    def test_parse_args_rejects_missing_token_file_value(self) -> None:
        with self.assertRaises(lwi.LauncherError):
            lwi.parse_args(["/path/worker.py", "--token-file"])


class EnvAndInfisicalTests(unittest.TestCase):
    def test_build_child_env_strips_ambient_secrets_and_infisical_vars(self) -> None:
        base_env = {
            "PATH": "/opt/homebrew/bin:/usr/bin",
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
        self.assertEqual(child["PATH"], "/opt/homebrew/bin:/usr/bin")
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

    def test_build_child_env_requires_openrouter_key_when_engine_is_openrouter(self) -> None:
        with self.assertRaises(lwi.LauncherError):
            lwi.build_child_env({"VISION_ENGINE": "openrouter"}, {"ADMIN_TOKEN": "fresh-admin"})

    def test_build_infisical_url_rejects_non_prod_and_non_pinned_host(self) -> None:
        url = lwi.build_infisical_url(project_id="proj-123")
        self.assertIn("workspaceId=proj-123", url)
        self.assertIn("environment=prod", url)
        self.assertIn("include_imports=true", url)
        self.assertIn("expandSecretReferences=true", url)
        with self.assertRaises(lwi.LauncherError):
            lwi.build_infisical_url(project_id="proj-123", environment="dev")
        with self.assertRaises(lwi.LauncherError):
            lwi.build_infisical_url(
                project_id="proj-123", base_url="https://evil.example/api/v3/secrets/raw"
            )

    def test_fetch_infisical_secrets_discovers_project_and_maps_entries(self) -> None:
        class FakeOpener:
            def __init__(self) -> None:
                self.urls: list[str] = []

            def open(self, req, timeout=0):
                self.urls.append(req.full_url)
                if req.full_url == lwi.INFISICAL_SERVICE_TOKEN_URL:
                    return _FakeHTTPResponse(
                        {
                            "workspace": "proj-from-token",
                            "scopes": [{"environment": "prod", "secretPath": "/"}],
                        }
                    )
                return _FakeHTTPResponse(
                    {
                        "secrets": [
                            {"secretKey": "ADMIN_TOKEN", "secretValue": "adm-123"},
                            {"secretKey": "OPENROUTER_API_KEY", "secretValue": "or-456"},
                        ]
                    }
                )

        opener = FakeOpener()
        got = lwi.fetch_infisical_secrets("tok-xyz", opener=opener)
        self.assertEqual(got, {"ADMIN_TOKEN": "adm-123", "OPENROUTER_API_KEY": "or-456"})
        self.assertEqual(len(opener.urls), 2)
        self.assertIn("workspaceId=proj-from-token", opener.urls[1])

    def test_discover_rejects_token_not_scoped_to_prod(self) -> None:
        class FakeOpener:
            def open(self, req, timeout=0):
                return _FakeHTTPResponse(
                    {"workspace": "proj-1", "scopes": [{"environment": "staging", "secretPath": "/"}]}
                )

        with self.assertRaises(lwi.LauncherError):
            lwi.discover_service_token_project("tok-xyz", opener=FakeOpener())

    def test_no_redirect_handler_refuses_3xx(self) -> None:
        handler = lwi._NoRedirectHandler()
        req = lwi.urllib.request.Request(lwi.INFISICAL_RAW_URL)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            handler.redirect_request(req, None, 302, "Found", {}, "https://evil.example/")
        self.assertEqual(ctx.exception.code, 302)

    def test_main_check_mode_reports_key_names_without_values(self) -> None:
        stdout = io.StringIO()
        with (
            mock.patch.object(lwi, "resolve_service_token", return_value="tok-xyz"),
            mock.patch.object(
                lwi,
                "fetch_infisical_secrets",
                return_value={"ADMIN_TOKEN": "secret-admin-value"},
            ),
            mock.patch("sys.stdout", stdout),
        ):
            rc = lwi.main(["worker.py", "--check"])
        self.assertEqual(rc, 0)
        self.assertIn("ADMIN_TOKEN", stdout.getvalue())
        self.assertNotIn("secret-admin-value", stdout.getvalue())

    def test_main_refuses_non_prod_infisical_environment_without_exec(self) -> None:
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {"INFISICAL_ENVIRONMENT": "staging"}, clear=False):
            with mock.patch("sys.stderr", stderr):
                rc = lwi.main(["worker.py"])
        self.assertEqual(rc, 2)
        self.assertIn("prod", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
