// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "VoicekitMlxWorker",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "voicekit-mlx-worker", targets: ["VoicekitMlxWorker"])],
    dependencies: [
        .package(url: "https://github.com/Neywa-Labs/mlx-audio-swift.git", revision: "209e1cb45498c5b7b4b96d417f9b15fe71d440f5"),
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.33.0"),
    ],
    targets: [.executableTarget(name: "VoicekitMlxWorker", dependencies: [
        .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
        .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
        .product(name: "MLX", package: "mlx-swift"),
    ])]
)
