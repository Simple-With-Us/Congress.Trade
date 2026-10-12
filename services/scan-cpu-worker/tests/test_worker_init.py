"""Pins the fail-closed security boundary for ADMIN_TOKEN bootstrap."""
from __future__ import annotations

import inspect
import unittest
from unittest import mock

import worker


class InitAdminTokenTests(unittest.TestCase):
    def test_sets_admin_token_on_success(self) -> None:
        with mock.patch("worker.resolve_admin_token", return_value="abc"):
            worker.ADMIN_TOKEN = ""
            worker.init_admin_token()
            self.assertEqual(worker.ADMIN_TOKEN, "abc")

    def test_system_exit_on_resolution_failure(self) -> None:
        with mock.patch("worker.resolve_admin_token", side_effect=RuntimeError("missing")):
            with self.assertRaises(SystemExit):
                worker.init_admin_token()

    def test_system_exit_when_token_empty_after_resolution(self) -> None:
        with mock.patch("worker.resolve_admin_token", return_value=""):
            with self.assertRaises(SystemExit):
                worker.init_admin_token()

    def test_main_calls_init_admin_token_before_admin_io(self) -> None:
        src = inspect.getsource(worker.main)
        idx_init = src.find("init_admin_token()")
        idx_hb = src.find("send_heartbeat()")
        idx_pending = src.find("get_pending_scanned_filings()")
        self.assertGreater(idx_init, 0)
        self.assertGreater(idx_hb, idx_init)
        self.assertGreater(idx_pending, idx_init)


if __name__ == "__main__":
    unittest.main()
