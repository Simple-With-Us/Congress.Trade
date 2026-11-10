#!/usr/bin/env python3
"""Assert the GitHub-delay monitors (CI backstop, Effort Issues Sync) use the 600-minute margin.

Run: python3 scripts/sentry-ci-report-margins_test.py
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

SCRIPT = Path(__file__).with_name("sentry-ci-report.py")


def _assign_value(tree: ast.AST, name: str):
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if name in targets:
                return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in {SCRIPT.name}")


def main() -> int:
    tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
    default = _assign_value(tree, "DEFAULT_CHECKIN_MARGIN")
    overrides = _assign_value(tree, "CHECKIN_MARGIN_OVERRIDES")
    schedules = _assign_value(tree, "CRON_SCHEDULES")

    assert default == 15, default
    assert overrides == {"CI": 600, "Effort Issues Sync": 600}, overrides
    assert schedules.get("Effort Issues Sync") == "12 6 * * *", schedules
    # ci.yml's hourly backstop; the reporter raises an unmapped-schedule drift event
    # (FLEET-INFRA-BJ) on every scheduled CI run when this key is missing.
    assert schedules.get("CI") == "23 * * * *", schedules
    print("MARGIN_PARSE_OK", overrides)
    print("EFFORT_SYNC_CRON_OK", schedules["Effort Issues Sync"])
    print("CI_CRON_OK", schedules["CI"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
