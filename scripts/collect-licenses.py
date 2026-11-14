#!/usr/bin/env python3
"""Collect notices for a native release, using cargo metadata from its actual build.

Usage: collect-licenses.py <cargo-metadata.json> <new-output-directory>
Copies upstream copyright/license files and includes unmodified MPL-covered
crate sources, so recipients receive their covered source with the executable.
No downloads or third-party code execution.
"""
import json
from pathlib import Path
import shutil
import sys

metadata, output = Path(sys.argv[1]), Path(sys.argv[2])
project = Path(__file__).resolve().parents[1]
output.mkdir(parents=True, exist_ok=False)
for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
    shutil.copy2(project / name, output / name)
shutil.copytree(project / 'licenses', output / 'licenses')
shutil.copytree(project / 'plugin/licenses/models', output / 'licenses/models')
shutil.copy2(project / 'plugin/MODEL_LICENSES.md', output / 'MODEL_LICENSES.md')
rows, missing = [], []
for package in sorted(json.loads(metadata.read_text(encoding='utf-8'))['packages'], key=lambda p: (p['name'], p['version'])):
    if package['name'] == 'voicekit':
        continue
    name, version = package['name'], package['version']
    source = Path(package['manifest_path']).parent
    destination = output / 'licenses/rust' / (name + '-' + version)
    destination.mkdir(parents=True)
    files = [p for p in source.rglob('*') if p.is_file() and not p.is_symlink()
             and p.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'AUTHORS'))]
    if package.get('license_file'):
        explicit = source / package['license_file']
        if explicit.is_file() and explicit not in files:
            files.append(explicit)
    for path in files:
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    license_id = package.get('license') or 'see upstream notices'
    if 'MPL-2.0' in license_id:
        shutil.copy2(project / 'licenses/MPL-2.0.txt', destination / 'LICENSE-MPL-2.0.txt')
        covered = output / 'sources' / (name + '-' + version)
        shutil.copytree(source, covered, ignore=shutil.ignore_patterns('.cargo-ok', 'target', '.git'))
    elif not files and name == 'whatlang':
        shutil.copy2(project / 'licenses/whatlang-MIT.txt', destination / 'LICENSE')
    elif not files and name == 'wsola' and version == '0.3.0' and license_id == 'MIT':
        shutil.copy2(project / 'licenses/wsola-MIT.txt', destination / 'LICENSE-MIT.txt')
        shutil.copy2(project / 'licenses/wsola-upstream-Apache-2.0.txt', destination / 'LICENSE-upstream-Apache-2.0.txt')
        shutil.copy2(source / 'Cargo.toml.orig', destination / 'Cargo.toml.orig')
    elif not files:
        missing.append(name + '-' + version)
    url = package.get('repository') or f'https://crates.io/crates/{name}/{version}'
    rows.append(f'| {name} {version} | {license_id} | {url} |')
if missing:
    raise SystemExit('Missing upstream notices: ' + ', '.join(missing))
(output / 'RUST_DEPENDENCIES.md').write_text(
    '# Rust dependency notices\n\n'
    'Generated from the release build metadata. This includes build dependencies as well as runtime libraries.\n'
    'Original notice files are under `licenses/rust/`. Unmodified MPL-covered sources are under `sources/`.\n\n'
    '| Package | License expression | Upstream |\n| --- | --- | --- |\n' + '\n'.join(rows) + '\n', encoding='utf-8')
print(f'Collected notices for {len(rows)} Rust packages, plus native dependencies')
