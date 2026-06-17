/**
 * Derive the Android `versionName` + `versionCode` from the monorepo's semver so
 * `bun run release` stays the single source of truth for the app version too.
 *
 * `versionCode` must be a monotonically increasing integer; the scheme reserves
 * three decimal digits each for minor and patch (`major*1e6 + minor*1e3 + patch`),
 * which stays monotonic as long as minor and patch are each < 1000.
 */
export function androidVersion(semver: string): { versionName: string; versionCode: number } {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(semver.trim());
  if (!m) throw new Error(`Unparseable version: ${JSON.stringify(semver)}`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (minor >= 1000 || patch >= 1000) {
    throw new Error(`minor/patch must be < 1000 for a monotonic versionCode: ${semver}`);
  }
  return {
    versionName: `${major}.${minor}.${patch}`,
    versionCode: major * 1_000_000 + minor * 1_000 + patch,
  };
}
