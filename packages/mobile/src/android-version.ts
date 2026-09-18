import { androidVersion } from './version.js';

/**
 * fdroidserver's own regexes for reading an Android version out of a gradle
 * file (`common.py`, `vcsearch_g` / `vnsearch_g`). Copied deliberately rather
 * than approximated: F-Droid's `UpdateCheckMode: Tags` uses exactly these to
 * decide what a tag contains, so whatever they see IS our published version.
 */
export const FDROID_VERSION_CODE_RE = /\b[Vv]ersionCode\s*=?\s*["'(]*([0-9][0-9_]*)["')]*/g;
export const FDROID_VERSION_NAME_RE = /\b[Vv]ersionName\s*=?\s*\(?(["'])((?:(?=(\\?))\3.)*?)\1/g;

/** What fdroidserver would read from this gradle file — comments included. */
export function readFdroidVersions(gradleText: string): {
  codes: string[];
  names: string[];
} {
  return {
    codes: [...gradleText.matchAll(FDROID_VERSION_CODE_RE)].map((m) => m[1]),
    names: [...gradleText.matchAll(FDROID_VERSION_NAME_RE)].map((m) => m[2]),
  };
}

/**
 * Rewrite the literal `versionCode` / `versionName` from a monorepo semver.
 *
 * Each must appear exactly once *as fdroidserver sees it*. More than one and
 * F-Droid reads whichever its regex hits first — a stray example in a comment
 * has done this to other projects. Zero means the field moved and this writer
 * silently stopped working, which is the failure that matters: releases keep
 * shipping, and F-Droid keeps offering the last version it could parse.
 */
export function applyAndroidVersion(gradleText: string, semver: string): string {
  const { versionCode, versionName } = androidVersion(semver);
  const found = readFdroidVersions(gradleText);

  for (const [label, hits] of [
    ['versionCode', found.codes],
    ['versionName', found.names],
  ] as const) {
    if (hits.length !== 1) {
      throw new Error(
        `expected exactly one ${label} in build.gradle as fdroidserver reads it, found ` +
          `${hits.length}${hits.length > 1 ? ` (${hits.join(', ')})` : ''}. F-Droid greps this ` +
          `file, so a second match — even inside a comment — decides our published version.`,
      );
    }
  }

  return gradleText
    .replace(FDROID_VERSION_CODE_RE, `versionCode ${versionCode}`)
    .replace(FDROID_VERSION_NAME_RE, `versionName "${versionName}"`);
}
