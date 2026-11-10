"""Offline tests for asc_creds.load_credentials.  Run: python3 -m unittest scripts/asc/test_asc_creds.py"""
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asc_creds  # noqa: E402

NAMES = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_PATH', 'ASC_KEY_P8', 'FLEET_SECRETS']


def fake_bin(tmp: str, table: dict) -> str:
    path = os.path.join(tmp, 'fleet-secrets')
    cases = '\n'.join(f"  {k}) printf '%s\\n' '{v}' ;;" for k, v in table.items())
    with open(path, 'w') as fh:
        fh.write('#!/bin/sh\n[ "$1" = get ] && [ "$3" = --path ] && [ "$4" = /asc ] || exit 3\n'
                 f'case "$2" in\n{cases}\n  *) exit 3 ;;\nesac\n')
    os.chmod(path, stat.S_IRWXU)
    return path


class LoadCredentials(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.pop(k, None) for k in NAMES}
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        for k, v in self.saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v

    def test_falls_back_to_infisical(self):
        os.environ['FLEET_SECRETS'] = fake_bin(self.tmp, {'ASC_KEY_ID': 'KID', 'ASC_ISSUER_ID': 'ISS', 'ASC_KEY_P8': 'PEM'})
        self.assertEqual(asc_creds.load_credentials(), ('KID', 'ISS', 'PEM'))

    def test_env_wins_and_key_file_is_read(self):
        key = os.path.join(self.tmp, 'k.p8')
        with open(key, 'w') as fh:
            fh.write('FILEPEM')
        os.environ['FLEET_SECRETS'] = fake_bin(self.tmp, {'ASC_KEY_ID': 'INF', 'ASC_ISSUER_ID': 'INF', 'ASC_KEY_P8': 'INF'})
        os.environ.update(ASC_KEY_ID='ENVKID', ASC_ISSUER_ID='ENVISS', ASC_KEY_PATH=key)
        self.assertEqual(asc_creds.load_credentials(), ('ENVKID', 'ENVISS', 'FILEPEM'))

    def test_missing_everything_exits(self):
        os.environ['FLEET_SECRETS'] = os.path.join(self.tmp, 'absent')
        with self.assertRaises(SystemExit):
            asc_creds.load_credentials()


if __name__ == '__main__':
    unittest.main()
