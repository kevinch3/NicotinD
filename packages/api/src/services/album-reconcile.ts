// packages/api/src/services/album-reconcile.ts
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { getMusicMetadata } from './music-metadata-loader.js';
import { selectAlbumTracksDetailed, type SelectableTrack } from './library-track-select.js';
import { AUDIO_EXTENSIONS } from '@nicotind/core';

/** Album folders that must never be collapsed as one album (each loose track is its own single). */
export const SINGLES_DIR_RE = /(^|[/\\])Singles$/i;

export interface ReconcileFile {
  name: string;
  title: string;
  suffix: string;
  bitRate: number;
  /** Disc number from tags. Absent/null means "the only disc" (issue #747). */
  disc?: number | null;
}

export interface ReconcileResult {
  deletedNames: string[];
  keptNames: string[];
  /**
   * Deleted file name → the name that survived in its place. Lets a caller that
   * recorded a now-deleted path re-point at the copy that replaced it (#1032).
   */
  supersededBy: Record<string, string>;
}

/**
 * Pure keeper-selection for one album folder. Uses the SAME identity + quality
 * ranking as the library scanner (`selectAlbumTracks`): identity is `(disc,
 * title)` — canonical-title match (dropping foreign rips) when `canonicalTitles`
 * is given, else normalized title — then FLAC > lossy > bitrate, ties on
 * smallest name. Returns which files to keep vs delete. No IO — directly
 * unit-testable.
 */
export function chooseFolderKeepers(
  files: ReconcileFile[],
  canonicalTitles?: readonly string[] | null,
): ReconcileResult {
  // relPath === name here so selectAlbumTracks' deterministic tiebreak sorts by name.
  const selectable: (SelectableTrack & { name: string })[] = files.map((x) => ({
    relPath: x.name,
    name: x.name,
    title: x.title,
    suffix: x.suffix,
    bitRate: x.bitRate,
    // This pass DELETES, so a title repeated across discs must not collide (issue #747).
    disc: x.disc ?? null,
  }));
  const selection = selectAlbumTracksDetailed(selectable, canonicalTitles);
  const kept = new Set(selection.kept.map((t) => t.name));
  const keptNames: string[] = [];
  const deletedNames: string[] = [];
  for (const x of files) (kept.has(x.name) ? keptNames : deletedNames).push(x.name);
  const supersededBy: Record<string, string> = {};
  for (const [loser, winner] of selection.supersededBy) supersededBy[loser.name] = winner.name;
  return { keptNames, deletedNames, supersededBy };
}

/** Read a folder's audio files into ReconcileFile[] (title + disc via tag, fallback filename stem). */
export async function readFolderTracks(dir: string): Promise<ReconcileFile[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const mm = await getMusicMetadata();
  const out: ReconcileFile[] = [];
  for (const name of entries) {
    const ext = extname(name).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) continue;
    const abs = join(dir, name);
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    let title = name.slice(0, name.length - ext.length);
    let bitRate = 0;
    let disc: number | null = null;
    try {
      const meta = mm ? await mm.parseFile(abs, { duration: false, skipCovers: true }) : undefined;
      if (meta?.common?.title) title = meta.common.title;
      if (meta?.format?.bitrate) bitRate = Math.round(meta.format.bitrate / 1000);
      // Nullish, not truthy: the scanner keeps a `TPOS: 0`, so a truthy guard
      // here would disagree with it about the identity of the same file.
      disc = meta?.common?.disk?.no ?? null;
    } catch {
      // unreadable — fall back to filename stem + 0 bitrate
    }
    out.push({ name, title, suffix: ext.slice(1), bitRate, disc });
  }
  return out;
}

/**
 * Reconcile one album folder on disk: keep one best copy per track, delete the
 * rest. `canonicalTitles` (from a matching album_jobs row) enables foreign-rip
 * dropping. Skips the shared `Singles` bucket. Deletes only when `apply`.
 */
export async function reconcileAlbumFolder(
  dir: string,
  canonicalTitles: readonly string[] | null,
  opts: { apply?: boolean } = {},
): Promise<ReconcileResult> {
  if (SINGLES_DIR_RE.test(dir)) return { deletedNames: [], keptNames: [], supersededBy: {} };
  const files = await readFolderTracks(dir);
  const result = chooseFolderKeepers(files, canonicalTitles);
  if (opts.apply) {
    for (const name of result.deletedNames) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // leave it; the scanner's existence-based prune will not remove a live file
      }
    }
  }
  return result;
}
