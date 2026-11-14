#!/usr/bin/env python3
"""Build the pinned, offline Qwen worker beside voicekit, isolated from Whisper's GGML."""
import argparse, hashlib, json, os, pathlib, platform, re, shutil, subprocess, tarfile
p=argparse.ArgumentParser();p.add_argument('--target-dir',required=True);p.add_argument('--vulkan',action='store_true');args=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];dest=pathlib.Path(args.target_dir).resolve()/'gguf-runtime'
work=root/'server'/'target'/'qwen-worker';sources=work/'sources';sources.mkdir(parents=True,exist_ok=True)
manifest=json.loads((root/'server/vendor/qwen-sources/SOURCES.json').read_text())
for name,record in manifest.items():
 archive=root/'server/vendor/qwen-sources'/name
 if hashlib.sha256(archive.read_bytes()).hexdigest()!=record['sha256']:raise RuntimeError('source checksum mismatch: '+name)
 folder=sources/('qwentts' if name.startswith('qwentts') else 'ggml')
 stamp=folder/'.voicekit-source-sha'
 if not stamp.exists() or stamp.read_text()!=record['sha256']:
  if folder.exists():shutil.rmtree(folder)
  folder.mkdir()
  with tarfile.open(archive) as t:
   for member in t.getmembers():
    pieces=pathlib.PurePosixPath(member.name).parts[1:]
    if not pieces:continue
    if '..' in pieces or member.issym() or member.islnk():raise RuntimeError('unsafe source archive member')
    member.name='/'.join(pieces);t.extract(member,folder,filter='data')
  stamp.write_text(record['sha256'])
build=work/'build';darwin=platform.system()=='Darwin'
cmd=['cmake','-S',str(root/'server/qwen-worker'),'-B',str(build),'-DQWEN_SOURCE_DIR='+str(sources/'qwentts'),'-DGGML_SOURCE_DIR='+str(sources/'ggml'),'-DCMAKE_BUILD_TYPE=Release','-DGGML_NATIVE=OFF','-DGGML_METAL='+('ON' if darwin else 'OFF'),'-DGGML_METAL_EMBED_LIBRARY=OFF','-DBUILD_SHARED_LIBS=ON','-DGGML_VULKAN='+('ON' if args.vulkan else 'OFF')]
if not darwin:cmd+=['-DGGML_BACKEND_DL=ON','-DGGML_CPU_ALL_VARIANTS=ON']
if platform.system()=='Windows':cmd+=['-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded','-DGGML_OPENMP=OFF']
subprocess.run(cmd,check=True)
subprocess.run(['cmake','--build',str(build),'--config','Release','--target','voicekit-qwen-worker','-j',os.environ.get('CMAKE_BUILD_PARALLEL_LEVEL','8')],check=True)
dest.mkdir(parents=True,exist_ok=True)
names=['voicekit-qwen-worker','voicekit-qwen-worker.exe','ggml-common.h','ggml-metal-impl.h']
copied=set()
def runtime_name(source):
 # Copy the dynamic loader's name once, not the versioned file and both symlink aliases.
 if darwin and '.dylib' in source.name:
  lines=subprocess.check_output(['otool','-D',str(source)],text=True).splitlines()
  return pathlib.Path(lines[1].strip()).name if len(lines)>1 else source.name
 if not darwin and '.so' in source.name:
  info=subprocess.check_output(['readelf','-d',str(source)],text=True)
  match=re.search(r'\(SONAME\).*\[([^\]]+)\]',info)
  return match[1] if match else source.name
 return source.name
for source in build.rglob('*'):
 if not source.is_file():continue
 name=source.name
 if name in names or name.startswith('libggml') and ('.dylib' in name or '.so' in name) or name.endswith('.dll') and 'ggml' in name:
  # Multi-config and single-config generators put binaries in different folders.
  if name not in copied and runtime_name(source)==name:shutil.copy2(source,dest/name);copied.add(name)
 # Metal sources are deployed as data; no user-side compiler toolchain is needed.
 if source.parent.name=='kernels' and source.suffix in {'.metal','.h'}:
  (dest/'kernels').mkdir(exist_ok=True);shutil.copy2(source,dest/'kernels'/name)
if not any((dest/n).exists() for n in names[:2]):raise RuntimeError('Qwen worker executable missing')
for stale in dest.iterdir():
 if stale.is_file() and stale.name.startswith('libggml') and stale.name not in copied:stale.unlink()
notice=dest/'notices';notice.mkdir(exist_ok=True)
for label,source in [('qwentts',sources/'qwentts'),('ggml',sources/'ggml')]:
 for name in ['LICENSE','LICENSE.txt']:
  if (source/name).exists():shutil.copy2(source/name,notice/(label+'-LICENSE'));break
shutil.copy2(root/'licenses/yyjson-MIT.txt',notice/'yyjson-LICENSE')
shutil.copy2(root/'server/vendor/qwen-sources/SOURCES.json',notice/'SOURCES.json')
print('Built Qwen worker: '+str(dest))
