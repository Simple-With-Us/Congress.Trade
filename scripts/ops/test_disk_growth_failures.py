#!/usr/bin/env python3
"""Hermetic regression tests for disk-growth collector/report failure paths."""
import errno
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / 'scripts/ops'


class DiskGrowthFailures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.snap = self.root / 'snapshots'
        self.snap.mkdir()
        self.tree = self.root / 'tree'
        (self.tree / 'data/backups').mkdir(parents=True)
        (self.tree / 'var').mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'du.log'
        self.command('pass', '#!/bin/bash\nwhile [[ "$1" != /* ]]; do shift; done\nexec "$@"\n')
        self.command('df', '#!/bin/bash\nprintf "Filesystem Blocks Used Available Use%% Mounted\\n/dev/test 100 50 50 50%% /\\n"\n')
        self.command('docker', '#!/bin/bash\nprintf "Images space usage:\\nREPOSITORY  SIZE\\none  1MB\\n"\n')
        self.command('findmnt', '#!/bin/bash\nexit 0\n')
        self.command('du', '#!/usr/bin/env python3\nimport os,sys\nroot=sys.argv[-1]\nwith open(os.environ["DU_LOG"],"a") as f:f.write(root+"\\n")\nfor path,ds,fs in os.walk(root):print("100\\t"+path)\nsys.exit(int(os.environ.get("FAKE_DU_EXIT","0")))\n')
        self.env = dict(os.environ, SNAPSHOT_DIR=str(self.snap),
                        SNAPSHOT_DATE='2026-07-01', REPORT_DATE='2026-07-01',
                        DISK_GROWTH_FORCE='1', DRY_RUN='1',
                        DU_SCAN_ROOTS=str(self.tree), BACKUP_SCAN_DIRS='',
                        DU_LOG=str(self.log), TOP_N='20', DU_TIMEOUT_SEC='1')
        for key, name in [('DF','df'),('DOCKER','docker'),('FINDMNT','findmnt'),
                          ('DU','du'),('TIMEOUT','pass'),('IONICE','pass'),('NICE','pass')]:
            self.env['DISK_GROWTH_' + key] = str(self.bin / name)

    def command(self, name, text):
        p = self.bin / name
        p.write_text(text)
        p.chmod(0o755)

    def run_script(self, name, *args, scripts=OPS):
        p = subprocess.run(['bash', str(scripts / name), *args], env=self.env,
                           text=True, capture_output=True, timeout=20)
        self.assertEqual(p.returncode, 0, p.stderr[:1500])
        return json.loads(p.stdout)

    def snapshot(self):
        return self.run_script('disk-growth-snapshot.sh')

    def seed(self, day, **overrides):
        d = {'schema_version': 1, 'date': day, 'filesystems': [],
             'directory_totals': {'/var': {'entries': [{'path':'/var/lib','size_bytes':100}], 'timeout':False}},
             'docker': {'available':True,'summary':{'Images':{'size_bytes_sum':100}}}, 'meta': {}}
        d.update(overrides)
        (self.snap / ('disk-growth-' + day + '.json')).write_text(json.dumps(d))

    def test_installed_sibling_library(self):
        installed = self.root / 'installed'
        installed.mkdir()
        for name in ['disk-growth-lib.sh','disk-growth-snapshot.sh','disk-growth-report.sh']:
            shutil.copy(OPS / name, installed / name)
        self.assertEqual(self.run_script('disk-growth-snapshot.sh', scripts=installed)['schema_version'], 1)
        self.seed('2026-07-01')
        self.assertIn('directories', self.run_script('disk-growth-report.sh', '--json', scripts=installed))

    def test_large_snapshot_report_does_not_enter_environment(self):
        self.seed('2026-07-01', padding='x' * 300000)
        self.seed('2026-06-30', padding='x' * 300000)
        self.assertTrue(self.run_script('disk-growth-report.sh', '--json')['directories']['1d']['available'])

    def test_large_docker_inventory_does_not_enter_environment(self):
        self.command('docker', '#!/usr/bin/env python3\nprint("Images space usage:\\nREPOSITORY  SIZE")\nfor i in range(6000):print("image"+str(i)+"x"*60+"  1MB")\n')
        d = self.snapshot()
        self.assertEqual(d['docker']['summary']['Images']['row_count'], 6000)

    def test_overlap_single_walk_preserves_child_breakdown(self):
        self.env['DU_SCAN_ROOTS'] = ','.join([str(self.tree), str(self.tree/'data'), str(self.tree/'var'), str(self.tree)])
        self.env['BACKUP_SCAN_DIRS'] = str(self.tree/'data/backups')
        d = self.snapshot()
        self.assertEqual(self.log.read_text().splitlines(), [str(self.tree)])
        self.assertIn(str(self.tree/'data/backups'), d['directory_totals'])
        self.assertTrue(d['directory_totals'][str(self.tree/'data')]['entries'])

    def test_symlink_backup_uses_resolved_tree_without_repeat(self):
        alias = self.root / 'backup-link'
        alias.symlink_to(self.tree/'data/backups', target_is_directory=True)
        self.env['BACKUP_SCAN_DIRS'] = str(alias)
        d = self.snapshot()
        self.assertEqual(len(self.log.read_text().splitlines()), 1)
        self.assertIn(str(self.tree/'data/backups'), d['directory_totals'])

    def test_real_gnu_du_retains_nested_requested_root(self):
        probe = subprocess.run(['du','--version'], text=True, capture_output=True)
        if probe.returncode or 'GNU' not in probe.stdout:
            self.skipTest('production du options require GNU du')
        self.env['DISK_GROWTH_DU'] = shutil.which('du')
        self.env['BACKUP_SCAN_DIRS'] = str(self.tree/'data/backups')
        (self.tree/'data/backups/day.sql').write_text('fixture')
        raw = os.fsencode(self.tree/'data/backups') + b'/gnu-\xff-name'
        os.mkdir(raw)
        d = self.snapshot()
        self.assertFalse(d['meta']['du_partial'])
        block = d['directory_totals'][str(self.tree/'data/backups')]
        self.assertTrue(any(x['path'] == str(self.tree/'data/backups') for x in block['entries']))
        self.assertTrue(any(x['path'] == os.fsdecode(raw) for x in block['entries']))

    def test_similar_prefix_is_not_ancestor(self):
        other = self.root / 'tree2'
        other.mkdir()
        self.env['DU_SCAN_ROOTS'] += ',' + str(other)
        self.snapshot()
        self.assertEqual(set(self.log.read_text().splitlines()), {str(self.tree),str(other)})

    def test_nonzero_and_timeout_du_are_partial(self):
        for code in ['1','124']:
            with self.subTest(code=code):
                self.env['FAKE_DU_EXIT'] = code
                d = self.snapshot()
                self.assertTrue(d['meta']['du_partial'])
                block = d['directory_totals'][str(self.tree)]
                self.assertTrue(block['timeout'] if code=='124' else block['error'])
                self.assertTrue(block['entries'])

    def test_partial_directory_current_or_baseline_is_unavailable(self):
        for day in ['2026-07-01','2026-06-30']:
            with self.subTest(day=day):
                self.seed('2026-07-01'); self.seed('2026-06-30')
                self.seed(day, meta={'du_partial':True})
                d = self.run_script('disk-growth-report.sh','--json')['directories']['1d']
                self.assertFalse(d['available'])
                self.assertEqual(d['shrinkers'], [])

    def test_root_timeout_honored_without_global_flag(self):
        self.seed('2026-07-01', directory_totals={'/var':{'entries':[],'timeout':True}})
        self.seed('2026-06-30')
        self.assertFalse(self.run_script('disk-growth-report.sh','--json')['directories']['1d']['available'])

    def test_docker_unavailable_current_or_baseline_not_shrinkage(self):
        for day in ['2026-07-01','2026-06-30']:
            with self.subTest(day=day):
                self.seed('2026-07-01'); self.seed('2026-06-30')
                self.seed(day, docker={'available':False,'error':'docker_unavailable','sections':{}})
                self.assertFalse(self.run_script('disk-growth-report.sh','--json')['docker_summary']['1d']['available'])

    def test_invalid_filename_bytes_survive_collection_and_report(self):
        # du emits filesystem bytes, not guaranteed Unicode. The stub walks a
        # real invalid-byte directory and emits it with the OS surrogate policy.
        raw = os.fsencode(self.tree) + b'/bad-\xff-name'
        try:
            os.mkdir(raw)
        except OSError as exc:
            if exc.errno == errno.EILSEQ:
                self.skipTest('filesystem refuses invalid filename bytes')
            raise
        doc = self.snapshot()
        paths = [ent['path'] for block in doc['directory_totals'].values() for ent in block['entries']]
        self.assertIn(os.fsdecode(raw), paths)
        self.assertFalse(doc['meta']['du_partial'])
        self.seed('2026-07-01', directory_totals=doc['directory_totals'])
        self.seed('2026-06-30', directory_totals=doc['directory_totals'])
        report = self.run_script('disk-growth-report.sh', '--json')
        self.assertTrue(report['directories']['1d']['available'])

    def test_top_n_omission_is_not_measured_shrinkage(self):
        self.seed('2026-07-01', directory_totals={'/var':{'entries':[],'timeout':False}})
        self.seed('2026-06-30')
        d = self.run_script('disk-growth-report.sh','--json')['directories']['1d']
        self.assertEqual(d['shrinkers'], [])
        self.assertEqual(d['unmatched_baseline_paths'], 1)

    def test_required_default_separate_mount_roots(self):
        s = (OPS/'disk-growth-lib.sh').read_text()
        self.assertIn('DU_SCAN_ROOTS:=/,/var,/home,/data,/opt,/tmp,/mnt/fleet-extra', s)
        unit = (OPS/'systemd.noindex/disk-growth-snapshot.service').read_text()
        self.assertIn('TimeoutStartSec=infinity', unit)


if __name__ == '__main__':
    unittest.main()
