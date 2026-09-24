import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createLogger } from '@nicotind/core';

const log = createLogger('transcode-quarantine');

/**
 * Keep the original instead of deleting it, for the passes that replace a
 * library file with a re-encode.
 *
 * `transcodeToLibraryFormat` unlinks the source the moment the output is verified. For a
 * freshly downloaded file that is the intended design — it is one re-download
 * away. For a **whole-library backfill** over thousands of irreplaceable files
 * it is not, and generation loss is invisible to any check that runs
 * beforehand: the output can be valid, correct-length, and still worse.
 *
 * So the destructive pass moves each original here instead, and the batch is
 * released only once the operator is satisfied. That is the "back up before
 * transcoding" requirement in docs/opus-library-conversion-plan.md.
 *
 * **Under `dataDir`, never `musicDir`.** Three reasons, and all three were
 * paid for elsewhere:
 *   - a directory inside `musicDir` needs registering in `reservedDirsFor`,
 *     or the scanner walks it and the disk audit reports its contents as
 *     orphan files (the #826 class);
 *   - even registered, `LibraryScanner` warns about a skipped dir holding
 *     audio on every full scan;
 *   - it would collide on the path stems the identity remap matches on.
 *
 * Retention copies `migration-backup.ts`: **count-based, scoped to its own
 * name pattern, never time-based, and never a blanket delete of the root.**
 * A backup deleted to make room for a backup is never the right trade.
 *
 * **And never a side effect.** A conversion used to prune to three runs as it
 * finished, so a library converted deliberately in five batches lost its two
 * oldest runs' originals — 214 repairs — the moment the fifth completed
 * (#1260). Pruning is now only the `prune-quarantine` maintenance task: an
 * operator asks for it, and its dry run names what it would delete.
 */

export const QUARANTINE_SUBDIR = 'quarantine';

/** Only ever prune directories this module itself created. */
const RUN_DIR_RE = /^transcode-\d{8}-\d{6}(-\d+)?$/;

/** Runs kept by `pruneQuarantine` unless the caller says otherwise. */
export const DEFAULT_QUARANTINE_KEEP = 3;

function stamp(at: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

export function quarantineRoot(dataDir: string): string {
  return join(dataDir, QUARANTINE_SUBDIR);
}

/**
 * Create and return this run's directory. Collisions get a numeric suffix
 * rather than merging into an existing run, so two passes started in the same
 * second never interleave their originals.
 */
export function createQuarantineRun(dataDir: string, at: Date = new Date()): string {
  const root = quarantineRoot(dataDir);
  const base = `transcode-${stamp(at)}`;
  let dir = join(root, base);
  for (let n = 2; existsSync(dir); n++) dir = join(root, `${base}-${n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Move `absPath` into `runDir`, keeping its path **relative to `musicDir`**.
 *
 * The layout matters twice over: it makes a restore a plain copy back, and it
 * stops two albums' `01 - Intro.flac` from overwriting each other, which a
 * flat basename layout would do silently.
 *
 * Falls back to copy-then-unlink on `EXDEV`: `dataDir` and `musicDir` are
 * routinely different mounts, and `rename(2)` cannot cross one.
 */
export function quarantineOriginal(runDir: string, musicDir: string, absPath: string): string {
  const rel = relative(musicDir, absPath);
  if (!rel || rel.startsWith('..') || rel.split(sep)[0] === '..') {
    throw new Error(`refusing to quarantine a path outside musicDir: ${absPath}`);
  }
  const dest = join(runDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(absPath, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(absPath, dest);
    // Only after the copy landed: a failed copy must not lose the original.
    unlinkSync(absPath);
  }
  return dest;
}

/** Runs currently held, newest first. */
export function listQuarantineRuns(dataDir: string): string[] {
  const root = quarantineRoot(dataDir);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      if (!RUN_DIR_RE.test(n)) return false;
      try {
        return statSync(join(root, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

/** What `pruneQuarantine(dataDir, keep)` would delete, without deleting it. */
export function planQuarantinePrune(
  dataDir: string,
  keep = DEFAULT_QUARANTINE_KEEP,
): { held: string[]; doomed: string[] } {
  const held = listQuarantineRuns(dataDir);
  return { held, doomed: held.slice(Math.max(1, keep)) };
}

/**
 * Drop all but the newest `keep` runs.
 *
 * Name-scoped, so anything an operator parked in the root by hand is left
 * alone — the root itself is never removed. `keep` below 1 is treated as 1:
 * this function exists to bound disk, not to empty the backup.
 */
export function pruneQuarantine(dataDir: string, keep = DEFAULT_QUARANTINE_KEEP): number {
  const { held: runs, doomed } = planQuarantinePrune(dataDir, keep);
  let removed = 0;
  for (const name of doomed) {
    try {
      rmSync(join(quarantineRoot(dataDir), name), { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn({ err, name }, 'could not prune a quarantine run');
    }
  }
  if (removed > 0) log.info({ removed, kept: runs.length - removed }, 'pruned quarantine runs');
  return removed;
}

export interface QuarantineDescription {
  /** The quarantine root — `<dir>/quarantine`. */
  root: string;
  /** Held runs, newest first, with how many originals each keeps. */
  runs: { name: string; files: number }[];
  /** Space on the filesystem holding the root; null when it cannot be read. */
  filesystem: { freeBytes: number; totalBytes: number } | null;
}

/**
 * What the quarantine holds, for an operator to see before deciding anything
 * (#1255): where the originals are, run by run, and how full the disk under
 * them is. Retention used to be a side effect nobody saw (#1260); this is the
 * read half of making it a decision. Counts files, never sizes them — a stat
 * per original would make a page load cost a whole-quarantine walk of I/O.
 */
export function describeQuarantine(dataDir: string): QuarantineDescription {
  const root = quarantineRoot(dataDir);
  const runs = listQuarantineRuns(dataDir).map((name) => ({
    name,
    files: countFiles(join(root, name)),
  }));
  let filesystem: QuarantineDescription['filesystem'] = null;
  try {
    const fs = statfsSync(existsSync(root) ? root : dataDir);
    filesystem = { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize };
  } catch {
    /* an unmounted or missing dir: say "unknown", not zero */
  }
  return { root, runs, filesystem };
}

function countFiles(dir: string): number {
  let n = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}
