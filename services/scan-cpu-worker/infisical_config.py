"""Resolve ADMIN_TOKEN from env or Infisical (prod app project)."""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("scan-cpu-worker.infisical")

DEFAULT_BASE_URL = "https://app.infisical.com"
DEFAULT_ENV = "prod"


def infisical_environment_name() -> str:
    """prod is the only Infisical environment the fleet reads."""
    val = (os.getenv("INFISICAL_ENV") or "").strip()
    if not val or val == DEFAULT_ENV or val == "production":
        return DEFAULT_ENV
    raise RuntimeError(
        f'INFISICAL_ENV must be "{DEFAULT_ENV}" (dev and staging are retired); got "{val[:32]}"'
    )


def _bootstrap_credentials() -> Tuple[str, str, str]:
    client_id = (
        os.getenv("INFISICAL_APP_CLIENT_ID") or os.getenv("INFISICAL_CLIENT_ID") or ""
    ).strip()
    client_secret = (
        os.getenv("INFISICAL_APP_CLIENT_SECRET") or os.getenv("INFISICAL_CLIENT_SECRET") or ""
    ).strip()
    project_id = (os.getenv("INFISICAL_APP_PROJECT_ID") or "").strip()
    if not client_id or not client_secret or not project_id:
        raise RuntimeError(
            "Infisical bootstrap incomplete: need INFISICAL_APP_CLIENT_ID, "
            "INFISICAL_APP_CLIENT_SECRET, and INFISICAL_APP_PROJECT_ID"
        )
    return client_id, client_secret, project_id


def _secret_path() -> str:
    path = (
        os.getenv("INFISICAL_APP_SECRET_PATH")
        or os.getenv("INFISICAL_SECRET_PATH")
        or "/"
    ).strip()
    return path or "/"


def _base_url() -> str:
    return (os.getenv("INFISICAL_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def _http_json(
    url: str,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: int = 30,
) -> Dict[str, Any]:
    data_bytes = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data_bytes, method=method)
    req.add_header("Content-Type", "application/json")
    if headers:
        for key, value in headers.items():
            req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"HTTP {e.code} from Infisical: {err_body}") from e


def _secret_entries(payload: Any) -> List[Tuple[str, str]]:
    if not isinstance(payload, dict):
        return []
    raw = (
        payload.get("secrets")
        or (payload.get("data") or {}).get("secrets")
        or payload.get("secret")
        or (payload.get("data") or {}).get("secret")
        or []
    )
    if isinstance(raw, dict):
        shaped_key = raw.get("secretKey") or raw.get("key") or raw.get("name")
        shaped_value = raw.get("secretValue") or raw.get("value")
        if isinstance(shaped_key, str) and isinstance(shaped_value, str):
            return [(shaped_key, shaped_value)]
        return [
            (str(k), str(v))
            for k, v in raw.items()
            if isinstance(v, str)
        ]
    if not isinstance(raw, list):
        raw = [raw]
    entries: List[Tuple[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = item.get("secretKey") or item.get("key") or item.get("name")
        value = item.get("secretValue") or item.get("value")
        if isinstance(key, str) and isinstance(value, str):
            entries.append((key, value))
    return entries


def fetch_secret_from_infisical(secret_key: str) -> str:
    """Fetch one secret from the CT app Infisical project (universal auth)."""
    client_id, client_secret, project_id = _bootstrap_credentials()
    base = _base_url()
    inf_env = infisical_environment_name()
    secret_path = _secret_path()

    auth_body = _http_json(
        f"{base}/api/v1/auth/universal-auth/login",
        method="POST",
        body={"clientId": client_id, "clientSecret": client_secret},
    )
    token = auth_body.get("accessToken") or auth_body.get("token")
    if not isinstance(token, str) or not token.strip():
        raise RuntimeError("Infisical universal-auth login returned no access token")

    params = urllib.parse.urlencode(
        {
            "workspaceId": project_id,
            "environment": inf_env,
            "secretPath": secret_path,
            "include_imports": "true",
            "recursive": "true",
        }
    )
    secrets_body = _http_json(
        f"{base}/api/v3/secrets/raw?{params}",
        headers={"Authorization": f"Bearer {token}"},
    )
    for key, value in _secret_entries(secrets_body):
        if key == secret_key and value.strip():
            return value.strip()
    raise RuntimeError(f"Infisical secret {secret_key!r} is missing or empty in {inf_env}")


def resolve_admin_token() -> str:
    """ADMIN_TOKEN from env, else Infisical prod app project."""
    from_env = (os.getenv("ADMIN_TOKEN") or "").strip()
    if from_env:
        return from_env
    logger.info(
        "ADMIN_TOKEN not in environment; fetching from Infisical (app project, %s)",
        infisical_environment_name(),
    )
    return fetch_secret_from_infisical("ADMIN_TOKEN")
