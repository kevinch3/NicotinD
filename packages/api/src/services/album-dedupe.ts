/**
 * Shared album-folder de-duplication logic, used by both the manual
 * `repair-album-dupes` script and the automatic post-download dedupe in
 * LibraryOrganizer.
 *
 * A folder can accumulate redundant copies of the same track — `02 - Circus.mp3`,
 * `02 - Circus (2).mp3`, plus FLAC/MP3 and case/punctuation variants — which
 * Navidrome then splits into duplicate album cards. `dupKey` collapses only TRUE
 * copies (meaningful qualifiers like "(live)"/"(acoustic)" survive); `pickKeeper`
 * chooses the best copy; `dedupeFolder` removes the rest from one directory.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { AUDIO_EXTS } from './audio-tags.js';

export interface DupFile {
  name: string;
  size: number;
}

/**
 * Normalized identity of a track, collapsing only TRUE duplicate copies:
 * leading track number, a trailing " (N)" integer collision suffix, the
 * extension, and case/punctuation are all stripped. Meaningful qualifiers
 * ("live", "acoustic version", …) survive, so distinct tracks stay distinct.
 */
export function dupKey(filename: string): string {
  const stem = filename.slice(0, filename.length - extname(filename).length);
  return stem
    .replace(/^\d+[\s.\-_]+/, '') // leading track number
    .replace(/\s*\(\d+\)\s*$/, '') // trailing " (2)" collision suffix
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // apostrophe / punctuation variants
    .replace(/\s+/g, ' ')
    .trim();
}

const hasSuffix = (name: string): boolean =>
  /\s*\(\d+\)\s*$/.test(name.slice(0, name.length - extname(name).length));

/**
 * Orders duplicate copies best-first: FLAC over lossy, then larger file (better
 * bitrate / not truncated), then the un-suffixed original, then name. The first
 * element is the keeper; the rest are safe to delete.
 */
export function pickKeeper(files: DupFile[]): DupFile[] {
  return [...files].sort((a, b) => {
    const aFlac = extname(a.name).toLowerCase() === '.flac' ? 0 : 1;
    const bFlac = extname(b.name).toLowerCase() === '.flac' ? 0 : 1;
    if (aFlac !== bFlac) return aFlac - bFlac;
    if (a.size !== b.size) return b.size - a.size;
    const aSuf = hasSuffix(a.name) ? 1 : 0;
    const bSuf = hasSuffix(b.name) ? 1 : 0;
    if (aSuf !== bSuf) return aSuf - bSuf;
    return a.name.localeCompare(b.name);
  });
}

export interface DedupeFolderResult {
  /** Files removed (or that would be removed in a dry run). */
  deleted: Array<{ name: string; size: number; keptName: string }>;
  bytesFreed: number;
}

/**
 * De-duplicate one album directory. Groups its audio files by `dupKey`, keeps
 * the best of each group and removes the rest. When `apply` is false, reports
 * what it would delete without touching disk. `onDelete` fires per removed file
 * (e.g. to append a delete log).
 */
export function dedupeFolder(
  dir: string,
  opts: { apply?: boolean; onDelete?: (filePath: string, file: DupFile, keeper: DupFile) => void } = {},
): DedupeFolderResult {
  const apply = opts.apply ?? false;
  const result: DedupeFolderResult = { deleted: [], bytesFreed: 0 };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }

  const audio: DupFile[] = [];
  for (const name of entries) {
    if (!AUDIO_EXTS.has(extname(name).toLowerCase())) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) audio.push({ name, size: st.size });
    } catch {
      // vanished between readdir and stat — ignore
    }
  }

  const groups = new Map<string, DupFile[]>();
  for (const f of audio) {
    const key = dupKey(f.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  for (const files of groups.values()) {
    if (files.length < 2) continue;
    const [keeper, ...toDelete] = pickKeeper(files);
    for (const d of toDelete) {
      const filePath = join(dir, d.name);
      if (apply) {
        try {
          unlinkSync(filePath);
        } catch {
          continue; // couldn't delete — leave it, don't record
        }
      }
      result.deleted.push({ name: d.name, size: d.size, keptName: keeper.name });
      result.bytesFreed += d.size;
      opts.onDelete?.(filePath, d, keeper);
    }
  }

  return result;
}
