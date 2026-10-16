import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/install-cargo-c.sh'


class CargoCInstallTests(unittest.TestCase):
    def test_isolated_cache_states(self):
        for state in ('missing', 'pinned', 'wrong-version', 'partial'):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                tools = root / 'global-bin'
                tools.mkdir()
                target = root / 'isolated'
                (target / 'bin').mkdir(parents=True)
                calls = root / 'calls'
                for tool in ('cargo-capi', 'cargo-cbuild', 'cargo-cinstall'):
                    global_tool = tools / tool
                    global_tool.write_text('#!/bin/sh\nexit 99\n')
                    global_tool.chmod(0o755)
                    if state != 'missing' and not (state == 'partial' and tool == 'cargo-capi'):
                        binary = target / 'bin' / tool
                        version = '0.1.0' if state == 'wrong-version' else '0.10.24+cargo-0.98.0'
                        binary.write_text(f'#!/bin/sh\necho "cargo-c {version}"\n')
                        binary.chmod(0o755)
                cargo = tools / 'cargo'
                cargo.write_text('''#!/usr/bin/env python3
import os, pathlib, sys
args = sys.argv[1:]
assert args[:2] == ['install', 'cargo-c']
assert '--locked' in args and '--force' in args
assert args[args.index('--version') + 1] == '=0.10.24'
root = pathlib.Path(args[args.index('--root') + 1])
assert root == pathlib.Path(os.environ['EXPECTED_ROOT'])
pathlib.Path(os.environ['CALLS']).write_text('installed')
for tool in ('cargo-capi', 'cargo-cbuild', 'cargo-cinstall'):
    binary = root / 'bin' / tool
    binary.write_text('#!/bin/sh\\necho "cargo-c 0.10.24+cargo-0.98.0"\\n')
    binary.chmod(0o755)
''')
                cargo.chmod(0o755)
                result = subprocess.run(
                    ['bash', str(SCRIPT), str(target), '0.10.24'],
                    env={**os.environ, 'PATH': f'{tools}:{os.environ["PATH"]}',
                         'EXPECTED_ROOT': str(target), 'CALLS': str(calls)},
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls.exists(), state != 'pinned')


if __name__ == '__main__':
    unittest.main()
