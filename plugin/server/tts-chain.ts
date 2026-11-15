import { APPROXIMATE_LANGUAGES, QWEN_TTS_LANGUAGES, modelVoice, type Preferences } from "../shared/settings";
import { QWEN_VOICES } from "./mlx-models";

export const TTS_CHAIN_ID = "voicekit-tts-chain";
export const BUILTIN_VOICE_MODELS = new Set(["supertonic-3", "qwen3-tts-0.6b-gguf-q4", "qwen3-tts-1.7b-gguf-q8"]);
const SUPER_LANGUAGES = ["en","ko","ja","ar","bg","cs","da","de","el","es","et","fi","fr","hi","hr","hu","id","it","lt","lv","nl","pl","pt","ro","ru","sk","sl","sv","tr","uk","vi"];
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
  // Each enabled model's own voice; no pairing across models.
  const modelVoices=Object.fromEntries(entries.flatMap(m=>{const v=modelVoice(prefs,String(m.id),m.family as string|undefined);return v?[[String(m.id),v]]:[];}));
  return {
    id:TTS_CHAIN_ID,kind:"tts",engine:"chain",label:"Voice models",tier:"internal",uses:["voice_output"],languages,
    options:{
      chain:config.models,
      language_models:prefs.ttsLanguageModels, model_voices:modelVoices,
      approximate_languages:approximate.filter(l=>l in APPROXIMATE_LANGUAGES),
    },
  };
}
