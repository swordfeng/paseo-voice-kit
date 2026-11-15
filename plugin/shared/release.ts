/**
 * voicekit release builds the plugin can install. `scripts/release-manifest.mjs` regenerates
 * this from a GitHub release. Platforms without an entry need a local build
 * (`scripts/dev-install.sh`) or the "Binary path" setting.
 */
/**
 * The speech server version this plugin is written for. Voice Kit refuses any other server,
 * whichever source it comes from, and never downloads a pinned release of another version.
 * Keep it equal to `version` in server/Cargo.toml (checked by scripts/test-supervisor.cjs); a
 * change that needs a new server lands together with that server's published release.
 */
export const SERVER_VERSION = "0.1.1";

export interface ReleaseAsset {
  url: string;
  /** SHA-256 of the release archive. */
  sha256: string;
  /** Executable inside the tar.gz archive, e.g. "voicekit-linux-x64/voicekit". */
  exe: string;
}

export const RELEASE: { version: string; assets: Partial<Record<string, ReleaseAsset>> } = {
  "version": "0.1.0",
  "assets": {
    "darwin-arm64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.0/voicekit-darwin-arm64.tar.gz",
      "sha256": "f14194fd5b121f80c33463b87a215487308a89561d10f2b5328ddd1a7bee8082",
      "exe": "voicekit-darwin-arm64/voicekit"
    },
    "darwin-x64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.0/voicekit-darwin-x64.tar.gz",
      "sha256": "e470f16434ae9641a25c18d69b66c505c00a0ead43692904440706998ca822d3",
      "exe": "voicekit-darwin-x64/voicekit"
    },
    "linux-arm64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.0/voicekit-linux-arm64.tar.gz",
      "sha256": "fcf18c47e3c2e14fd64ba3997baf82877e802e0529fb62e49750b93a87f60237",
      "exe": "voicekit-linux-arm64/voicekit"
    },
    "linux-x64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.0/voicekit-linux-x64.tar.gz",
      "sha256": "6fea45ac5dda463f86c7ee78e7c96415952fb9480dd62fca47ce7026fea5482b",
      "exe": "voicekit-linux-x64/voicekit"
    },
    "win32-x64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.0/voicekit-win32-x64.tar.gz",
      "sha256": "6d6e284229db43de105009c45d0044ed28ab69f8e40a96eb3f4e58eca09b2c64",
      "exe": "voicekit-win32-x64/voicekit.exe"
    }
  }
};

/** `process.platform`-`process.arch`, e.g. darwin-arm64, linux-x64, win32-x64. */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}
