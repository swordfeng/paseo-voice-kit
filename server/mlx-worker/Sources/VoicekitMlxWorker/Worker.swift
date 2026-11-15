// Native MLX worker. Framed stdout is private IPC; model directories are read-only.
import Foundation
import Darwin
import Metal
import MLX
import MLXAudioCore
import MLXAudioTTS

struct Request: Decodable {
    let text: String
    let voice: String?
    let language: String?
}

struct Frames: Sendable {
    let output: FileHandle
    func send(_ event: String, pcm: Data = Data(), fields: [String: Any] = [:]) throws {
        var header = fields
        header["event"] = event
        header["bytes"] = pcm.count
        let data = try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])
        guard data.count <= 65_536 else { throw Failure("frame header too large") }
        var length = UInt32(data.count).littleEndian
        try withUnsafeBytes(of: &length) { try output.write(contentsOf: Data($0)) }
        try output.write(contentsOf: data)
        if !pcm.isEmpty { try output.write(contentsOf: pcm) }
    }
}
struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

// Opt-in diagnostics never include request text and never use framed stdout.
func profile(_ event: String, _ fields: [String: Any] = [:]) {
    guard ProcessInfo.processInfo.environment["VOICEKIT_MLX_PROFILE"] == "1" else { return }
    var fields = fields
    fields["profile"] = event
    guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else { return }
    try? FileHandle.standardError.write(contentsOf: data + Data([10]))
}

@main enum Worker {
    static func main() async {
        if CommandLine.arguments.dropFirst() == ["--version"] {
            print("voicekit-mlx-worker 1 (swift-mlx)")
            return
        }
        // Upstream logging must not corrupt the binary protocol.
        let saved = dup(STDOUT_FILENO)
        guard saved >= 0, dup2(STDERR_FILENO, STDOUT_FILENO) >= 0 else { exit(1) }
        let frames = Frames(output: FileHandle(fileDescriptor: saved, closeOnDealloc: true))
        do {
            guard CommandLine.arguments.count == 2 else { throw Failure("expected a model directory") }
            let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            let metal = executable.deletingLastPathComponent().appendingPathComponent("mlx.metallib")
            guard FileManager.default.fileExists(atPath: metal.path) else { throw Failure("MLX Metal resource is missing") }
            GPU.metallib = metal
            guard let gpu = MTLCreateSystemDefaultDevice() else { throw Failure("Metal GPU unavailable") }
            let gpuName = gpu.name
            try await Device.withDefaultDevice(.gpu) { @Sendable in
                guard Device.defaultDevice().deviceType == .gpu else { throw Failure("MLX did not select GPU") }
                let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
                let config = try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("config.json"))) as? [String: Any] ?? [:]
                guard config["tts_model_type"] as? String == "custom_voice" else { throw Failure("only CustomVoice checkpoints are supported") }
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: folder.appendingPathComponent("speech_tokenizer").path,
                        isDirectory: &isDirectory), isDirectory.boolValue else {
                    throw Failure("missing speech tokenizer directory")
                }
                guard let eos = (config["talker_config"] as? [String: Any])?["codec_eos_token_id"] as? Int else {
                    throw Failure("missing speech end token")
                }
                let model = try await Qwen3TTSModel.fromModelDirectory(folder)
                guard model.sampleRate == 24_000 else { throw Failure("unexpected model sample rate") }
                try frames.send("ready", fields: ["device": "metal", "backend":"swift-mlx", "protocol":1, "metal_device": gpuName,
                    "mlx_default_device": Device.defaultDevice().deviceType.rawValue,
                    "model_size": config["tts_model_size"] ?? NSNull(),
                    "quantization_bits": (config["quantization"] as? [String: Any])?["bits"] ?? NSNull()])
                let voices = Set(["vivian", "serena", "uncle_fu", "dylan", "eric", "ryan", "aiden", "ono_anna", "sohee"])
                let languages = ["zh":"Chinese", "en":"English", "ja":"Japanese", "ko":"Korean", "de":"German", "fr":"French", "ru":"Russian", "pt":"Portuguese", "es":"Spanish", "it":"Italian"]
                while let line = readLine() {
                    do {
                        guard line.utf8.count <= 65_536 else { throw Failure("request too large") }
                        let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                        guard !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                              request.text.count <= 4096 else { throw Failure("invalid text length") }
                        let voice = request.voice?.lowercased() ?? "serena"
                        guard voices.contains(voice) else { throw Failure("unsupported speaker") }
                        let language = request.language.flatMap { languages[$0] } ?? "Auto"
                        let started = Date()
                        profile("request", ["characters": request.text.count])
                        var first = true
                        var count = 0
                        var ended = false
                        var tokens = 0
                        // Reduce sampling variation for ordinary spoken replies.
                        let parameters = GenerateParameters(maxTokens: 1200, temperature: 0.6, topP: 1, topK: 50, repetitionPenalty: 1.05)
                        let seed = UInt64(ProcessInfo.processInfo.environment["VOICEKIT_MLX_SEED"] ?? "42") ?? 42
                        MLXRandom.seed(seed)
                        for try await event in model.generateStream(text: request.text, voice: voice,
                                refAudio: nil, refText: nil, language: language,
                                generationParameters: parameters, streamingInterval: 0.4) {
                            if case .token(let token) = event {
                                ended = token == eos
                                tokens += 1
                                if tokens <= 8 {
                                    profile("token", ["index": tokens, "ms": Date().timeIntervalSince(started) * 1000])
                                }
                            }
                            if case .info(let info) = event {
                                profile("generation", ["tokens": info.generationTokenCount, "seconds": info.generateTime])
                            }
                            if case .audio(let chunk) = event {
                                profile("audio", ["samples_before": count, "ms": Date().timeIntervalSince(started) * 1000])
                                let samples = chunk.asArray(Float.self)
                                count += samples.count
                                guard count < 24_000 * 96 else { throw Failure("speech token or audio limit reached") }
                                var pcm = Data(capacity: samples.count * 2)
                                for sample in samples {
                                    guard sample.isFinite else { throw Failure("non-finite audio") }
                                    var value = Int16(max(-1, min(1, sample)) * 32767).littleEndian
                                    withUnsafeBytes(of: &value) { pcm.append(contentsOf: $0) }
                                }
                                if !pcm.isEmpty {
                                    try frames.send("audio", pcm: pcm, fields: ["rate":model.sampleRate,
                                        "first_ms": first ? Date().timeIntervalSince(started) * 1000 : NSNull()])
                                    first = false
                                }
                            }
                        }
                        guard ended else { throw Failure("speech token limit reached; refusing truncated audio") }
                        guard count > 0 else { throw Failure("empty speech") }
                        try frames.send("done", fields: ["mlx_peak_bytes":Memory.peakMemory])
                    } catch {
                        try frames.send("error", fields: ["error":String(describing: error)])
                    }
                }
            }
        } catch {
            try? frames.send("error", fields: ["error":String(describing: error)])
            exit(1)
        }
    }
}
