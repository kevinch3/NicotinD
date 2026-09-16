/**
 * The generated inputs for our own signed F-Droid repository (issue #1168).
 *
 * `fdroid update` (fdroidserver) reads a `config.yml` and one
 * `metadata/<applicationId>.yml` per app, then builds and signs the index from
 * whatever APKs sit in `repo/`. Both files are generated rather than committed:
 * the repo URL, the app ids and the current version all come from things the
 * repo already knows, and a second hand-maintained copy would drift.
 *
 * Everything here is pure so it can be tested without fdroidserver, an Android
 * SDK or a keystore — the script that writes these files and shells out to
 * `fdroid` is `scripts/build-fdroid-repo.ts`.
 */

/** An app entry in our repository. */
export interface FdroidApp {
  /** Android application id — the metadata file name and the index key. */
  applicationId: string;
  /** Shown in the client. MUST differ per entry: F-Droid requires it, and two
   * rows both called "NicotinD" would be unpickable. */
  name: string;
  /** Directory holding the fastlane tree, relative to packages/mobile. */
  fastlaneDir: string;
  /** The APK file name inside `repo/`. */
  apk: string;
}

/**
 * The two entries we publish. The TV app id carries the `.tv` suffix the
 * F-Droid variant builds with (`NICOTIND_APP_ID_SUFFIX`), so this list and
 * `fdroidAppId()` have to agree — `check:fdroid` asserts that they do.
 */
export const FDROID_APPS: readonly FdroidApp[] = [
  {
    applicationId: 'ar.kevinroberts.nicotind',
    name: 'NicotinD',
    fastlaneDir: 'fastlane',
    apk: 'NicotinD-fdroid.apk',
  },
  {
    applicationId: 'ar.kevinroberts.nicotind.tv',
    name: 'NicotinD TV',
    fastlaneDir: 'fastlane-tv',
    apk: 'NicotinD-TV-fdroid.apk',
  },
] as const;

/**
 * `config.yml` for `fdroid update`.
 *
 * `archive_older: 0` keeps every version in the main index instead of moving
 * old ones to an archive repo we do not publish — with one release's APKs in
 * `repo/` there is nothing to archive, and a missing archive URL makes the
 * client log errors.
 *
 * The keystore password is interpolated, so the caller must treat the result as
 * a secret: write it 0600 and never log it.
 */
export function fdroidRepoConfig(options: {
  repoUrl: string;
  keystore: string;
  keystorePassword: string;
  keyAlias: string;
}): string {
  const { repoUrl, keystore, keystorePassword, keyAlias } = options;
  return [
    `repo_url: ${repoUrl}`,
    'repo_name: NicotinD',
    'repo_description: >-',
    '  Official NicotinD builds — the self-hosted music server, for phones and',
    '  Android TV. Signed by the NicotinD repository key.',
    'repo_icon: icon.png',
    'archive_older: 0',
    `keystore: ${keystore}`,
    `keystorepass: "${keystorePassword}"`,
    `keypass: "${keystorePassword}"`,
    `repo_keyalias: ${keyAlias}`,
    '',
  ].join('\n');
}

/**
 * `metadata/<applicationId>.yml`.
 *
 * WHY this is written rather than left to `fdroid update --create-metadata`:
 * that flag invents a file from the APK, and its `Name` (the APK's own label,
 * "NicotinD" for both) **outranks** the fastlane `title.txt`. Verified locally
 * — the TV entry came out named "NicotinD" with `Categories: [fdtest]` taken
 * from the working directory's name. Generating it is how the two entries stay
 * distinguishable.
 *
 * `CurrentVersionCode` is set because fdroidserver matches a per-version
 * changelog file against it. Note that even then a changelog does NOT surface
 * in a binary-only repo: `whatsNew` is attached to a `Builds` entry, which only
 * exists for apps fdroidserver builds from source. The versionCode-named files
 * stay correct for the fdroiddata submission, where those entries do exist.
 */
export function fdroidAppMetadata(app: FdroidApp, versionCode: number): string {
  return [
    'Categories:',
    '  - Multimedia',
    'License: AGPL-3.0-only',
    'AuthorName: Kevin Chavarria',
    'SourceCode: https://github.com/kevinch3/NicotinD',
    'IssueTracker: https://github.com/kevinch3/NicotinD/issues',
    'Changelog: https://github.com/kevinch3/NicotinD/blob/master/CHANGELOG.md',
    `Name: ${app.name}`,
    `CurrentVersionCode: ${versionCode}`,
    '',
  ].join('\n');
}
