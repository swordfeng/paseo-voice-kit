import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_input', ROOT / 'scripts/fetch-build-input.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BuildInputsTest(unittest.TestCase):
    def test_https_transfer_keeps_checksum_and_cleans_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            record = {'file': 'sdk.exe', 'url': 'https://sdk.lunarg.com/fixture.exe', 'sha256': hashlib.sha256(b'verified').hexdigest()}
            def transfer(argv, **kwargs):
                self.assertEqual(argv[0], 'curl')
                self.assertEqual(argv[argv.index('--proto-redir') + 1], '=https')
                self.assertEqual(kwargs['timeout'], 420)
                Path(argv[argv.index('--output') + 1]).write_bytes(b'verified')
            with patch.object(module.subprocess, 'run', side_effect=transfer):
                self.assertEqual(module.fetch(record, Path(folder)).read_bytes(), b'verified')
            record['sha256'] = '0' * 64
            with patch.object(module.subprocess, 'run', side_effect=transfer):
                with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                    module.fetch(record, Path(folder) / 'invalid')
            self.assertFalse((Path(folder) / 'invalid/sdk.exe').exists())
            self.assertFalse((Path(folder) / 'invalid/sdk.exe.part').exists())

    def test_verified_cache_and_rejected_tampering(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            upstream = root / 'upstream'
            upstream.write_bytes(b'verified native fixture')
            record = {'file': 'fixture.tar.bz2', 'url': upstream.as_uri(), 'sha256': hashlib.sha256(upstream.read_bytes()).hexdigest()}
            target = module.fetch(record, root / 'cache')
            self.assertEqual(target.read_bytes(), upstream.read_bytes())
            target.write_bytes(b'corrupt cache')
            self.assertEqual(module.fetch(record, root / 'cache').read_bytes(), upstream.read_bytes())
            record['sha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                module.fetch(record, root / 'bad')
            self.assertFalse((root / 'bad/fixture.tar.bz2').exists())
            self.assertFalse((root / 'bad/fixture.tar.bz2.part').exists())

    def test_platforms_have_pinned_native_inputs(self):
        inputs = json.loads((ROOT / 'build/native-inputs.json').read_text())['inputs']
        for platform in ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']:
            self.assertIn('sherpa-' + platform, inputs)
        for name, record in inputs.items():
            self.assertRegex(record['sha256'], r'^[0-9a-f]{64}$', name)
            self.assertTrue(record['url'].startswith('https://'), name)
            self.assertNotIn('/latest', record['url'], name)


if __name__ == '__main__':
    unittest.main()
