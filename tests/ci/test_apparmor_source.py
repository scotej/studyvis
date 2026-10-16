import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/download-linux-apparmor-source.sh'


class AppArmorSourceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.output = self.root / 'output'
        self.output.mkdir()
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        self.calls = self.root / 'calls'
        curl = self.tools / 'curl'
        curl.write_text('''#!/usr/bin/env python3
import os, pathlib, sys
args = sys.argv[1:]
pathlib.Path(os.environ['CALLS']).write_text(args[-1])
pathlib.Path(args[args.index('--output') + 1]).write_bytes(b'tampered source')
''')
        curl.chmod(0o755)

    def run_download(self, *args):
        return subprocess.run(
            ['bash', str(SCRIPT), *map(str, args)],
            env={**os.environ, 'PATH': f'{self.tools}:{os.environ["PATH"]}',
                 'CALLS': str(self.calls)},
            capture_output=True, text=True, timeout=10,
        )

    def test_reviewed_versions_reject_tampered_source_without_publishing(self):
        for revision, snapshot in ((7, '20260615'), (8, '20261001')):
            with self.subTest(revision=revision):
                version = f'4.0.1really4.0.1-0ubuntu0.24.04.{revision}'
                result = self.run_download(self.output, version)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls.read_text(),
                                 f'https://snapshot.ubuntu.com/ubuntu/{snapshot}T000000Z/'
                                 f'pool/main/a/apparmor/apparmor_{version}.dsc')
                self.assertEqual(list(self.output.iterdir()), [])
                self.assertNotIn('Downloaded verified', result.stdout)

    def test_default_preserves_revision_seven(self):
        result = self.run_download(self.output)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.calls.read_text().endswith('0ubuntu0.24.04.7.dsc'))
        self.assertEqual(list(self.output.iterdir()), [])

    def test_unknown_version_fails_before_network(self):
        for version in ('4.0.1really4.0.1-0ubuntu0.24.04.9', '', '../8'):
            with self.subTest(version=version):
                result = self.run_download(self.output, version)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.calls.exists())
                self.assertEqual(list(self.output.iterdir()), [])

    def test_nonempty_directory_is_preserved(self):
        existing = self.output / 'existing'
        existing.write_text('preserve me')
        result = self.run_download(self.output)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.calls.exists())
        self.assertEqual(existing.read_text(), 'preserve me')

    def test_symlink_directory_fails_before_network(self):
        link = self.root / 'link'
        link.symlink_to(self.output, target_is_directory=True)
        result = self.run_download(link)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.calls.exists())


if __name__ == '__main__':
    unittest.main()
