from __future__ import annotations

import copy
import http.client
import importlib.util
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("sync-effort-issues.py")
SPEC = importlib.util.spec_from_file_location("sync_effort_issues", SCRIPT_PATH)
assert SPEC and SPEC.loader
sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync
SPEC.loader.exec_module(sync)


def marker(key: str) -> str:
    return f"body\n<!-- effort-key: {key} -->"


def issue(number: int, key: str, state: str = "open", labels: tuple[str, ...] = ()) -> dict:
    return {
        "number": number,
        "title": f"issue {number}",
        "body": marker(key),
        "state": state,
        "labels": [{"name": label} for label in labels],
    }


def current_issue(item: object, number: int) -> dict:
    bucket = item.bucket
    state = "open" if bucket in sync.OPEN_BUCKETS else "closed"
    row = issue(number, item.key, state, tuple(sync.desired_labels(bucket)))
    row["title"] = item.title
    row["body"] = sync.build_body(item, "o/r", "sha")
    return row


class FakeClient:
    def __init__(self, issues: list[dict] | None = None, fail_on_update: bool = False):
        self.issues = copy.deepcopy(issues or [])
        self.updates: list[tuple[int, dict]] = []
        self.fail_on_update = fail_on_update

    def list_all_issues(self) -> list[dict]:
        return self.issues

    def create_issue(self, title: str, body: str, labels: list[str], assignee: str | None) -> dict:
        created = issue(len(self.issues) + 100, sync.MARKER_RE.search(body).group(1), labels=tuple(labels))
        created["title"] = title
        created["body"] = body
        self.issues.append(created)
        return created

    def update_issue(self, number: int, fields: dict) -> None:
        if self.fail_on_update:
            raise sync.RateLimitBudgetExhausted("test budget exhausted")
        self.updates.append((number, copy.deepcopy(fields)))
        target = next(row for row in self.issues if row["number"] == number)
        target.update({key: value for key, value in fields.items() if key != "labels"})
        if "labels" in fields:
            target["labels"] = [{"name": label} for label in fields["labels"]]


class ParseBoardTests(unittest.TestCase):
    def test_bare_imperatives_are_rows_but_parenthesized_scaffolding_is_not(self) -> None:
        rows = sync.parse_board(
            "## Planned\n"
            "- Record the release receipt\n"
            "- See rollout notes for the follow-up\n"
            "- (record the effort here when claimed)\n"
            "- (see rollout notes after deployment)\n"
        )
        self.assertEqual([row.first_line for row in rows], [
            "Record the release receipt",
            "See rollout notes for the follow-up",
        ])


class OrphanReconciliationTests(unittest.TestCase):
    def test_open_orphan_closes_and_preserves_custom_labels(self) -> None:
        current = sync.BoardItem("planned", "Current row")
        orphan = issue(9, "a" * 40, labels=(sync.MIRROR_LABEL, "state:planned", "priority:p1"))
        client = FakeClient([current_issue(current, 1), orphan])
        stats = sync.reconcile([current], client, "o/r", "sha", None)
        update = next(fields for number, fields in client.updates if number == 9)
        self.assertEqual(update["state"], "closed")
        self.assertEqual(set(update["labels"]), {sync.MIRROR_LABEL, sync.ORPHANED_LABEL, "priority:p1"})
        self.assertEqual(stats["orphaned"], 1)

    def test_closed_completed_orphan_is_untouched(self) -> None:
        current = sync.BoardItem("planned", "Current row")
        orphan = issue(9, "b" * 40, "closed", (sync.MIRROR_LABEL, "state:completed"))
        client = FakeClient([current_issue(current, 1), orphan])
        sync.reconcile([current], client, "o/r", "sha", None)
        self.assertFalse(any(number == 9 for number, _ in client.updates))

    def test_closed_open_state_orphan_is_relabelled_only(self) -> None:
        current = sync.BoardItem("planned", "Current row")
        orphan = issue(9, "c" * 40, "closed", (sync.MIRROR_LABEL, "state:in-progress"))
        client = FakeClient([current_issue(current, 1), orphan])
        sync.reconcile([current], client, "o/r", "sha", None)
        update = next(fields for number, fields in client.updates if number == 9)
        self.assertNotIn("state", update)
        self.assertIn(sync.ORPHANED_LABEL, update["labels"])

    def test_zero_item_board_never_retires_orphans(self) -> None:
        client = FakeClient([issue(9, "d" * 40, labels=(sync.MIRROR_LABEL, "state:planned"))])
        stats = sync.reconcile([], client, "o/r", "sha", None)
        self.assertEqual(client.updates, [])
        self.assertEqual(stats["orphaned"], 0)

    def test_orphans_are_processed_in_issue_number_order(self) -> None:
        first = sync.BoardItem("planned", "Current row one")
        second = sync.BoardItem("planned", "Current row two")
        client = FakeClient([
            current_issue(first, 1),
            current_issue(second, 2),
            issue(20, "e" * 40, labels=(sync.MIRROR_LABEL, "state:planned")),
            issue(3, "f" * 40, labels=(sync.MIRROR_LABEL, "state:planned")),
        ])
        sync.reconcile([first, second], client, "o/r", "sha", None)
        orphan_numbers = [number for number, fields in client.updates if fields.get("state") == "closed"]
        self.assertEqual(orphan_numbers, [3, 20])

    def test_nonempty_truncated_board_skips_orphan_retirement(self) -> None:
        current = sync.BoardItem("planned", "Only surviving row")
        client = FakeClient([
            current_issue(current, 1),
            issue(2, "a" * 40, labels=(sync.MIRROR_LABEL, "state:planned")),
            issue(3, "b" * 40, labels=(sync.MIRROR_LABEL, "state:planned")),
        ])
        stats = sync.reconcile([current], client, "o/r", "sha", None)
        self.assertEqual(client.updates, [])
        self.assertEqual(stats["orphaned"], 0)

    def test_returned_key_reopens_and_restores_board_state(self) -> None:
        item = sync.BoardItem("in-progress", "Returned row")
        old = issue(4, item.key, "closed", (sync.MIRROR_LABEL, sync.ORPHANED_LABEL))
        client = FakeClient([old])
        stats = sync.reconcile([item], client, "o/r", "sha", None)
        fields = client.updates[0][1]
        self.assertEqual(fields["state"], "open")
        self.assertEqual(set(fields["labels"]), {sync.MIRROR_LABEL, "state:in-progress"})
        self.assertEqual(stats["reopened"], 1)

    def test_rate_limit_during_orphan_pass_returns_partial(self) -> None:
        orphan = issue(9, "f" * 40, labels=(sync.MIRROR_LABEL, "state:planned"))
        current = sync.BoardItem("planned", "Current row")
        existing_current = current_issue(current, 2)
        client = FakeClient([existing_current, orphan], fail_on_update=True)
        stats = sync.reconcile([current], client, "o/r", "sha", None)
        self.assertIn("test budget exhausted", stats["partial"])


class _FakeResponse:
    """Minimal stand-in for the urlopen context manager."""

    status = 200

    def __init__(self, body: bytes = b'{"ok": true}', headers: dict | None = None):
        self._body = body
        self.headers = headers or {}

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


class HttpTransportRetryTests(unittest.TestCase):
    """http_request must survive transport failures without replaying POSTs.

    A truncated body raises http.client.IncompleteRead out of resp.read()
    *after* a 200, so it never reaches the rate-limit retry in
    GitHubClient._request; before this retry existed, one mid-body disconnect
    while paging issues?state=all aborted the whole sync.
    """

    def setUp(self) -> None:
        self._real_urlopen = sync.urllib.request.urlopen
        self._real_sleep = sync.time.sleep
        self.calls = 0
        sync.time.sleep = lambda _seconds: None  # no real backoff waits under test
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        sync.urllib.request.urlopen = self._real_urlopen
        sync.time.sleep = self._real_sleep

    def _install(self, handler) -> None:
        def wrapped(req, timeout=None):
            self.calls += 1
            self.timeout = timeout
            return handler(self.calls)

        sync.urllib.request.urlopen = wrapped

    def test_get_retries_incomplete_read_then_succeeds(self) -> None:
        def handler(call: int):
            if call < 3:
                raise http.client.IncompleteRead(b"partial", 6207)
            return _FakeResponse()

        self._install(handler)
        status, payload, _headers = sync.http_request("GET", "https://api/x", "tok")
        self.assertEqual((status, payload), (200, {"ok": True}))
        self.assertEqual(self.calls, 3)

    def test_get_retries_are_bounded(self) -> None:
        def handler(_call: int):
            raise http.client.IncompleteRead(b"partial", 1)

        self._install(handler)
        with self.assertRaises(http.client.IncompleteRead):
            sync.http_request("GET", "https://api/x", "tok")
        self.assertEqual(self.calls, sync.TRANSPORT_RETRY_ATTEMPTS)

    def test_post_is_never_replayed(self) -> None:
        """A POST whose body was truncated may already have filed the issue."""

        def handler(_call: int):
            raise http.client.IncompleteRead(b"partial", 1)

        self._install(handler)
        with self.assertRaises(http.client.IncompleteRead):
            sync.http_request("POST", "https://api/x", "tok", {"title": "t"})
        self.assertEqual(self.calls, 1)
        self.assertNotIn("POST", sync.TRANSPORT_RETRY_METHODS)

    def test_get_retries_url_error(self) -> None:
        def handler(call: int):
            if call < 2:
                raise urllib.error.URLError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")
            return _FakeResponse()

        self._install(handler)
        status, _payload, _headers = sync.http_request("GET", "https://api/x", "tok")
        self.assertEqual(status, 200)
        self.assertEqual(self.calls, 2)

    def test_get_retries_truncated_json_body(self) -> None:
        def handler(call: int):
            if call < 2:
                return _FakeResponse(b'{"ok": tr')
            return _FakeResponse()

        self._install(handler)
        status, payload, _headers = sync.http_request("GET", "https://api/x", "tok")
        self.assertEqual((status, payload), (200, {"ok": True}))
        self.assertEqual(self.calls, 2)

    def test_http_error_still_reaches_the_rate_limit_handler(self) -> None:
        """HTTPError subclasses URLError; it must not be eaten as a transport failure."""

        body = json.dumps({"message": "You have exceeded a secondary rate limit"}).encode()

        def handler(_call: int):
            raise urllib.error.HTTPError(
                "https://api/x", 403, "rate limited", {"Retry-After": "1"}, io.BytesIO(body)
            )

        self._install(handler)
        status, payload, headers = sync.http_request("GET", "https://api/x", "tok")
        self.assertEqual(status, 403)
        self.assertEqual(self.calls, 1)
        self.assertTrue(sync._rate_limited(status, payload, dict(headers)))

    def test_urlopen_gets_a_timeout(self) -> None:
        self._install(lambda _call: _FakeResponse())
        sync.http_request("GET", "https://api/x", "tok")
        self.assertEqual(self.timeout, sync.HTTP_TIMEOUT_SECONDS)


if __name__ == "__main__":
    unittest.main()
