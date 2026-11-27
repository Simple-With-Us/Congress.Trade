#!/usr/bin/env python3
"""Fetch Congress.Trade vision-worker secrets from Infisical and exec worker.py.

Infisical is the sole source of truth (prod environment, root path "/").  Ambient
secret and INFISICAL_* environment variables are stripped before fetching and are
never used as fallbacks.  Token custody prefers the macOS Login Keychain entry
(service "infisical-service-token", account "vision-worker-ct-ro") and falls back
to a custody-checked 0600 token file for non-GUI daemon sessions (such as pm2).

The Infisical project ID is discovered dynamically from the scoped service
token's own metadata (`/api/v2/service-token`), so no workspace UUID is
hardcoded in public source.
"""

from __future__ import annotations

import json
import os
import pathlib
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence

ENVIRONMENT = "prod"
SECRET_PATH = "/"
INFISICAL_SERVICE_TOKEN_URL = "https://app.infisical.com/api/v2/service-token"
INFISICAL_RAW_URL = "https://app.infisical.com/api/v3/secrets/raw"
ALLOWED_HOST = "app.infisical.com"
HTTP_TIMEOUT_SEC = 15

DEFAULT_KEYCHAIN_SERVICE = "infisical-service-token"
DEFAULT_TOKEN_ACCOUNT = "vision-worker-ct-ro"
DEFAULT_TOKEN_FILE = pathlib.Path.home() / ".config" / "infisical" / "tokens" / f"{DEFAULT_TOKEN_ACCOUNT}.token"
TOKEN_FILE_ENV = "VISION_WORKER_INFISICAL_TOKEN_FILE"

SECRET_KEY_CANDIDATES: dict[str, tuple[str, ...]] = {
    "ADMIN_TOKEN": ("ADMIN_TOKEN", "CT_ADMIN_TOKEN"),
    "OPENROUTER_API_KEY": ("OPENROUTER_API_KEY", "CT_OPENROUTER_API_KEY"),
    "PUSHOVER_APP_TOKEN": ("PUSHOVER_APP_TOKEN",),
    "PUSHOVER_USER_KEY": ("PUSHOVER_USER_KEY",),
}
REQUIRED_ENV_VARS = ("ADMIN_TOKEN",)
STRIPPED_ENV_KEYS = frozenset({
    "ADMIN_TOKEN",
    "CT_ADMIN_TOKEN",
    "OPENROUTER_API_KEY",
    "CT_OPENROUTER_API_KEY",
    "PUSHOVER_APP_TOKEN",
    "PUSHOVER_USER_KEY",
})


class LauncherError(RuntimeError):
    """Raised when token custody, Infisical fetch, or required secrets fail."""


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse 3xx redirects so Authorization headers never cross origins."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        raise urllib.error.HTTPError(
            req.full_url,
            code,
            f"Refusing HTTP {code} redirect from Infisical endpoint",
            headers,
            fp,
        )


def read_custody_token_file(path: os.PathLike[str] | str) -> str:
    """Read a service token from a regular 0600 file owned by the current uid."""
    token_path = pathlib.Path(path).expanduser()
    if token_path.is_symlink():
        raise LauncherError(f"Refusing symlink token file: {token_path}")
    parent = token_path.parent
    if parent.is_symlink():
        raise LauncherError(f"Refusing symlink token directory: {parent}")
    try:
        parent_st = os.lstat(parent)
    except OSError as exc:
        raise LauncherError(f"Token directory unreadable ({parent}): {type(exc).__name__}") from exc
    euid = os.geteuid()
    if parent_st.st_uid != euid:
        raise LauncherError(f"Token directory not owned by current user: {parent}")
    if (stat.S_IMODE(parent_st.st_mode) & 0o022) != 0:
        raise LauncherError(f"Token directory is group/world writable: {parent}")

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(token_path, flags)
    except OSError as exc:
        raise LauncherError(f"Token file missing or unreadable ({token_path}): {type(exc).__name__}") from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise LauncherError(f"Token path is not a regular file: {token_path}")
        if st.st_uid != euid:
            raise LauncherError(f"Token file not owned by current user: {token_path}")
        if (stat.S_IMODE(st.st_mode) & 0o077) != 0:
            raise LauncherError(f"Token file permissions must be 0600 or stricter: {token_path}")
        fh = os.fdopen(fd, "r", encoding="utf-8")
        fd = -1  # fh now owns the descriptor
        with fh:
            token = fh.read().strip()
    except Exception:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        raise
    if not token:
        raise LauncherError(f"Token file is empty: {token_path}")
    return token


def read_keychain_token(
    service: str = DEFAULT_KEYCHAIN_SERVICE,
    account: str = DEFAULT_TOKEN_ACCOUNT,
) -> str | None:
    """Return service token from macOS Login Keychain, or None if unavailable."""
    if sys.platform != "darwin":
        return None
    security_bin = "/usr/bin/security"
    if not os.path.exists(security_bin):
        return None
    try:
        proc = subprocess.run(
            [security_bin, "find-generic-password", "-s", service, "-a", account, "-w"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    token = proc.stdout.strip()
    return token or None


def resolve_service_token(
    explicit_token_file: str | None = None,
    *,
    env: Mapping[str, str] = os.environ,
    keychain_service: str = DEFAULT_KEYCHAIN_SERVICE,
    keychain_account: str = DEFAULT_TOKEN_ACCOUNT,
    default_token_file: pathlib.Path = DEFAULT_TOKEN_FILE,
) -> str:
    """Resolve the scoped read-only Infisical service token (never from env secret values)."""
    configured_path = (explicit_token_file or "").strip() or env.get(TOKEN_FILE_ENV, "").strip()
    if configured_path:
        return read_custody_token_file(configured_path)

    keychain_token = read_keychain_token(service=keychain_service, account=keychain_account)
    if keychain_token:
        return keychain_token

    if default_token_file.exists() or default_token_file.is_symlink():
        return read_custody_token_file(default_token_file)

    raise LauncherError(
        "Infisical service token missing: add Login Keychain item "
        f"(service={keychain_service}, account={keychain_account}) or create 0600 "
        f"token file {default_token_file}"
    )


def _validate_pinned_url(url: str) -> urllib.parse.ParseResult:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != ALLOWED_HOST:
        raise LauncherError(f"Refusing non-pinned Infisical URL: {url}")
    return parsed


def _get_json(url: str, token: str, *, opener: urllib.request.OpenerDirector | None = None) -> dict:
    _validate_pinned_url(url)
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token.strip()}",
            "Accept": "application/json",
            "User-Agent": "congress-trade-vision-worker/1.0",
        },
        method="GET",
    )
    director = opener or urllib.request.build_opener(_NoRedirectHandler())
    try:
        with director.open(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            status = getattr(resp, "status", 200)
            if status != 200:
                raise LauncherError(f"Infisical returned HTTP {status}")
            raw_body = resp.read()
    except urllib.error.HTTPError as exc:
        raise LauncherError(f"Infisical HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise LauncherError(f"Infisical request failed ({type(exc.reason).__name__})") from exc

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise LauncherError("Infisical response was not valid JSON") from exc
    if not isinstance(payload, dict):
        raise LauncherError("Infisical response was not a JSON object")
    return payload


def discover_service_token_project(
    token: str,
    *,
    environment: str = ENVIRONMENT,
    token_info_url: str = INFISICAL_SERVICE_TOKEN_URL,
    opener: urllib.request.OpenerDirector | None = None,
) -> str:
    """Discover the workspace/project ID bound to this scoped Infisical service token."""
    if environment != "prod":
        raise LauncherError(f"Infisical environment must be 'prod', got {environment!r}")
    if not token or not token.strip():
        raise LauncherError("Infisical service token is empty")
    payload = _get_json(token_info_url, token, opener=opener)
    workspace = str(payload.get("workspace") or "").strip()
    if not workspace:
        raise LauncherError("Infisical service-token metadata missing workspace ID")
    scopes = payload.get("scopes")
    if not isinstance(scopes, list) or not scopes:
        raise LauncherError("Infisical service-token metadata missing scopes")
    envs = {
        str(item.get("environment") or "").strip()
        for item in scopes
        if isinstance(item, dict)
    }
    if environment not in envs:
        raise LauncherError(f"Infisical service token is not scoped to {environment!r}")
    return workspace


def build_infisical_url(
    *,
    project_id: str,
    environment: str = ENVIRONMENT,
    secret_path: str = SECRET_PATH,
    base_url: str = INFISICAL_RAW_URL,
) -> str:
    """Build pinned HTTPS URL for Infisical prod secret fetch."""
    if environment != "prod":
        raise LauncherError(f"Infisical environment must be 'prod', got {environment!r}")
    if not project_id or not project_id.strip():
        raise LauncherError("Infisical project ID is empty")
    parsed = _validate_pinned_url(base_url)
    query = urllib.parse.urlencode({
        "workspaceId": project_id.strip(),
        "environment": environment,
        "secretPath": secret_path,
        "include_imports": "true",
        "expandSecretReferences": "true",
    })
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{query}"


def fetch_infisical_secrets(
    token: str,
    *,
    project_id: str | None = None,
    environment: str = ENVIRONMENT,
    secret_path: str = SECRET_PATH,
    base_url: str = INFISICAL_RAW_URL,
    token_info_url: str = INFISICAL_SERVICE_TOKEN_URL,
    opener: urllib.request.OpenerDirector | None = None,
) -> dict[str, str]:
    """Fetch raw expanded secrets (including imports) from Infisical prod."""
    if not token or not token.strip():
        raise LauncherError("Infisical service token is empty")
    resolved_project = (
        project_id.strip()
        if project_id and project_id.strip()
        else discover_service_token_project(
            token,
            environment=environment,
            token_info_url=token_info_url,
            opener=opener,
        )
    )
    url = build_infisical_url(
        project_id=resolved_project,
        environment=environment,
        secret_path=secret_path,
        base_url=base_url,
    )
    payload = _get_json(url, token, opener=opener)
    items = payload.get("secrets")
    if not isinstance(items, list):
        raise LauncherError("Infisical response missing 'secrets' list")

    out: dict[str, str] = {}
    for entry in items:
        if not isinstance(entry, dict):
            continue
        key = entry.get("secretKey")
        val = entry.get("secretValue")
        if isinstance(key, str) and isinstance(val, str):
            out[key] = val
    return out


def strip_secret_env(env: Mapping[str, str]) -> dict[str, str]:
    """Return a copy of env with ambient secrets and INFISICAL_* variables removed."""
    return {
        k: v
        for k, v in env.items()
        if k not in STRIPPED_ENV_KEYS and not k.startswith("INFISICAL_") and k != TOKEN_FILE_ENV
    }


def build_child_env(base_env: Mapping[str, str], fetched_secrets: Mapping[str, str]) -> dict[str, str]:
    """Build sanitized child process env populated solely from Infisical secrets."""
    child_env = strip_secret_env(base_env)
    for target_env, candidates in SECRET_KEY_CANDIDATES.items():
        for secret_key in candidates:
            value = str(fetched_secrets.get(secret_key, "")).strip()
            if value:
                child_env[target_env] = value
                break
    missing = [name for name in REQUIRED_ENV_VARS if not child_env.get(name, "").strip()]
    if missing:
        raise LauncherError(f"Missing required Infisical secret(s): {', '.join(missing)}")
    if (
        child_env.get("VISION_ENGINE", "").strip().lower() == "openrouter"
        and not child_env.get("OPENROUTER_API_KEY", "").strip()
    ):
        raise LauncherError("OPENROUTER_API_KEY required for VISION_ENGINE=openrouter")
    return child_env


def parse_args(argv: Sequence[str]) -> tuple[str | None, bool, list[str]]:
    """Parse `--token-file PATH` and `--check` anywhere in argv, forwarding target script/args."""
    args = list(argv)
    token_file: str | None = None
    check_only = False
    remaining: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--token-file":
            if i + 1 >= len(args) or not args[i + 1].strip() or args[i + 1].startswith("--"):
                raise LauncherError("--token-file requires a path argument")
            token_file = args[i + 1]
            i += 2
        elif arg.startswith("--token-file="):
            token_file = arg.split("=", 1)[1]
            if not token_file.strip() or token_file.startswith("--"):
                raise LauncherError("--token-file requires a path argument")
            i += 1
        elif arg == "--check":
            check_only = True
            i += 1
        else:
            remaining.append(arg)
            i += 1
    if not remaining:
        default_worker = str(pathlib.Path(__file__).resolve().with_name("worker.py"))
        remaining = [default_worker]
    return token_file, check_only, remaining


def main(argv: Sequence[str] | None = None) -> int:
    try:
        token_file, check_only, worker_cmd = parse_args(sys.argv[1:] if argv is None else argv)
        ambient_infisical_env = os.environ.get("INFISICAL_ENVIRONMENT", "").strip()
        if ambient_infisical_env and ambient_infisical_env != "prod":
            raise LauncherError(
                f"Infisical environment must be 'prod', got {ambient_infisical_env!r}"
            )
        token = resolve_service_token(token_file)
        secrets = fetch_infisical_secrets(token)
        child_env = build_child_env(os.environ, secrets)
    except LauncherError as exc:
        print(f"vision-worker: {exc}", file=sys.stderr)
        return 2

    if check_only:
        present = [k for k in SECRET_KEY_CANDIDATES if child_env.get(k)]
        print(f"vision-worker: Infisical check ok (keys set: {', '.join(present)})")
        return 0

    os.execve(sys.executable, [sys.executable, *worker_cmd], child_env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
