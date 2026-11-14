import { APPROXIMATE_LANGUAGES, QWEN_TTS_LANGUAGES, type Preferences } from "../shared/settings";
import { QWEN_VOICES } from "./mlx-models";

export const TTS_CHAIN_ID = "voicekit-tts-chain";
export const BUILTIN_VOICE_MODELS = new Set(["supertonic-3", "qwen3-tts-0.6b-gguf-q4", "qwen3-tts-1.7b-gguf-q8"]);
const SUPER_LANGUAGES = ["en","ko","ja","ar","bg","cs","da","de","el","es","et","fi","fr","hi","hr","hu","id","it","lt","lv","nl","pl","pt","ro","ru","sk","sl","sv","tr","uk","vi"];
const PERSONAS = [
  ["female-higher","Mia","female","F1","vivian"],
  ["female-medium","Lena","female","F3","serena"],
  ["female-lower","Nora","female","F5","sohee"],
  ["male-higher","Leo","male","M1","aiden"],
  ["male-medium","Kai","male","M4","ryan"],
  ["male-deep","Owen","male","M2","uncle_fu"],
];
export function effectiveTts(prefs: Preferences) {
  return { models: [...new Set(prefs.ttsModels)] };
}
type Entry = Record<string, unknown>;
export function voiceChainCatalog(prefs: Preferences, custom: Entry[]): Entry {
  const config=effectiveTts(prefs);
  const meta=(id:string):Entry|undefined => {
    const model=custom.find(m=>m.id===id);if(model)return model;
    if(id==="supertonic-3")return {id,family:"supertonic",languages:SUPER_LANGUAGES,default_voice:"F1"};
    if(id==="qwen3-tts-0.6b-gguf-q4" || id==="qwen3-tts-1.7b-gguf-q8")return {id,family:"qwen3_tts",languages:QWEN_TTS_LANGUAGES,voices:QWEN_VOICES,default_voice:"vivian"};
    return undefined;
  };
  const entries=config.models.map(id=>{const m=meta(id);if(!m)throw new Error("Unknown voice model: "+id);return m;});
  const languages=[...new Set(entries.flatMap(m=>Array.isArray(m.languages)?m.languages as string[]:[]))];
  const approximate=prefs.ttsApproximateLanguages;
  const modelVoices=prefs.modelVoices;
  return {
    id:TTS_CHAIN_ID,kind:"tts",engine:"chain",label:"Voice models",tier:"internal",uses:["voice_output"],languages,
    options:{
      chain:config.models,
      language_models:prefs.ttsLanguageModels, model_voices:modelVoices,
      approximate_languages:approximate.filter(l=>l in APPROXIMATE_LANGUAGES),
      personas:PERSONAS.map(([id,label,gender,st,qwen])=>({id,label,gender,voices:Object.fromEntries(entries.map(m=>[
        m.id, m.family==="supertonic"?st:m.family==="qwen3_tts"?qwen:m.default_voice??"",
      ]))})),
    },
  };
}
