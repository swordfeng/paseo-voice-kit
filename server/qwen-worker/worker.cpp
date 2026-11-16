// Private, bounded stdio worker. A separate process isolates its GGML from whisper.cpp.
#include "qwen.h"
#include "ggml-backend.h"
#include "gguf.h"
#include "yyjson.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

extern "C" int voicekit_qwen_text_token_count(qt_context *, const char *, size_t);

static std::string escaped(const std::string &s) {
    yyjson_mut_doc *d = yyjson_mut_doc_new(nullptr);
    yyjson_mut_doc_set_root(d, yyjson_mut_strcpy(d, s.c_str()));
    char *p = yyjson_mut_write(d, 0, nullptr);
    std::string out = p ? p : "\"worker error\"";
    free(p); yyjson_mut_doc_free(d); return out;
}
static void frame(const std::string &json, const std::vector<uint8_t> &pcm = {}) {
    uint32_t n = static_cast<uint32_t>(json.size());
    uint8_t len[4] = {uint8_t(n), uint8_t(n >> 8), uint8_t(n >> 16), uint8_t(n >> 24)};
    std::cout.write(reinterpret_cast<char *>(len), 4);
    std::cout.write(json.data(), json.size());
    if (!pcm.empty()) std::cout.write(reinterpret_cast<const char *>(pcm.data()), pcm.size());
    std::cout.flush();
}
static void error(const std::string &s) { frame("{\"event\":\"error\",\"bytes\":0,\"error\":" + escaped(s) + "}"); }
// `code` lets the speech server tell causes apart, e.g. "token_limit" for a generation that ran to its cap.
static void error(const std::string &s, const char *code) { frame("{\"event\":\"error\",\"bytes\":0,\"error\":" + escaped(s) + ",\"code\":\"" + code + "\"}"); }
static std::string string_value(yyjson_val *root, const char *key, const char *fallback) {
    const char *s = yyjson_get_str(yyjson_obj_get(root, key)); return s ? s : fallback;
}
static bool expired(void *p) {
    return std::chrono::steady_clock::now() >= *static_cast<std::chrono::steady_clock::time_point *>(p);
}
#ifndef __APPLE__
static bool needs_vulkan_mmvq_workaround(const char *path) {
    // Read metadata only. Match model content, never a user-controlled filename.
    gguf_context *meta = gguf_init_from_file(path, {true, nullptr});
    if (!meta) {
        std::fprintf(stderr, "[qwen] MMVQ compatibility check could not read talker GGUF; leaving backend defaults\n");
        return false; // qt_init retains responsibility for reporting model errors.
    }
    const auto arch = gguf_find_key(meta, "general.architecture");
    const auto width = gguf_find_key(meta, "qwen3-tts.talker.embedding_length");
    const bool small_qwen = arch >= 0 && gguf_get_kv_type(meta, arch) == GGUF_TYPE_STRING &&
        std::strcmp(gguf_get_val_str(meta, arch), "qwen3-tts") == 0 &&
        width >= 0 && gguf_get_kv_type(meta, width) == GGUF_TYPE_UINT32 && gguf_get_val_u32(meta, width) == 1024;
    bool q4 = false;
    if (small_qwen) for (int64_t i = 0; i < gguf_get_n_tensors(meta); ++i) {
        if (gguf_get_tensor_type(meta, i) == GGML_TYPE_Q4_K) { q4 = true; break; }
    }
    gguf_free(meta);
    return small_qwen && q4;
}
#endif
int main(int argc, char **argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
    if (argc != 4) return 2;
#ifndef __APPLE__
    // The pinned Vulkan MMVQ path makes the 1024-wide Q4 model exhaust its
    // token limit on the RTX 5090, both on Windows and on Linux (WSL's Dozen
    // driver). Bypass activation-vector quantization only in this worker;
    // keep Vulkan, FA, and the 1.7B Q8 path unchanged. (macOS uses Metal.)
    if (std::string(argv[3]) != "cpu" && needs_vulkan_mmvq_workaround(argv[1])) {
        if (std::getenv("GGML_VK_DISABLE_MMVQ") || std::getenv("GGML_VK_FORCE_MMVQ")) {
            std::fprintf(stderr, "[qwen] preserving explicit Vulkan MMVQ environment override\n");
        } else {
#ifdef _WIN32
            const bool set = _putenv_s("GGML_VK_DISABLE_MMVQ", "1") == 0;
#else
            const bool set = setenv("GGML_VK_DISABLE_MMVQ", "1", 1) == 0;
#endif
            if (!set) {
                error("Could not configure Vulkan speech precision"); return 1;
            }
            std::fprintf(stderr, "[qwen] Vulkan MMVQ disabled for 1024-wide Q4 talker (worker only)\n");
        }
    }
#endif
#ifdef __APPLE__
    // Backend registration eagerly initializes Metal (and compiles its shaders),
    // even when qt_init will select CPU. CPU-only workers must avoid that work.
    if (std::string(argv[3]) == "cpu" && setenv("GGML_METAL_DEVICES", "0", 1) != 0) {
        error("Could not disable Metal initialization for the CPU worker"); return 1;
    }
#endif
    qt_log_set([](qt_log_level level, const char *message, void *) {
        if(level>=QT_LOG_INFO)std::fprintf(stderr,"[qwen] %s\n",message);
    },nullptr);
    ggml_backend_load_all();
    std::string selected = "CPU", accelerator = "cpu";
    if (std::string(argv[3]) != "cpu") {
        for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
            auto d = ggml_backend_dev_get(i); auto type = ggml_backend_dev_type(d);
            if (type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU) {
                selected = ggml_backend_dev_name(d);
                accelerator = selected.rfind("MTL", 0) == 0 ? "metal" : selected.rfind("CUDA", 0) == 0 ? "cuda" : selected.rfind("Vulkan", 0) == 0 ? "vulkan" : "gpu";
                break;
            }
        }
    }
    qt_init_params init; qt_init_default_params(&init);
    init.talker_path = argv[1]; init.codec_path = argv[2]; init.device = selected.c_str();
    init.codec_chunk_sec = 8.0f;
    qt_context *context = qt_init(&init);
    if (!context && selected != "CPU") {
        selected = "CPU"; accelerator = "cpu"; init.device = selected.c_str(); context = qt_init(&init);
    }
    if (!context) { error(qt_last_error()); return 1; }
    if (std::string(qt_model_type(context)) != "custom_voice") {
        error("Only Qwen3-TTS CustomVoice GGUF models are supported"); qt_free(context); return 1;
    }
    // Initialization diagnostics contain model/device details, never request text.
    // Keep ordinary synthesis logs at warning level after loading finishes.
    qt_log_set([](qt_log_level level, const char *message, void *) {
        if(level>=QT_LOG_WARN)std::fprintf(stderr,"[qwen] %s\n",message);
    },nullptr);
    frame("{\"event\":\"ready\",\"bytes\":0,\"device\":" + escaped(accelerator) + "}");
    std::string line;
    // Read a line without allowing unbounded growth on malformed private IPC input.
    while (std::cin.good()) {
        line.clear(); char c;
        while (std::cin.get(c) && c != '\n') {
            if (line.size() >= 65536) { error("request exceeds 64 KiB"); qt_free(context); return 1; }
            line.push_back(c);
        }
        if (line.empty()) { if (!std::cin.good()) break; continue; }
        yyjson_doc *doc = yyjson_read(line.data(), line.size(), 0);
        if (!doc) { error("invalid request JSON"); continue; }
        auto root = yyjson_doc_get_root(doc);
        std::string text = string_value(root, "text", ""), voice = string_value(root, "voice", "vivian"), language = string_value(root, "language", "auto");
        if (string_value(root, "op", "speak") == "count_tokens") {
            int count = voicekit_qwen_text_token_count(context, text.data(), text.size());
            if (count < 0) error("text token count failed");
            else frame("{\"event\":\"text_tokens\",\"bytes\":0,\"count\":" + std::to_string(count) + "}");
            yyjson_doc_free(doc); continue;
        }
        const std::string instruction = string_value(root, "instruction", "");
        if (instruction.size() > 2048) { error("voice instruction too large"); yyjson_doc_free(doc); continue; }
        qt_tts_params params; qt_tts_default_params(&params);
        params.text = text.c_str(); params.speaker = voice.c_str(); params.lang = language.c_str();
        params.instruct = instruction.empty() ? nullptr : instruction.c_str();
        // Both workers receive the same sampling policy from the speech server.
        auto temperature = yyjson_obj_get(root, "temperature");
        auto seed = yyjson_obj_get(root, "seed");
        if (!yyjson_is_num(temperature) || !std::isfinite(yyjson_get_num(temperature)) || yyjson_get_num(temperature) < 0 || yyjson_get_num(temperature) > 2 ||
            !yyjson_is_int(seed) || yyjson_get_sint(seed) < 0) {
            error("invalid sampling parameters"); yyjson_doc_free(doc); continue;
        }
        params.temperature = float(yyjson_get_num(temperature));
        params.subtalker_temperature = params.temperature;
        params.seed = yyjson_get_sint(seed);
        params.top_k = params.subtalker_top_k = 50;
        params.top_p = params.subtalker_top_p = 1.0f;
        params.repetition_penalty = 1.05f;
        std::fprintf(stderr, "[qwen] speaker=%s language=%s temperature=%.2f seed=%lld\n", voice.c_str(), language.c_str(), params.temperature, (long long)params.seed);
        // The server caps each chunk by its text length (at most 1200 frames, 96 s).
        auto limit = yyjson_obj_get(root, "max_new_tokens");
        params.max_new_tokens = yyjson_is_int(limit) ? int(std::clamp<int64_t>(yyjson_get_sint(limit), 16, 1200)) : 1200;
        auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
        params.cancel = expired; params.cancel_user_data = &deadline;
        qt_audio audio = {};
        auto rc = qt_synthesize(context, &params, &audio);
        if (rc != QT_STATUS_OK) error(qt_last_error());
        else if (audio.n_samples >= params.max_new_tokens * 1920) {
            std::fprintf(stderr, "[qwen] rejected audio: generation reached its limit, samples=%d sample_limit=%d\n",
                         audio.n_samples, params.max_new_tokens * 1920);
            error("speech token limit reached; refusing truncated audio", "token_limit");
        }
        else if (audio.channels != 1 || audio.sample_rate != 24000 || audio.n_samples <= 0) {
            std::fprintf(stderr, "[qwen] rejected audio: channels=%d rate=%d samples=%d\n",
                         audio.channels, audio.sample_rate, audio.n_samples);
            error("empty or malformed audio");
        }
        else {
            std::vector<uint8_t> pcm(size_t(audio.n_samples) * 2);
            bool valid = true;
            for (int i = 0; i < audio.n_samples; ++i) {
                if (!std::isfinite(audio.samples[i])) { valid = false; break; }
                int16_t n = int16_t(std::clamp(audio.samples[i], -1.0f, 1.0f) * 32767);
                pcm[size_t(i)*2] = uint8_t(n); pcm[size_t(i)*2+1] = uint8_t(uint16_t(n) >> 8);
            }
            if (!valid) error("non-finite audio samples");
            else {
                frame("{\"event\":\"audio\",\"rate\":24000,\"bytes\":" + std::to_string(pcm.size()) + "}", pcm);
                frame("{\"event\":\"done\",\"bytes\":0}");
            }
        }
        qt_audio_free(&audio); yyjson_doc_free(doc);
    }
    qt_free(context); return 0;
}
