#!/usr/bin/env python3
"""Fetch a checked-in native build input, verifying SHA-256 before it may be used.

Prints the verified filename. Never executes or extracts it. Existing local build caches can
be supplied with --source so a verified archive does not need to be downloaded again.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def fetch(record, directory, source=None):
    name, expected = record['file'], record['sha256']
    if Path(name).name != name or len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected):
        raise ValueError('Invalid pinned build input')
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    if target.is_file() and digest(target) == expected:
        return target.resolve()
    temporary = target.with_name(target.name + '.part')
    try:
        if source and source.is_file() and digest(source) == expected:
            shutil.copyfile(source, temporary)
        elif record['url'].startswith('https://'):
            # The SDK CDN rejects Python's HTTP client on hosted Windows runners. Use the
            # platform's curl, keeping redirects HTTPS-only and still checking the pinned hash.
            subprocess.run([
                'curl', '--fail', '--silent', '--show-error', '--location',
                '--proto', '=https', '--proto-redir', '=https', '--retry', '2',
                '--connect-timeout', '15', '--max-time', '300',
                '--output', str(temporary), record['url'],
            ], check=True, timeout=420)
        else:
            with urllib.request.urlopen(record['url'], timeout=30) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
        if digest(temporary) != expected:
            raise ValueError('SHA-256 mismatch for ' + name)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target.resolve()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('key')
    parser.add_argument('directory', type=Path)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--manifest', type=Path, default=Path(__file__).resolve().parents[1] / 'build/native-inputs.json')
    args = parser.parse_args()
    try:
        record = json.loads(args.manifest.read_text())['inputs'][args.key]
        print(fetch(record, args.directory, args.source))
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
