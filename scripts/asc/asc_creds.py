"""App Store Connect API credentials for the read-only asc_*.py helpers.

Env first (ASC_KEY_ID, ASC_ISSUER_ID, then ASC_KEY_PATH or ASC_KEY_P8), then Infisical
Fleet-OPS folder /asc through `fleet-secrets get` (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8).
No local secrets folder is read (AFC-359).  Values are never printed or logged.  FLEET_SECRETS
overrides the fleet-secrets binary (tests inject a fake).
"""
import os
import subprocess

FOLDER = '/asc'


def _fleet_secret(name: str) -> str:
    bin_path = os.environ.get('FLEET_SECRETS') or os.path.expanduser('~/.local/bin/fleet-secrets')
    try:
        res = subprocess.run([bin_path, 'get', name, '--path', FOLDER], capture_output=True, text=True,
                             check=False, stdin=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ''
    return res.stdout.rstrip('\n').strip() if res.returncode == 0 else ''


def _env_or_secret(name: str) -> str:
    return (os.environ.get(name) or '').strip() or _fleet_secret(name)


def load_credentials():
    """Return (key_id, issuer_id, private_key_pem); exits with a clear message when absent."""
    kid = _env_or_secret('ASC_KEY_ID')
    iss = _env_or_secret('ASC_ISSUER_ID')
    pem = ''
    key_path = os.path.expanduser((os.environ.get('ASC_KEY_PATH') or '').strip())
    if key_path and os.path.isfile(key_path):
        with open(key_path) as fh:
            pem = fh.read()
    if not pem:
        pem = _env_or_secret('ASC_KEY_P8').replace('\\n', '\n')
    if not (kid and iss and pem):
        raise SystemExit('Missing ASC_KEY_ID / ASC_ISSUER_ID / key: set ASC_KEY_ID, ASC_ISSUER_ID and '
                         'ASC_KEY_PATH in the environment, or add ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 '
                         'to Infisical /asc')
    return kid, iss, pem
