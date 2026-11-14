import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mlxFiles, suggest } from '../plugin/server/huggingface';
import { catalogEntry } from '../plugin/server/custom-models';
import { qwenMetadata } from '../plugin/server/mlx-models';
const files = ['config.json','model.safetensors','speech_tokenizer/model.safetensors','README.md','evil.py','speech_tokenizer/../evil.json'].map(path=>({path,size:1,sha256:'a'.repeat(64)}));
assert.deepEqual(mlxFiles(files).map(f=>f.path),['config.json','model.safetensors','speech_tokenizer/model.safetensors']);
assert.equal(suggest({repo:'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit',revision:'a'.repeat(40),files}).source,'mlx');
assert.equal(suggest({repo:'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-4bit',revision:'a'.repeat(40),files}).source,null);
assert.throws(()=>qwenMetadata(Buffer.from('{"model_type":"qwen3_tts","tts_model_type":"base"}'),files));
const folder = await mkdtemp(join(tmpdir(),'vk-custom-mlx-'));
try {
 await mkdir(join(folder,'speech_tokenizer'));
 await writeFile(join(folder,'config.json'),JSON.stringify({model_type:'qwen3_tts',tts_model_type:'custom_voice',tts_model_size:'1b7',quantization:{bits:4}}));
 await writeFile(join(folder,'model.safetensors'),'fixture');
 await writeFile(join(folder,'speech_tokenizer/model.safetensors'),'fixture');
 const entry = await catalogEntry({id:'custom-qwen-test',label:'Qwen fixture',kind:'tts',source:'sherpa',family:'qwen3_tts',location:folder});
 assert.equal(entry?.engine,'mlx');assert.equal(entry?.path,folder);
 assert.equal((entry?.voices as unknown[]).length,9);
 assert.equal((entry?.languages as string[]).length,10);
 console.log('PASS MLX custom folder, weights filter, repository suggestion, preset metadata and unsupported Base rejection');
} finally { await rm(folder,{recursive:true}); }
