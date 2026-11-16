#!/usr/bin/env python3
"""Offline schema/pressure tests for the separate container RAM metric."""
import json
import os
from pathlib import Path
import shlex
import subprocess
from unittest.mock import patch
from test_hetzner_digest_failures import DigestFailures
import unittest


class ContainerMemory(DigestFailures):
    def report(self, rows, **kwargs):
        payload = kwargs.pop('payload', {'containers': rows})
        p = self.siblings / 'container-mem-report.sh'
        p.write_text('#!/usr/bin/env bash\n[[ "$1" == --json ]] || exit 8\nprintf "%s\\n" ' + shlex.quote(json.dumps(payload)) + '\n')
        p.chmod(0o755)
        with patch.dict(os.environ, kwargs):
            return self.run_digest()

    def row(self, usage=50, cap=100, **kwargs):
        return dict(id='container1', name='app', memory_usage_bytes=usage,
                    memory_limit_bytes=cap, memory_current_bytes=99,
                    memory_usage_source='docker_stats', memory_limit_source='cgroup_max', **kwargs)

    def test_host_and_container_are_independent(self):
        doc = self.report([self.row(95)])
        self.assertEqual(doc['metrics']['container_memory']['status'], 'red')
        self.assertEqual(doc['overall_status'], 'red')
        self.assertEqual(doc['metrics']['memory']['available_pct'], self.run_digest()['metrics']['memory']['available_pct'])
        self.assertEqual(doc['metrics']['memory']['thresholds'], {'yellow_min_pct': 15, 'red_min_pct': 8})
        self.assertIn('Host MemAvailable / MemTotal', self.last_markdown)

    def test_configured_thresholds_do_not_reuse_host_thresholds(self):
        doc = self.report([self.row(85)], THRESH_CONTAINER_MEM_USED_PCT_YELLOW='88', THRESH_CONTAINER_MEM_USED_PCT_RED='95')
        self.assertEqual(doc['metrics']['container_memory']['status'], 'green')
        self.assertEqual(doc['metrics']['memory']['thresholds']['yellow_min_pct'], 15)

    def test_usage_not_current_and_not_mean_of_containers(self):
        doc = self.report([self.row(20), self.row(85)])
        m = doc['metrics']['container_memory']
        self.assertEqual(m['max_used_pct'], 85)
        self.assertEqual(m['status'], 'yellow')
        self.assertEqual(m['evaluated_count'], 2)
        self.assertEqual(m['containers'][0]['current_bytes'], 99)

    def test_unlimited_and_missing_caps_are_unknown(self):
        row = self.row()
        row.update(memory_limit_source='none', memory_limit_bytes=None)
        m = self.report([row, self.row(cap=0)])['metrics']['container_memory']
        self.assertEqual(m['unlimited_count'], 1)
        self.assertEqual(m['unknown_count'], 2)
        self.assertEqual(m['status'], 'unknown')
        self.assertIsNone(m['max_used_pct'])

    def test_unknown_does_not_hide_red(self):
        m = self.report([self.row(cap=None), self.row(91)])['metrics']['container_memory']
        self.assertEqual(m['status'], 'red')
        self.assertEqual(m['unknown_count'], 1)
        self.assertEqual(m['error'], 'incomplete_cap_coverage')

    def test_cgroup_fallback_source_is_explicit(self):
        row = self.row(95)
        row['memory_usage_source'] = 'cgroup_current'
        m = self.report([row])['metrics']['container_memory']
        self.assertEqual(m['containers'][0]['usage_source'], 'cgroup_current')
        self.assertEqual(m['status'], 'red')

    def test_empty_valid_report_is_not_failure(self):
        m = self.report([])['metrics']['container_memory']
        self.assertEqual(m['status'], 'green')
        self.assertEqual(m['reported_count'], 0)
        self.assertIsNone(m['max_used_pct'])

    def test_ungrounded_available_pct_is_rejected(self):
        m = self.report([], payload={'available_pct': 99})['metrics']['container_memory']
        self.assertEqual(m['status'], 'unknown')
        self.assertEqual(m['error'], 'invalid_container_schema')

    def test_invalid_or_missing_usage_not_coerced_to_zero(self):
        for bad in (None, -1, True, '20', float('nan'), float('inf')):
            with self.subTest(usage=bad):
                m = self.report([self.row(bad)])['metrics']['container_memory']
                self.assertEqual(m['status'], 'unknown')
                self.assertIsNone(m['max_used_pct'])

    def test_unknown_or_malformed_row_not_discarded(self):
        m = self.report([None, {'available_pct': 90}])['metrics']['container_memory']
        self.assertEqual(m['reported_count'], 2)
        self.assertEqual(m['unknown_count'], 2)

    def test_failed_and_absent_collectors_visible(self):
        m = self.run_digest()['metrics']['container_memory']
        self.assertEqual(m['error'], 'collector_absent')
        p = self.siblings / 'container-mem-report.sh'
        p.write_text('#!/usr/bin/env bash\nexit 4\n')
        p.chmod(0o755)
        m = self.run_digest()['metrics']['container_memory']
        self.assertEqual(m['status'], 'unknown')
        self.assertEqual(m['error'], 'collector_failed')

    def test_independent_threshold_validation(self):
        for yellow, red in [('90','80'), ('0','80'), ('80','101'), ('nan','90')]:
            with self.subTest(yellow=yellow, red=red):
                with self.assertRaises(subprocess.CalledProcessError):
                    self.report([], THRESH_CONTAINER_MEM_USED_PCT_YELLOW=yellow, THRESH_CONTAINER_MEM_USED_PCT_RED=red)


if __name__ == '__main__':
    unittest.main()
