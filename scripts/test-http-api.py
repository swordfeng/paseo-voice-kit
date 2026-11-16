#!/usr/bin/env python3
"""HTTP surface checks with stub engines: loopback Host, bearer token, OpenAI-shaped errors,
undecodable audio, silence without an installed model, and removal during a download.
Uses a temporary models folder and a local slow download; never touches the live installation.
Usage: python3 scripts/test-http-api.py [path/to/voicekit]
"""
import http.client
import http.server
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time


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
release = threading.Event()


class SlowFixture(http.server.BaseHTTPRequestHandler):
    """Sends headers, then nothing until the test is done: a download stays in progress."""
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', '4')
        self.end_headers()
        release.wait(20)
        try:
            self.wfile.write(b'tiny')
        except OSError:
            pass

    def log_message(self, *_):
        pass


def wav(samples):
    data = struct.pack('<%dh' % len(samples), *samples)
    return b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 16000, 32000, 2, 16) + b'data' + struct.pack('<I', len(data)) + data


def multipart(fields, file_bytes, file_name):
    boundary = 'vkboundary'
    body = b''
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file_name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + file_bytes + b'\r\n'
    body += f'--{boundary}--\r\n'.encode()
    return body, f'multipart/form-data; boundary={boundary}'


failures = 0


def check(name, ok, extra=None):
    global failures
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f' {extra!r}'))
    if not ok:
        failures += 1


fixture = http.server.ThreadingHTTPServer(('127.0.0.1', 0), SlowFixture)
threading.Thread(target=fixture.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='vk-http-api-') as temporary:
    folder = Path(temporary)
    slow = dict(id='custom-slow', kind='tts', label='Slow', engine='sherpa', family='vits', files={'model': 'model.onnx'},
                download=[dict(url=f'http://127.0.0.1:{fixture.server_port}/slow', size=4, file='model.onnx')])
    (folder / 'catalog.json').write_text(json.dumps(dict(models=[slow])))
    with (folder / 'stderr').open('w') as log:
        p = subprocess.Popen([binary, 'serve', '--stub', '--port', '0', '--models-dir', str(folder / 'models'),
                              '--catalog', str(folder / 'catalog.json'), '--coreml', 'false'],
                             stdout=subprocess.PIPE, stderr=log, bufsize=0, env={**os.environ, 'VOICEKIT_TOKEN': 'test'})
        try:
            port = handshake(p)['port']

            def call(method, path, body=None, headers=None, token='test', host=None):
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                h = dict(headers or {})
                if token:
                    h['Authorization'] = 'Bearer ' + token
                if host:
                    h['Host'] = host
                connection.request(method, path, body=body, headers=h)
                response = connection.getresponse()
                raw = response.read()
                try:
                    data = json.loads(raw)
                except ValueError:
                    data = raw
                return response.status, data

            def code(data):
                return data.get('error', {}).get('code') if isinstance(data, dict) else None

            # API-1: only loopback hosts, also on unknown routes.
            status, data = call('GET', '/voicekit/status', host='evil.example')
            check('API-1 a non-loopback Host is refused', status == 421 and code(data) == 'invalid_host', (status, data))
            status, data = call('GET', '/no/such/route', host='evil.example:80')
            check('API-1 unknown routes get the loopback check too', status == 421, (status, data))
            # API-2: the bearer token, except for /health.
            status, data = call('GET', '/voicekit/status', token=None)
            check('API-2 no token is 401', status == 401 and code(data) == 'invalid_api_key', (status, data))
            status, data = call('GET', '/voicekit/status', token='wrong')
            check('API-2 a wrong token is 401', status == 401, (status, data))
            status, _ = call('GET', '/health', token=None)
            check('API-2 /health needs no token', status == 200, status)
            # API-3: OpenAI-shaped errors, including malformed requests.
            status, data = call('GET', '/no/such/route')
            check('API-3 an unknown route is a JSON 404', status == 404 and code(data) == 'not_found', (status, data))
            status, data = call('POST', '/voicekit/pull', body=b'not json', headers={'Content-Type': 'application/json'})
            check('API-3 a malformed pull is a JSON 4xx', 400 <= status < 500 and code(data) == 'invalid_request', (status, data))
            status, data = call('POST', '/v1/audio/speech', body=json.dumps({'input': 'hello'}), headers={'Content-Type': 'application/json'})
            check('API-3 speech without response_format names pcm and wav', status == 400 and 'pcm' in data['error']['message'], (status, data))
            status, data = call('POST', '/v1/audio/transcriptions', body=b'{}', headers={'Content-Type': 'application/json'})
            check('API-3 a transcription that is not multipart is a JSON 4xx', 400 <= status < 500 and code(data) == 'invalid_request', (status, data))
            # STT-8: undecodable audio is the request's fault; silence needs an installed model.
            body, kind = multipart({'model': 'sensevoice-int8'}, b'definitely not audio', 'clip.wav')
            status, data = call('POST', '/v1/audio/transcriptions', body=body, headers={'Content-Type': kind})
            check('STT-8 undecodable audio is 400 invalid_audio', status == 400 and code(data) == 'invalid_audio', (status, data))
            body, kind = multipart({'model': 'sensevoice-int8'}, wav([0] * 16000), 'silence.wav')
            status, data = call('POST', '/v1/audio/transcriptions', body=body, headers={'Content-Type': kind})
            check('STT-8 silence is not answered without an installed model', status == 503, (status, data))
            # DL-6: removal is refused while the model downloads.
            status, data = call('POST', '/voicekit/pull', body=json.dumps({'id': 'custom-slow'}), headers={'Content-Type': 'application/json'})
            check('DL-6 the slow download starts', status == 202, (status, data))
            time.sleep(0.3)
            status, data = call('DELETE', '/voicekit/models/custom-slow')
            check('DL-6 removing a downloading model is 409 download_in_progress', status == 409 and code(data) == 'download_in_progress', (status, data))
            status, data = call('POST', '/voicekit/pull', body=json.dumps({'id': 'custom-slow'}), headers={'Content-Type': 'application/json'})
            check('DL-6 pulling it again starts nothing new', status == 200 and data.get('state') == 'downloading', (status, data))
        finally:
            release.set()
            p.terminate()
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
fixture.shutdown()
print('all passed' if not failures else f'{failures} FAILED')
sys.exit(1 if failures else 0)
