/**
 * voicekit release builds the plugin can install. `scripts/release-manifest.mjs` regenerates
 * this from a GitHub release. Platforms without an entry need a local build
 * (`scripts/dev-install.sh`) or the "Binary path" setting.
 */
export interface ReleaseAsset {
  url: string;
  /** SHA-256 of the release archive. */
  sha256: string;
  /** Executable inside the tar.gz archive, e.g. "voicekit-linux-x64/voicekit". */
  exe: string;
}

export const RELEASE: { version: string; assets: Partial<Record<string, ReleaseAsset>> } = {
  version: "0.1.0",
  assets: {},
};

/** `process.platform`-`process.arch`, e.g. darwin-arm64, linux-x64, win32-x64. */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}
