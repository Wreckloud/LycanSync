import importlib.util
import json
import hashlib
import shutil
import tempfile
import unittest
import sys
import os
import time
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('maintain_releases', Path(__file__).parent / 'maintenance/maintain-releases.py')
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class ReleaseMaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.downloads = self.root / 'downloads'
        self.downloads.mkdir()
        (self.root / '.env').write_text('private configuration')
        for version in ['0.3.8', '0.3.9', '0.3.10']:
            manifest = f'version: {version}\n'.encode()
            entries = []
            for suffix in ['windows-x64-setup.exe', 'windows-x64-setup.exe.blockmap',
                           'obs-source.tar.gz', 'THIRD-PARTY-NOTICES.txt']:
                name = f'LycanSync-{version}-{suffix}'
                content = f'{version}-{suffix}'.encode()
                (self.downloads / name).write_bytes(content)
                entries.append({'name': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
            entries.append({'name': 'latest.yml', 'bytes': len(manifest), 'sha256': hashlib.sha256(manifest).hexdigest()})
            (self.downloads / f'LycanSync-{version}-release.json').write_text(json.dumps({'version': version, 'files': entries}))
        (self.downloads / 'latest.yml').write_bytes(manifest)
        for suffix in ['.exe', '.exe.blockmap']:
            shutil.copyfile(self.downloads / f'LycanSync-0.3.10-windows-x64-setup{suffix}', self.downloads / f'LycanSync-setup{suffix}')
        self.stage = self.root / 'incoming-client-0.3.8-test'
        self.stage.mkdir()
        for file in self.downloads.glob('LycanSync-0.3.8-*'):
            shutil.copyfile(file, self.stage / file.name)

    def test_preview_then_cleanup_keeps_only_current_release_and_recent_reports(self):
        reports = self.root / 'maintenance'
        reports.mkdir()
        old = reports / 'old.log'
        old.write_text('old test log')
        os.utime(old, (time.time() - 4 * 86400, time.time() - 4 * 86400))
        recent = reports / 'recent.json'
        recent.write_text('{}')
        for name in ['settings.json', 'notes.txt', 'release-cleanup-20260101T000000Z.json']:
            file = reports / name
            file.write_text('{}')
            os.utime(file, (time.time() - 4 * 86400, time.time() - 4 * 86400))
        preview, plan = maintenance.maintain(self.root)
        self.assertFalse(preview['applied'])
        self.assertTrue((self.stage / 'LycanSync-0.3.8-obs-source.tar.gz').exists())
        self.assertTrue(plan)
        result, _ = maintenance.maintain(self.root, True)
        self.assertEqual(result['keepInstallers'], ['0.3.10'])
        self.assertFalse((self.downloads / 'LycanSync-0.3.8-windows-x64-setup.exe').exists())
        for version in ['0.3.8', '0.3.9']:
            self.assertEqual(list(self.downloads.glob(f'LycanSync-{version}-*')), [])
        for suffix in ['windows-x64-setup.exe', 'windows-x64-setup.exe.blockmap', 'obs-source.tar.gz', 'THIRD-PARTY-NOTICES.txt', 'release.json']:
            self.assertTrue((self.downloads / f'LycanSync-0.3.10-{suffix}').exists())
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue((reports / 'settings.json').exists())
        self.assertTrue((reports / 'notes.txt').exists())
        self.assertFalse((reports / 'release-cleanup-20260101T000000Z.json').exists())
        self.assertEqual((self.root / '.env').read_text(), 'private configuration')
        self.assertTrue((self.root / 'incoming/legacy' / self.stage.name).is_dir())
        second, _ = maintenance.maintain(self.root, True)
        self.assertEqual(second['removeFiles'], 0)

    def test_mismatched_staging_copy_is_preserved(self):
        file = self.stage / 'LycanSync-0.3.8-obs-source.tar.gz'
        file.write_bytes(b'different source')
        maintenance.maintain(self.root, True)
        retained = self.root / 'incoming/legacy' / self.stage.name / file.name
        self.assertEqual(retained.read_bytes(), b'different source')

    def test_damaged_current_release_stops_before_any_deletion(self):
        (self.downloads / 'LycanSync-0.3.10-windows-x64-setup.exe').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            maintenance.maintain(self.root, True)
        self.assertTrue((self.downloads / 'LycanSync-0.3.8-windows-x64-setup.exe').exists())
        self.assertTrue(self.stage.exists())


if __name__ == '__main__':
    unittest.main()
