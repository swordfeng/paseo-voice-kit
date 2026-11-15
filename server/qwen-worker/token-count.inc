// Voice Kit adapter, included after qwen.cpp's opaque context definition.
// Count with the same loaded BPE tokenizer as synthesis; no second vocabulary.
extern "C" int voicekit_qwen_text_token_count(qt_context *q, const char *text, size_t size) {
    if (!q || !text) return -1;
    try {
        return static_cast<int>(bpe_encode(&q->tok, std::string(text, size), false).size());
    } catch (...) {
        return -1;
    }
}
