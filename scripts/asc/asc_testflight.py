#!/usr/bin/env python3
"""Read-only: TestFlight availability of the newest Congress.Trade builds.

Reads ASC credentials from env, else Infisical /asc (asc_creds.py);  never prints them.
"""
import json
import os
import sys
import time
import urllib.request

import jwt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from asc_creds import load_credentials  # noqa: E402

APP = '6798076688'


kid, iss, pem = load_credentials()
tok = jwt.encode(
    {'iss': iss, 'iat': int(time.time()), 'exp': int(time.time()) + 900, 'aud': 'appstoreconnect-v1'},
    pem, algorithm='ES256', headers={'kid': kid, 'typ': 'JWT'})


def api(path: str):
    req = urllib.request.Request(f'https://api.appstoreconnect.apple.com/v1/{path}',
                                 headers={'Authorization': f'Bearer {tok}'})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=45).read())
    except Exception as e:  # noqa: BLE001
        return {'_err': getattr(e, 'code', '?')}


builds = api(f'builds?filter[app]={APP}&limit=3&sort=-uploadedDate'
             '&fields[builds]=version,processingState,expired')
for item in builds.get('data', []):
    bid = item['id']
    version = item['attributes']['version']
    det = api(f'builds/{bid}/buildBetaDetail'
              '?fields[buildBetaDetails]=internalBuildState,externalBuildState,autoNotifyEnabled')
    d = det.get('data')
    at = d.get('attributes', {}) if isinstance(d, dict) else {}
    groups = api(f'builds/{bid}/betaGroups?limit=5&fields[betaGroups]=name,isInternalGroup')
    names = [g['attributes'].get('name') for g in groups.get('data', [])] if groups.get('data') else []
    print(f"build {version}: internal={at.get('internalBuildState')} "
          f"external={at.get('externalBuildState')} groups={names or 'none'}")
