// Private, bounded stdio worker. A separate process isolates its GGML from whisper.cpp.
#include "qwen.h"
#include "ggml-backend.h"
#include "yyjson.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

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
static std::string string_value(yyjson_val *root, const char *key, const char *fallback) {
    const char *s = yyjson_get_str(yyjson_obj_get(root, key)); return s ? s : fallback;
}
static bool expired(void *p) {
    return std::chrono::steady_clock::now() >= *static_cast<std::chrono::steady_clock::time_point *>(p);
}
int main(int argc, char **argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
    if (argc != 4) return 2;
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
        qt_tts_params params; qt_tts_default_params(&params);
        params.text = text.c_str(); params.speaker = voice.c_str(); params.lang = language.c_str();
        // Keep ordinary replies reproducible and reduce expressive sampling variance. The
        // acoustic sub-talker keeps the upstream defaults; this controls the main talker only.
        params.temperature = 0.7f;
        params.seed = 42;
        // Private IPC overrides allow short, reproducible sampling comparisons.
        auto temperature = yyjson_obj_get(root, "temperature");
        auto seed = yyjson_obj_get(root, "seed");
        if ((temperature && (!yyjson_is_num(temperature) || !std::isfinite(yyjson_get_num(temperature)) || yyjson_get_num(temperature) < 0 || yyjson_get_num(temperature) > 2)) ||
            (seed && (!yyjson_is_int(seed) || yyjson_get_sint(seed) < 0))) {
            error("invalid sampling parameters"); yyjson_doc_free(doc); continue;
        }
        if (temperature) params.temperature = float(yyjson_get_num(temperature));
        if (seed) params.seed = yyjson_get_sint(seed);
        std::fprintf(stderr, "[qwen] speaker=%s language=%s temperature=%.2f seed=%lld\n", voice.c_str(), language.c_str(), params.temperature, (long long)params.seed);
        params.max_new_tokens = 1200;
        auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
        params.cancel = expired; params.cancel_user_data = &deadline;
        qt_audio audio = {};
        auto rc = qt_synthesize(context, &params, &audio);
        if (rc != QT_STATUS_OK) error(qt_last_error());
        else if (audio.channels != 1 || audio.sample_rate != 24000 || audio.n_samples <= 0 || audio.n_samples >= params.max_new_tokens * 1920) error("empty or token-limited audio");
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
