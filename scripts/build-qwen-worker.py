#!/usr/bin/env python3
"""Build the pinned, offline Qwen worker beside voicekit, isolated from Whisper's GGML."""
import argparse, hashlib, json, os, pathlib, platform, re, shutil, subprocess, tarfile, tempfile
p=argparse.ArgumentParser();p.add_argument('--target-dir',required=True);p.add_argument('--vulkan',action='store_true');args=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];dest=pathlib.Path(args.target_dir).resolve()/'gguf-runtime'
work=root/'server'/'target'/'qwen-worker';sources=work/'sources';sources.mkdir(parents=True,exist_ok=True)
manifest=json.loads((root/'server/vendor/qwen-sources/SOURCES.json').read_text())
# Sources are patched below, so a change to this script extracts them again.
script_id=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()[:16]
for name,record in manifest.items():
 archive=root/'server/vendor/qwen-sources'/name
 if hashlib.sha256(archive.read_bytes()).hexdigest()!=record['sha256']:raise RuntimeError('source checksum mismatch: '+name)
 folder=sources/('qwentts' if name.startswith('qwentts') else 'ggml')
 stamp=folder/'.voicekit-source-sha'
 if not stamp.exists() or stamp.read_text()!=record['sha256']+' '+script_id:
  if folder.exists():shutil.rmtree(folder)
  folder.mkdir()
  with tarfile.open(archive) as t:
   for member in t.getmembers():
    pieces=pathlib.PurePosixPath(member.name).parts[1:]
    if not pieces:continue
    if '..' in pieces or member.issym() or member.islnk():raise RuntimeError('unsafe source archive member')
    member.name='/'.join(pieces);t.extract(member,folder,filter='data')
  stamp.write_text(record['sha256']+' '+script_id)
# Expose a private count adapter inside the pinned tokenizer's translation unit.
# The source archive stays intact; the adapter is copied into generated sources.
adapter=root/'server/qwen-worker/token-count.inc'
shutil.copy2(adapter,sources/'qwentts/src/voicekit-token-count.inc')
source=sources/'qwentts/src/qwen.cpp'
include='\n#include "voicekit-token-count.inc"\n'
if include not in source.read_text():source.write_text(source.read_text()+include)
# WSL's Dozen driver (Vulkan on D3D12) can't create ggml's argsort_large pipelines, which use
# the Vulkan memory model (workgroupcoherent buffers, scoped barriers), so the worker aborted
# on its first request: Qwen sorts its 2048-entry sampling logits in a graph run directly on
# the GPU. Build a second variant with plain coherent buffers and barrier() (GLSL 450
# semantics) and use it on Dozen only; every other driver keeps the upstream shader.
def patch(path,edits):
 text=path.read_text(encoding='utf8')
 for old,new in edits:
  if new in text:continue
  if text.count(old)!=1:raise RuntimeError('Dozen patch no longer matches '+path.name+': '+old[:60])
  text=text.replace(old,new)
 path.write_text(text,encoding='utf8')
vk=sources/'ggml/src/ggml-vulkan'
patch(vk/'vulkan-shaders/argsort_large.comp',[
 ('#extension GL_KHR_memory_scope_semantics : enable\n#pragma use_vulkan_memory_model\n',
  '#ifndef ARGSORT_COMPAT\n#extension GL_KHR_memory_scope_semantics : enable\n#pragma use_vulkan_memory_model\n#define ARGSORT_COHERENT workgroupcoherent\n#define ARGSORT_BARRIER() controlBarrier(gl_ScopeWorkgroup, gl_ScopeWorkgroup, gl_StorageSemanticsBuffer, gl_SemanticsAcquireRelease)\n#else\n// voicekit: without the Vulkan memory model, for drivers that cannot build it (WSL Dozen).\n#define ARGSORT_COHERENT coherent\n#define ARGSORT_BARRIER() memoryBarrierBuffer(); barrier()\n#endif\n'),
 ('layout (binding = 1) workgroupcoherent buffer B','layout (binding = 1) ARGSORT_COHERENT buffer B'),
 ('layout (binding = 2) workgroupcoherent buffer D','layout (binding = 2) ARGSORT_COHERENT buffer D'),
 ('            if (need_barrier) {\n                controlBarrier(gl_ScopeWorkgroup, gl_ScopeWorkgroup, gl_StorageSemanticsBuffer, gl_SemanticsAcquireRelease);','            if (need_barrier) {\n                ARGSORT_BARRIER();'),
 ('        p.inner_end >= p.ncols_padded_log2 + 1) {\n        controlBarrier(gl_ScopeWorkgroup, gl_ScopeWorkgroup, gl_StorageSemanticsBuffer, gl_SemanticsAcquireRelease);','        p.inner_end >= p.ncols_padded_log2 + 1) {\n        ARGSORT_BARRIER();'),
])
patch(vk/'vulkan-shaders/vulkan-shaders-gen.cpp',[
 ('    string_to_spv("argsort_large_f32", "argsort_large.comp", {{"A_TYPE", "float"}});\n',
  '    string_to_spv("argsort_large_f32", "argsort_large.comp", {{"A_TYPE", "float"}});\n    string_to_spv("argsort_large_compat_f32", "argsort_large.comp", {{"A_TYPE", "float"}, {"ARGSORT_COMPAT", "1"}}); // voicekit: Dozen\n'),
])
patch(vk/'ggml-vulkan.cpp',[
 ('"argsort_large_f32_"+std::to_string(i), argsort_large_f32_len, argsort_large_f32_data,',
  '"argsort_large_f32_"+std::to_string(i), /* voicekit: Dozen */ device->driver_id == vk::DriverId::eMesaDozen ? argsort_large_compat_f32_len : argsort_large_f32_len, device->driver_id == vk::DriverId::eMesaDozen ? argsort_large_compat_f32_data : argsort_large_f32_data,'),
])
build=work/'build';darwin=platform.system()=='Darwin'
# Windows: CMake's try-compile object paths under a deep checkout exceed the 250-character limit
# (CMAKE_OBJECT_PATH_MAX), so build in a short per-checkout folder instead (or VOICEKIT_QWEN_BUILD_DIR).
if os.environ.get('VOICEKIT_QWEN_BUILD_DIR'):build=pathlib.Path(os.environ['VOICEKIT_QWEN_BUILD_DIR'])
elif platform.system()=='Windows' and len(str(build))>60:build=pathlib.Path(tempfile.gettempdir())/('vkqw-'+hashlib.sha256(str(root).encode()).hexdigest()[:8])
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
shutil.copy2(adapter,notice/adapter.name)
shutil.copy2(root/'licenses/yyjson-MIT.txt',notice/'yyjson-LICENSE')
shutil.copy2(root/'server/vendor/qwen-sources/SOURCES.json',notice/'SOURCES.json')
print('Built Qwen worker: '+str(dest))
