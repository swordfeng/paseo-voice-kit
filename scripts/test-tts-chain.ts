import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preferencesSchema } from "../plugin/shared/settings";
import { effectiveTts, voiceChainCatalog } from "../plugin/server/tts-chain";
import { catalogEntry, writeCustomCatalog } from "../plugin/server/custom-models";
import { suggest } from "../plugin/server/huggingface";

const defaults=preferencesSchema.parse({});
const fresh=voiceChainCatalog(defaults,[])!;
assert.deepEqual((fresh.options as any).chain,["supertonic-3"]);
assert.equal(fresh.engine,"chain");
assert.equal((fresh.languages as string[]).length,31);
assert(!(fresh.languages as string[]).includes("zh"));
const pair=voiceChainCatalog({...defaults,ttsModels:["supertonic-3","qwen3-tts-0.6b-gguf-q4"]},[])!;
assert.equal((pair.languages as string[]).length,32);
assert.deepEqual((pair.options as any).chain,["supertonic-3","qwen3-tts-0.6b-gguf-q4"]);
const empty=voiceChainCatalog({...defaults,ttsModels:[]},[])!;
assert.deepEqual((empty.options as any).chain,[]);
const model="qwen-talker-0.6b-customvoice-Q4_K_M.gguf",codec="qwen-tokenizer-12hz-Q4_K_M.gguf";
const suggestion=suggest({repo:"owner/qwen3-tts",revision:"a".repeat(40),files:[model,codec,"evil.py"].map(path=>({path,size:1,sha256:"b".repeat(64)}))});
assert.equal(suggestion.source,"gguf");assert.deepEqual(suggestion.ggufModelFiles,[model]);assert.deepEqual(suggestion.ggufCodecFiles,[codec]);
const folder=await mkdtemp(join(tmpdir(),"vk-gguf-custom-"));
try {
 await writeFile(join(folder,model),"GGUF fixture");await writeFile(join(folder,codec),"GGUF fixture");
 const entry=await catalogEntry({id:"custom-gguf",label:"fixture",kind:"tts",source:"sherpa",family:"qwen3_tts_gguf",location:folder});
 assert.equal(entry?.engine,"gguf");assert.deepEqual(entry?.files,{model,codec});assert.equal((entry?.languages as string[]).length,10);
 await writeFile(join(folder,"qwen-talker-1.7b-customvoice-Q8_0.gguf"),"GGUF fixture");
 await assert.rejects(()=>catalogEntry({id:"custom-gguf",label:"fixture",kind:"tts",source:"sherpa",family:"qwen3_tts_gguf",location:folder}),/exactly one/);
} finally {await rm(folder,{recursive:true});}
const home=await mkdtemp(join(tmpdir(),"vk-unavailable-custom-"));
const oldHome=process.env.PASEO_HOME;
process.env.PASEO_HOME=home;
try {
 const missing=join(home,"moved-model");
 const custom={id:"missing-custom",label:"fixture",kind:"tts" as const,source:"sherpa" as const,family:"qwen3_tts_gguf",location:missing};
 const prefs={...defaults,ttsModels:[custom.id],customModels:[custom]};
 let written=await writeCustomCatalog(prefs.customModels,prefs);
 let entries=JSON.parse(await readFile(written.path,"utf8")).models;
 assert.equal(written.ttsModel,"voicekit-tts-chain");
 assert.deepEqual(entries.find((e:any)=>e.id===written.ttsModel).options.chain,[custom.id]);
 const bad=entries.find((e:any)=>e.id===custom.id);
 assert(bad.options.unavailable.includes("ENOENT"));assert.equal(bad.download,undefined);
 assert(!entries.some((e:any)=>e.id==="supertonic-3"));
 await mkdir(missing);await writeFile(join(missing,model),"GGUF fixture");await writeFile(join(missing,codec),"GGUF fixture");
 written=await writeCustomCatalog(prefs.customModels,prefs);
 entries=JSON.parse(await readFile(written.path,"utf8")).models;
 assert.equal(entries.find((e:any)=>e.id===custom.id).engine,"gguf");
 assert.equal(entries.find((e:any)=>e.id===custom.id).options?.unavailable,undefined);
 written=await writeCustomCatalog([],{...defaults,ttsModels:["removed-custom"]});
 entries=JSON.parse(await readFile(written.path,"utf8")).models;
 assert.equal(entries[0].id,"removed-custom");assert(entries[0].options.unavailable);
 console.log("PASS missing/unknown custom voice remains configured without enabling downloads; rescan recovers repaired folder");
} finally {
 if(oldHome===undefined)delete process.env.PASEO_HOME;else process.env.PASEO_HOME=oldHome;
 await rm(home,{recursive:true});
}
console.log("PASS default download scope, ordered voice configuration, GGUF recognition and explicit model-pair selection");
