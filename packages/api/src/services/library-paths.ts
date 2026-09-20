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

/**
 * Resolve this deployment's reserved set from a raw parsed config file, the way
 * `src/index.ts` does at boot.
 *
 * The offline entry points each build their own `{dataDir, musicDir}` and none
 * of them resolved this, so they walked with `reservedDirsFor()` — the shipped
 * defaults, not the configured set. A configured **non-dot** staging directory
 * was therefore invisible to them: the audit reported its contents as orphan
 * files, and the backfill indexed them as library content. That is the #826
 * defect class reappearing at the call site rather than in the predicate, which
 * is exactly what `resolveTranscodeLossless` exists to prevent one module over.
 *
 * `unsortedRoot` is `<dataDir>/unsorted`, matching the boot wiring — absolute,
 * so it contributes no reserved *name* unless an operator points it inside
 * musicDir with a relative path.
 */
export function resolveReservedDirs(fileConfig: unknown, dataDir: string): ReadonlySet<string> {
  const downloads = (fileConfig as { downloads?: { dir?: unknown } } | undefined)?.downloads;
  const fromFile = typeof downloads?.dir === 'string' ? downloads.dir : undefined;
  // Env wins over the file, the same precedence every other key uses — and the
  // one that matters most here, because the production image ships no config
  // file at all, so env is the only source it has (#824).
  const dir = process.env.NICOTIND_DOWNLOADS_DIR?.trim() || fromFile;
  return reservedDirsFor({ downloadsDir: dir, unsortedRoot: `${dataDir}/unsorted` });
}
