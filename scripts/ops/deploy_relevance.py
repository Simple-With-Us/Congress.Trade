#!/usr/bin/env python3
"""Decide whether a file list should rebuild the Coolify congress-trade origin.

Exit codes:
  0  at least one path matches the Coolify watch_paths (deploy)
  1  no matching path (skip)
  2  usage / parse error (callers must fail closed and deploy)

Matching copies Coolify's Application::globMatch / globToRegex:
  **  any directories
  *   any run of non-slash characters
Leading slashes are stripped, same as parseWatchPaths.
"""

from __future__ import annotations

import argparse
import re
import sys

DEFAULT_WATCH_PATHS = ("app/**", "services/**")


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    regex: list[str] = []
    chars = list(pattern)
    i = 0
    while i < len(chars):
        c = chars[i]
        if c == "*":
            if i + 1 < len(chars) and chars[i + 1] == "*":
                regex.append(".*")
                i += 1
                if i + 1 < len(chars) and chars[i + 1] == "/":
                    i += 1
            else:
                regex.append("[^/]*")
        elif c == "?":
            regex.append("[^/]")
        elif c in ".+^${}()|\\":
            regex.append("\\" + c)
        else:
            regex.append(c)
        i += 1
    return re.compile("^" + "".join(regex) + "$")


def normalize_path(path: str) -> str:
    return path.strip().lstrip("/")


def parse_watch_paths(raw: str) -> list[str]:
    out: list[str] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("!"):
            out.append("!" + normalize_path(line[1:]))
        else:
            out.append(normalize_path(line))
    return out


def path_matches(path: str, watch_paths: list[str]) -> bool:
    should_include: bool | None = None
    file_path = normalize_path(path)
    if not file_path:
        return False
    for pattern in watch_paths:
        is_exclusion = pattern.startswith("!")
        match_pattern = pattern[1:] if is_exclusion else pattern
        if glob_to_regex(match_pattern).match(file_path):
            should_include = not is_exclusion
    return bool(should_include)


def matching_files(files: list[str], watch_paths: list[str]) -> list[str]:
    return [f for f in files if path_matches(f, watch_paths)]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "files",
        nargs="*",
        help="Changed paths (repo-root relative).  Also accepted on stdin.",
    )
    parser.add_argument(
        "--from-stdin",
        action="store_true",
        help="Read one path per line from stdin (blank lines ignored).",
    )
    parser.add_argument(
        "--watch-paths",
        default="\n".join(DEFAULT_WATCH_PATHS),
        help="Newline-separated Coolify watch_paths (default: app/** and services/**).",
    )
    args = parser.parse_args(argv)

    files = [normalize_path(f) for f in args.files if normalize_path(f)]
    if args.from_stdin:
        files.extend(
            normalize_path(line)
            for line in sys.stdin
            if normalize_path(line)
        )
    if not files:
        print("skip: no changed files")
        return 1

    watch_paths = parse_watch_paths(args.watch_paths)
    if not watch_paths:
        print("error: empty watch_paths", file=sys.stderr)
        return 2

    hits = matching_files(files, watch_paths)
    if hits:
        print("deploy: " + " ".join(hits))
        return 0
    print("skip: " + " ".join(files))
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover - fail closed
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)
