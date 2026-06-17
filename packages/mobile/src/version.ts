/**
 * Parse a monorepo semver into its numeric parts, tolerating surrounding
 * whitespace and trailing pre-release/build suffixes (`1.2.3-rc.1`). The
 * monotonic integer scheme (`major*1e6 + minor*1e3 + patch`) is shared by both
 * native platforms (Android `versionCode`, iOS `CFBundleVersion`); it reserves
 * three decimal digits each for minor and patch, so it stays monotonic as long
 * as minor and patch are each < 1000.
 */
function parseVersion(semver: string): {
  major: number;
  minor: number;
  patch: number;
  versionName: string;
  versionCode: number;
} {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(semver.trim());
  if (!m) throw new Error(`Unparseable version: ${JSON.stringify(semver)}`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (minor >= 1000 || patch >= 1000) {
    throw new Error(`minor/patch must be < 1000 for a monotonic versionCode: ${semver}`);
  }
  return {
    major,
    minor,
    patch,
    versionName: `${major}.${minor}.${patch}`,
    versionCode: major * 1_000_000 + minor * 1_000 + patch,
  };
}

/**
 * Derive the Android `versionName` + `versionCode` from the monorepo's semver so
 * `bun run release` stays the single source of truth for the app version too.
 */
export function androidVersion(semver: string): { versionName: string; versionCode: number } {
  const { versionName, versionCode } = parseVersion(semver);
  return { versionName, versionCode };
}

/**
 * Derive the iOS `CFBundleShortVersionString` (`shortVersion`, the user-facing
 * marketing version) + `CFBundleVersion` (`bundleVersion`, the monotonic build
 * number) from the same semver — the iOS analogue of {@link androidVersion}, so
 * both platforms version off the one monorepo release. `bundleVersion` reuses
 * the shared monotonic integer scheme.
 */
export function iosVersion(semver: string): { shortVersion: string; bundleVersion: number } {
  const { versionName, versionCode } = parseVersion(semver);
  return { shortVersion: versionName, bundleVersion: versionCode };
}
