/**
 * Sideloaded-APK self-update from GitHub releases (Android/TV app).
 *
 * The Android and TV APKs have no store channel — every release attaches
 * `NicotinD-<v>.apk` + `NicotinD-TV-<v>.apk` to the GitHub release
 * (deploy.yml), so "update" means: read the latest release tag, build the
 * matching asset URL for this build flavor, download it and hand it to the
 * system package installer. These pure helpers cover the URL/tag halves;
 * the download+install lives in the `NicotindApkUpdate` native plugin.
 */

/** Same repo the server's daily update-check polls (`services/update-check.ts`). */
export const RELEASES_LATEST_URL = 'https://api.github.com/repos/kevinch3/NicotinD/releases/latest';

const DOWNLOAD_BASE = 'https://github.com/kevinch3/NicotinD/releases/download';

/** Latest-release version from the GitHub API body, `v` prefix stripped; null when malformed. */
export function parseLatestRelease(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const tag = (body as { tag_name?: unknown }).tag_name;
  if (typeof tag !== 'string' || !tag) return null;
  return tag.replace(/^v/, '');
}

/** The release asset file name for this build flavor — must match deploy.yml. */
export function apkFileName(version: string, tv: boolean): string {
  return tv ? `NicotinD-TV-${version}.apk` : `NicotinD-${version}.apk`;
}

/** Direct-download URL of the APK asset on the `v<version>` release. */
export function apkAssetUrl(version: string, tv: boolean): string {
  return `${DOWNLOAD_BASE}/v${version}/${apkFileName(version, tv)}`;
}

/**
 * Package names of app stores that manage updates for what they installed.
 *
 * Since #1168 there is ONE Android APK: the same binary is sideloaded from
 * GitHub releases and served from our F-Droid repository. Self-updating is
 * right for the first and wrong for the second — F-Droid updates what it
 * installed, and offering a second path beside it means two update prompts and
 * an in-app one that bypasses the store's own integrity checks.
 *
 * Asking the system who installed us is what replaced a build flavor here, so
 * the list has to cover the F-Droid *clients* people actually use, not just the
 * official one; an unlisted fork simply keeps the in-app updater, which is the
 * safe direction to be wrong in.
 */
const STORE_MANAGED_INSTALLERS = new Set([
  'org.fdroid.fdroid', // F-Droid
  'org.fdroid.basic', // F-Droid Basic
  'com.looker.droidify', // Droid-ify
  'com.machiav3lli.fdroid', // Neo Store
  'com.android.vending', // Play Store, for completeness
]);

/**
 * True when `installer` is a store that will update this app itself, so the
 * in-app updater should stay hidden.
 *
 * A null/unknown installer means a sideload (or a platform that will not say),
 * and that keeps self-update available — the failure mode of guessing wrong here is
 * a user stranded on an old build with no way to move.
 */
export function isStoreManagedInstaller(installer: string | null | undefined): boolean {
  return installer !== null && installer !== undefined && STORE_MANAGED_INSTALLERS.has(installer);
}
