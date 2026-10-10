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
 * True when Android's own package installer installed this app: a downloaded
 * APK, or our own `ACTION_VIEW` self-update (#1503). That is the one case where
 * nothing else will update it.
 *
 * Since #1168 there is ONE Android APK, sideloaded from GitHub releases and
 * served from F-Droid, so who installed it decides whether the in-app updater
 * appears. This used to be a blocklist of store clients, which missed the
 * root/Shizuku installs of those same clients — they report `com.android.shell`
 * or no installer at all — and an F-Droid reviewer caught it. An allowlist
 * fails the other way: a device that reports no installer for a plain sideload
 * loses the button, and still updates from the release page or our F-Droid repo.
 *
 * OEMs ship their own installer (`com.miui.packageinstaller`, …), hence the
 * suffix rather than a list.
 */
export function isSideloadInstaller(installer: string | null | undefined): boolean {
  return (
    typeof installer === 'string' && /^[a-z0-9_]+(\.[a-z0-9_]+)*\.packageinstaller$/.test(installer)
  );
}
