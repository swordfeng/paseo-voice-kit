#!/usr/bin/env python3
"""Small chain-pull regression using stub engines and a local four-byte model fixture.
This is not a plugin installation test; it never touches the live installation.
Usage: python3 scripts/test-http-recovery.py [path/to/voicekit]
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request


def handshake(process, timeout=5):
    """The server's first stdout line, read on a thread: select() on pipes doesn't work on Windows."""
    box = {}
    reader = threading.Thread(target=lambda: box.setdefault('line', process.stdout.readline()), daemon=True)
    reader.start()
    reader.join(timeout)
    assert box.get('line'), 'no server handshake'
    return json.loads(box['line'])

root = Path(__file__).resolve().parents[1]
binary = sys.argv[1] if len(sys.argv) > 1 else str(root / ('server/target/release/voicekit' + ('.exe' if os.name == 'nt' else '')))
payload = b'tiny'
requests = []
class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append(self.path)
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *_):
        pass

fixture = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
thread = threading.Thread(target=fixture.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix='vk-http-recovery-') as temporary:
        folder = Path(temporary)
        def leaf(name):
            return dict(id=name, kind='tts', label=name, engine='sherpa', family='vits',
                        files={'model': 'model.onnx'},
                        download=[dict(url=f'http://127.0.0.1:{fixture.server_port}/{name}',
                                       sha256=hashlib.sha256(payload).hexdigest(), size=4, file='model.onnx')])
        catalog = dict(models=[leaf('custom-leaf-a'), leaf('custom-leaf-b'),
            dict(id='custom-chain', kind='tts', label='Fixture chain', engine='chain',
                 options=dict(chain=['custom-leaf-a', 'custom-leaf-b'],
                              personas=[dict(id='test', label='Test', gender='female', voices={'custom-leaf-a': 'voice', 'custom-leaf-b': 'voice'})]))])
        (folder / 'catalog.json').write_text(json.dumps(catalog))
        with (folder / 'stderr').open('w') as log:
            p = subprocess.Popen([binary, 'serve', '--stub', '--port', '0',
                '--models-dir', str(folder / 'models'), '--catalog', str(folder / 'catalog.json'),
                '--tts-model', 'custom-chain', '--coreml', 'false'],
                stdout=subprocess.PIPE, stderr=log, bufsize=0, env={**os.environ, 'VOICEKIT_TOKEN': 'test'})
            try:
                port = handshake(p)['port']
                def call(path, body=None):
                    req = urllib.request.Request(f'http://127.0.0.1:{port}'+path,
                        data=json.dumps(body).encode() if body is not None else None,
                        headers={'Authorization': 'Bearer test', 'Content-Type': 'application/json'})
                    with urllib.request.urlopen(req, timeout=3) as response:
                        return response.status, json.load(response)
                status, result = call('/voicekit/pull', {'id': 'custom-chain'})
                assert status == 202 and result['state'] == 'downloading', result
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    _, models = call('/voicekit/models')
                    chain = next(m for m in models['models'] if m['id'] == 'custom-chain')
                    if all(m['installed'] for m in models['models'] if m['id'] in ['custom-leaf-a', 'custom-leaf-b']):
                        break
                    time.sleep(0.05)
                assert chain['installed'], chain
                assert sorted(requests) == ['/custom-leaf-a', '/custom-leaf-b'], requests
                status, result = call('/voicekit/pull', {'id': 'custom-chain'})
                assert result['state'] == 'installed', result
                assert len(requests) == 2, 'installed chain downloaded again'
                print('PASS chain pull downloads both required leaves once and reports installed')
            finally:
                p.terminate()
                try:
                    p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
finally:
    fixture.shutdown()
    fixture.server_close()
