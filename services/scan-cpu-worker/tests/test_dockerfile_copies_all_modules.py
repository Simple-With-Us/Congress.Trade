"""Every local module the worker imports must be COPYed into the image.

Regression guard for the 2026-08-10 outage-adjacent defect: PR #1620 added
`form_chrome.py` and imported it from `pipeline.py`, but never added it to the
Dockerfile COPY list. The tests here all passed (they import from the source
tree, where the file exists), CI stayed green, and every image built from that
commit crash-looped on start:

    File "/app/pipeline.py", line 18, in <module>
      from form_chrome import is_form_chrome_asset
    ModuleNotFoundError: No module named 'form_chrome'

The OCR worker was dead for hours before anyone noticed, which showed up only
as degraded extraction rates.

This test compares what the modules import against what the Dockerfile ships,
so the same class of defect fails the build instead of production.
"""

from __future__ import annotations

import ast
import pathlib
import re

WORKER_DIR = pathlib.Path(__file__).resolve().parent.parent
DOCKERFILE = WORKER_DIR / "Dockerfile"


def _local_module_names() -> set[str]:
    """Python modules that live alongside the worker (importable by bare name)."""
    return {p.stem for p in WORKER_DIR.glob("*.py")}


def _copied_files() -> set[str]:
    """Filenames listed in Dockerfile COPY instructions."""
    copied: set[str] = set()
    for raw in DOCKERFILE.read_text().splitlines():
        line = raw.strip()
        if not re.match(r"^COPY\b", line, re.IGNORECASE):
            continue
        # Drop the COPY keyword and any --flags, then the destination operand.
        parts = [p for p in line.split()[1:] if not p.startswith("--")]
        if len(parts) >= 2:
            parts = parts[:-1]
        copied.update(parts)
    return copied


def _imported_local_modules() -> dict[str, set[str]]:
    """Map local module -> set of local modules it imports."""
    local = _local_module_names()
    graph: dict[str, set[str]] = {}
    for path in sorted(WORKER_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        found: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = alias.name.split(".")[0]
                    if root in local:
                        found.add(root)
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module:
                    root = node.module.split(".")[0]
                    if root in local:
                        found.add(root)
        graph[path.stem] = found
    return graph


def test_every_imported_local_module_is_copied_into_the_image() -> None:
    copied = _copied_files()
    graph = _imported_local_modules()

    missing: list[str] = []
    for module, imports in sorted(graph.items()):
        for dep in sorted(imports):
            if f"{dep}.py" not in copied:
                missing.append(f"{module}.py imports '{dep}' but {dep}.py is not COPYed")

    assert not missing, (
        "Dockerfile COPY list is missing modules that are imported at runtime. "
        "The image will crash on start with ModuleNotFoundError.\n  - "
        + "\n  - ".join(missing)
    )


def test_worker_entrypoint_is_copied() -> None:
    """The CMD target itself must ship."""
    copied = _copied_files()
    assert "worker.py" in copied, "worker.py (the CMD entrypoint) is not COPYed into the image"
