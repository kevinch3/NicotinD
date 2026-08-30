import { isAbsolute, join } from 'node:path';

/**
 * The one place that answers "is this path library content, or staging?".
 *
 * The rule is scoped by depth, because that is where the meaning differs: the
 * top level of `musicDir` is ours to manage, everything below it is user
 * content. An unrestricted dot rule would drop real albums —
 * `DMX/...And Then There Was X` and `Memphis La Blusera/...Etc` are both in the
 * production library. → docs/library-path-conventions.md
 */

export const DEFAULT_DOWNLOADS_DIR = '.downloads';
export const DEFAULT_UNSORTED_DIR = '.unsorted';

export interface PathConfig {
  /** `downloads.dir`. Relative → under musicDir; absolute → its own disk. */
  downloadsDir?: string;
  /** `unsortedRoot`, same shape. */
  unsortedRoot?: string;
}

/**
 * Reserved top-level names for this deployment: the shipped defaults plus any
 * *relative* configured override. Derived rather than hardcoded so the dir that
 * gets written to is the dir that gets skipped — a constant stops matching the
 * moment an operator overrides the config (the #826 defect class).
 */
export function reservedDirsFor(cfg?: PathConfig): ReadonlySet<string> {
  const names = new Set<string>([DEFAULT_DOWNLOADS_DIR, DEFAULT_UNSORTED_DIR]);
  for (const raw of [cfg?.downloadsDir, cfg?.unsortedRoot]) {
    // An absolute override lives outside musicDir, so no walker ever sees it
    // and it is not a name to reserve.
    if (raw && !isAbsolute(raw)) names.add(raw);
  }
  return names;
}

/** Hidden-file convention. Catches macOS AppleDouble sidecars, which otherwise
 *  match AUDIO_EXTENSIONS: `extname('._Track.flac')` is `'.flac'`. */
export function isHiddenFile(basename: string): boolean {
  return basename.startsWith('.');
}

/** Top level of musicDir only: a dot-prefixed dir, or a configured staging name. */
export function isReservedTopLevel(name: string, reserved: ReadonlySet<string>): boolean {
  return name.startsWith('.') || reserved.has(name);
}

/**
 * Whether a musicDir-relative path is staging rather than library content:
 * its *first* segment is reserved, or its basename is a hidden file. Directory
 * names below the top level are deliberately never judged.
 */
export function isReservedPath(relPath: string, reserved: ReadonlySet<string>): boolean {
  const segments = relPath.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.length > 1 && isReservedTopLevel(segments[0]!, reserved)) return true;
  return isHiddenFile(segments[segments.length - 1]!);
}

/** Absolute path of the acquisition staging dir for a music dir. */
export function downloadsDirFor(musicDir: string, cfg?: PathConfig): string {
  const raw = cfg?.downloadsDir ?? DEFAULT_DOWNLOADS_DIR;
  return isAbsolute(raw) ? raw : join(musicDir, raw);
}
