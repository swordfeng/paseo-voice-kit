import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class LicenseCollectionTest(unittest.TestCase):
    def test_non_ascii_metadata_and_notices_use_explicit_utf8(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            source = work / 'dependency'
            source.mkdir()
            (source / 'LICENSE').write_text('Copyright 用户\nMIT\n', encoding='utf-8')
            metadata = work / 'metadata.json'
            metadata.write_text(json.dumps({'packages': [{
                'name': 'fixture', 'version': '1.0', 'license': 'MIT',
                'manifest_path': str(source / 'Cargo.toml'),
                'repository': 'https://example.com/用户',
            }]}, ensure_ascii=False), encoding='utf-8')
            env = {**os.environ, 'PYTHONWARNDEFAULTENCODING': '1',
                   'PYTHONWARNINGS': 'error::EncodingWarning'}
            output = work / 'notices'
            subprocess.run([sys.executable, str(ROOT / 'scripts/collect-licenses.py'),
                            str(metadata), str(output)], env=env,
                           check=True, capture_output=True, timeout=10)
            text = (output / 'RUST_DEPENDENCIES.md').read_text(encoding='utf-8')
            self.assertIn('https://example.com/用户', text)
            self.assertEqual((output / 'licenses/rust/fixture-1.0/LICENSE').read_bytes(),
                             (source / 'LICENSE').read_bytes())


if __name__ == '__main__':
    unittest.main()
