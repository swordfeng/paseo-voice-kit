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
  "version": "0.1.1",
  "assets": {
    "darwin-arm64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.1/voicekit-darwin-arm64.tar.gz",
      "sha256": "417d332d298daa41684bbeba1cb904ded5c26e2068159d7cd8f7d6d1119fba4a",
      "exe": "voicekit-darwin-arm64/voicekit"
    },
    "darwin-x64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.1/voicekit-darwin-x64.tar.gz",
      "sha256": "b3a0c623bdbb03cf31c0825821c4132b0f67e633edbc1e8a5d33f4e85a3548e7",
      "exe": "voicekit-darwin-x64/voicekit"
    },
    "linux-arm64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.1/voicekit-linux-arm64.tar.gz",
      "sha256": "9f436b7c356d6b8912cbd563d44865dce5c7c40275a62bd32b3331444ce330cf",
      "exe": "voicekit-linux-arm64/voicekit"
    },
    "linux-x64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.1/voicekit-linux-x64.tar.gz",
      "sha256": "73431f148476ddbc88cea3166cddbeb42a6c8f3b72b1aaea8b5bf77b3f5c2f1b",
      "exe": "voicekit-linux-x64/voicekit"
    },
    "win32-x64": {
      "url": "https://github.com/swordfeng/paseo-voice-kit/releases/download/v0.1.1/voicekit-win32-x64.tar.gz",
      "sha256": "50492b48b9b0ac80cbea6c66eb853123956b4c8dff2c74a3927bff6b651a3cc8",
      "exe": "voicekit-win32-x64/voicekit.exe"
    }
  }
};

/** `process.platform`-`process.arch`, e.g. darwin-arm64, linux-x64, win32-x64. */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}
