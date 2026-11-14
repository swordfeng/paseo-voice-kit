"""Bounded CPU/CoreML check, using existing models and one FLEURS clip.

Usage: python3 -I scripts/eval/quick_provider.py <cpu|coreml> <output-dir>
Creates its own server, never downloads, and terminates it on exit. At most 45 s
to load and 15 s per request; three measured requests after one warm-up.
"""
import argparse
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stt_eval import transcribe

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('provider', choices=['cpu', 'coreml'])
parser.add_argument('output')
parser.add_argument('--data', default='/tmp/vk-eval/fleurs')
parser.add_argument('--models-dir', default='/tmp/vk-eval/models')
parser.add_argument('--model', default='sensevoice-int8')
args = parser.parse_args()
provider, output = args.provider, args.output
root = Path(__file__).resolve().parents[2]
out = Path(output)
out.mkdir(parents=True, exist_ok=True)
log = (out / (provider + '.log')).open('w')
command = [str(root / 'server/target/release/voicekit'), 'serve', '--port', '0',
           '--models-dir', args.models_dir, '--reuse-dir', str(Path.home() / '.paseo/plugin-data/voice-kit/models'),
           '--reuse-dir', str(Path.home() / '.paseo/models/local-speech'),
           '--stt-model', args.model, '--tts-model', 'supertonic-3',
           '--onnx-provider', provider, '--coreml', 'false', '--language', 'request']
p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log, bufsize=0, env={**os.environ, 'VOICEKIT_TOKEN': 'eval'})
result = {'requested_provider': provider, 'samples_ms': []}
try:
    deadline = time.monotonic() + 45
    port = None
    while time.monotonic() < deadline:
        if select.select([p.stdout], [], [], 0.25)[0]:
            line = p.stdout.readline()
            if not line:
                raise RuntimeError('server exited')
            message = json.loads(line)
            port = message.get('port', port)
            if message.get('event') == 'warm':
                break
    else:
        raise TimeoutError('45 s load budget exceeded')
    clips = [json.loads(l) for l in (Path(args.data) / 'manifest.jsonl').read_text().splitlines()]
    clip = next(c for c in clips if c['lang'] == 'en')
    url = f'http://127.0.0.1:{port}'
    for i in range(4):
        hyp, ms, stages = transcribe(url, 'eval', args.model, str(Path(args.data) / clip['file']), timeout=15)
        if i:
            result['samples_ms'].append(ms)
        result['hypothesis'] = hyp
    result['clip'] = clip['file']
except Exception as error:
    result['error'] = str(error)
finally:
    p.terminate()
    try:
        p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
    log.close()
    result['cpu_fallback_logged'] = 'Fallback to cpu' in (out / (provider + '.log')).read_text()
    (out / (provider + '.json')).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
