"""Tests for Infisical-backed ADMIN_TOKEN resolution."""
from __future__ import annotations

import os
import unittest
from unittest import mock

from infisical_config import _bootstrap_credentials, fetch_secret_from_infisical, resolve_admin_token


class InfisicalConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self._env = os.environ.copy()

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env)

    def test_bootstrap_credentials_prefers_app_client_secret(self) -> None:
        os.environ["INFISICAL_APP_CLIENT_ID"] = "app-id"
        os.environ["INFISICAL_CLIENT_ID"] = "legacy-id"
        os.environ["INFISICAL_APP_CLIENT_SECRET"] = "app-secret"
        os.environ["INFISICAL_CLIENT_SECRET"] = "legacy-secret"
        os.environ["INFISICAL_APP_PROJECT_ID"] = "proj"
        cid, csec, proj = _bootstrap_credentials()
        self.assertEqual(cid, "app-id")
        self.assertEqual(csec, "app-secret")
        self.assertEqual(proj, "proj")

    def test_resolve_admin_token_prefers_env(self) -> None:
        os.environ["ADMIN_TOKEN"] = "from-env-token"
        self.assertEqual(resolve_admin_token(), "from-env-token")

    @mock.patch("infisical_config._http_json")
    def test_fetch_secret_from_infisical_universal_auth(self, http_json: mock.Mock) -> None:
        os.environ.pop("ADMIN_TOKEN", None)
        os.environ["INFISICAL_APP_CLIENT_ID"] = "cid"
        os.environ["INFISICAL_APP_CLIENT_SECRET"] = "csecret"
        os.environ["INFISICAL_APP_PROJECT_ID"] = "proj-123"
        os.environ["INFISICAL_ENV"] = "prod"

        http_json.side_effect = [
            {"accessToken": "login-token"},
            {
                "secrets": [
                    {"secretKey": "OTHER", "secretValue": "x"},
                    {"secretKey": "ADMIN_TOKEN", "secretValue": "infisical-admin"},
                ]
            },
        ]

        token = fetch_secret_from_infisical("ADMIN_TOKEN")
        self.assertEqual(token, "infisical-admin")

        login_call = http_json.call_args_list[0]
        self.assertIn("/api/v1/auth/universal-auth/login", login_call[0][0])
        self.assertEqual(
            login_call[1]["body"],
            {"clientId": "cid", "clientSecret": "csecret"},
        )

        secrets_call = http_json.call_args_list[1]
        self.assertIn("/api/v3/secrets/raw", secrets_call[0][0])
        self.assertIn("workspaceId=proj-123", secrets_call[0][0])
        self.assertEqual(
            secrets_call[1]["headers"],
            {"Authorization": "Bearer login-token"},
        )

    @mock.patch("infisical_config.fetch_secret_from_infisical")
    def test_resolve_admin_token_fetches_when_env_missing(self, fetch: mock.Mock) -> None:
        os.environ.pop("ADMIN_TOKEN", None)
        fetch.return_value = "from-infisical"
        self.assertEqual(resolve_admin_token(), "from-infisical")
        fetch.assert_called_once_with("ADMIN_TOKEN")

    @mock.patch("infisical_config._http_json")
    def test_fetch_secret_missing_raises(self, http_json: mock.Mock) -> None:
        os.environ["INFISICAL_APP_CLIENT_ID"] = "cid"
        os.environ["INFISICAL_APP_CLIENT_SECRET"] = "csecret"
        os.environ["INFISICAL_APP_PROJECT_ID"] = "proj"
        http_json.side_effect = [
            {"accessToken": "t"},
            {"secrets": [{"secretKey": "OTHER", "secretValue": "y"}]},
        ]
        with self.assertRaises(RuntimeError) as ctx:
            fetch_secret_from_infisical("ADMIN_TOKEN")
        self.assertIn("ADMIN_TOKEN", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
