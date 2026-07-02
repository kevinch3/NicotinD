// packages/api/src/services/album-reconcile.ts
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { AUDIO_EXTS } from './audio-tags.js';
import { getMusicMetadata } from './music-metadata-loader.js';
import { selectAlbumTracks, type SelectableTrack } from './library-track-select.js';

/** Album folders that must never be collapsed as one album (each loose track is its own single). */
export const SINGLES_DIR_RE = /(^|[/\\])Singles$/i;

export interface ReconcileFile {
  name: string;
  title: string;
  suffix: string;
  bitRate: number;
}

export interface ReconcileResult {
  deletedNames: string[];
  keptNames: string[];
}

/**
 * Pure keeper-selection for one album folder. Uses the SAME identity + quality
 * ranking as the library scanner (`selectAlbumTracks`): canonical-title match
 * (dropping foreign rips) when `canonicalTitles` is given, else normalized title,
 * FLAC > lossy > bitrate, ties on smallest name. Returns which files to keep vs
 * delete. No IO — directly unit-testable.
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
  }));
  const kept = new Set(selectAlbumTracks(selectable, canonicalTitles).map((t) => t.name));
  const keptNames: string[] = [];
  const deletedNames: string[] = [];
  for (const x of files) (kept.has(x.name) ? keptNames : deletedNames).push(x.name);
  return { keptNames, deletedNames };
}

/** Read a folder's audio files into ReconcileFile[] (title via tag, fallback filename stem). */
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
    if (!AUDIO_EXTS.has(ext)) continue;
    const abs = join(dir, name);
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    let title = name.slice(0, name.length - ext.length);
    let bitRate = 0;
    try {
      const meta = mm ? await mm.parseFile(abs, { duration: false, skipCovers: true }) : undefined;
      if (meta?.common?.title) title = meta.common.title;
      if (meta?.format?.bitrate) bitRate = Math.round(meta.format.bitrate / 1000);
    } catch {
      // unreadable — fall back to filename stem + 0 bitrate
    }
    out.push({ name, title, suffix: ext.slice(1), bitRate });
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
  if (SINGLES_DIR_RE.test(dir)) return { deletedNames: [], keptNames: [] };
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
