"""Shared Docker byte-unit grammar for the host reports.

Both reports read `docker system df -v`. A size such as 12.4kB has to mean
the same number of bytes in each one. N/A is not a size. Each report decides
what an unknown size means.
"""

from __future__ import annotations

import re


class SizeError(ValueError):
    """A Docker size token is empty or not a byte unit."""


SIZE_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)?)([KMGT]I?B|B)$", re.IGNORECASE)
SIZE_SCALE = {
    "B": 1,
    "KB": 1000,
    "MB": 1000**2,
    "GB": 1000**3,
    "TB": 1000**4,
    "KIB": 1024,
    "MIB": 1024**2,
    "GIB": 1024**3,
    "TIB": 1024**4,
}


def parse_size(text: str) -> int:
    raw = text.strip().replace(" ", "")
    if not raw:
        raise SizeError("empty size")
    match = SIZE_RE.match(raw)
    if not match:
        raise SizeError("unparsed size")
    number = float(match.group(1))
    unit = match.group(2).upper()
    return int(round(number * SIZE_SCALE[unit]))
