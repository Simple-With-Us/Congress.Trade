#!/usr/bin/env python3
"""Hermetic failure-path tests for the resource digest. No live collectors run."""
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/ops/hetzner-resource-digest.sh'
FIXTURES = ROOT / 'scripts/ops/fixtures/hetzner-resource-digest'


class DigestFailures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.fixtures = self.root / 'fixtures'
        shutil.copytree(FIXTURES, self.fixtures)
        self.siblings = self.root / 'siblings'
        self.siblings.mkdir()

    def run_digest(self):
        env = dict(os.environ, HETZNER_DIGEST_FIXTURE_ROOT=str(self.fixtures),
                   HETZNER_DIGEST_SIBLING_DIR=str(self.siblings),
                   HETZNER_DIGEST_STATE_PATH=str(self.root / 'state.json'),
                   HETZNER_DIGEST_STDOUT_ONLY='1', HETZNER_DIGEST_SKIP_STATE_WRITE='1',
                   HETZNER_DIGEST_CPU_STEAL_SECONDS='0')
        run = subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True,
                             text=True, check=True, timeout=10)
        self.assertEqual(run.stdout.count('--- json ---'), 1)
        self.assertEqual(run.stdout.count('--- markdown ---'), 1)
        raw, md = run.stdout.split('--- markdown ---\n')
        doc = json.loads(raw.split('--- json ---\n')[1])
        self.last_markdown = md
        return doc

    def test_stdout_has_one_document(self):
        self.assertEqual(self.run_digest()['overall_status'], 'yellow')
        self.assertNotIn('"generated_at"', self.last_markdown)

    def test_failed_sibling_is_error(self):
        p = self.siblings / 'host-inode-report.sh'
        p.write_text('#!/usr/bin/env bash\nexit 4\n')
        p.chmod(0o755)
        doc = self.run_digest()
        self.assertEqual(doc['siblings']['inode_report']['status'], 'error')
        self.assertEqual(doc['metrics']['root_inode_used_pct']['value'], 47)

    def test_all_missing_fixture_metrics_are_unknown(self):
        for path in self.fixtures.iterdir():
            if path.is_file():
                path.unlink()
        doc = self.run_digest()
        self.assertEqual(doc['overall_status'], 'unknown')
        for metric in doc['metrics'].values():
            self.assertEqual(metric['status'], 'unknown')

    def test_zero_interval_is_not_healthy_zero(self):
        (self.fixtures / 'proc-stat-b.txt').write_bytes((self.fixtures / 'proc-stat-a.txt').read_bytes())
        doc = self.run_digest()
        self.assertIsNone(doc['metrics']['cpu_steal']['steal_pct'])
        self.assertEqual(doc['metrics']['cpu_steal']['status'], 'unknown')
        self.assertEqual(doc['metrics']['cpu_steal']['error'], 'zero_interval')

    def test_missing_cpu_count_is_unknown(self):
        (self.fixtures / 'ncpu.txt').unlink()
        doc = self.run_digest()
        self.assertEqual(doc['metrics']['load']['status'], 'unknown')
        self.assertEqual(doc['metrics']['load']['error'], 'cpu_count_unavailable')

    def test_failed_candidate_does_not_hide_later_working_candidate(self):
        bad = self.siblings / 'bad.sh'
        good = self.siblings / 'good.sh'
        bad.write_text('#!/usr/bin/env bash\nexit 4\n')
        good.write_text('#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"used_pct":91}\'\n')
        bad.chmod(0o755)
        good.chmod(0o755)
        # Source definitions only, then provide an isolated two-candidate search.
        definitions = SCRIPT.read_text().rsplit('\nmain "$@"', 1)[0]
        definitions = definitions.replace('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"', 'SCRIPT_DIR=.')
        body = definitions + '\nsibling_search_paths() { printf "%s\\n" ' + shlex.quote(str(bad)) + ' ' + shlex.quote(str(good)) + '; }\ntry_sibling_json test\n'
        run = subprocess.run(['bash', '-c', body], capture_output=True, text=True,
                             check=True, timeout=10)
        self.assertEqual(json.loads(run.stdout), {'used_pct': 91})

    def test_sibling_override_clears_builtin_error(self):
        (self.fixtures / 'df-inodes.txt').unlink()
        p = self.siblings / 'host-inode-report.sh'
        p.write_text('#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"used_pct":91}\'\n')
        p.chmod(0o755)
        doc = self.run_digest()
        self.assertEqual(doc['metrics']['root_inode_used_pct']['value'], 91)
        self.assertIsNone(doc['metrics']['root_inode_used_pct']['error'])


if __name__ == '__main__':
    unittest.main()
