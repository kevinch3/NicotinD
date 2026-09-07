/**
 * Cover-source helpers for the Fix-metadata cover picker.
 *
 * Aggregates the candidate covers a user can choose from when an album's
 * artwork is wrong/stale:
 *   - Lidarr alternatives (deduped cover URLs from the metadata-fix lookup),
 *   - the artwork embedded in the album's *own* tracks (distinct images only).
 *
 * The pure parts (`dedupeCoverUrls`, `selectDistinctEmbeddedCovers`, `hashBytes`)
 * carry the testable logic; the fs/parse side (`extractEmbeddedPicture`,
 * `writeFolderCover`) is thin and injected in tests so unit specs use real temp
 * dirs + a stub extractor instead of mocking node builtins.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getMusicMetadata, type MusicMetadataApi } from './music-metadata-loader.js';

export interface EmbeddedPicture {
  data: Uint8Array;
  contentType: string;
}

/** A song the cover picker can read embedded art from. */
export interface CoverSourceSong {
  id: string;
  /** Absolute path to the audio file. */
  absPath: string;
}

/** Dedupe + drop empty cover URLs, preserving first-seen order. */
export function dedupeCoverUrls(urls: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * Stable content hash of image bytes — length plus a 32-bit FNV-1a fold over the
 * data, so two tracks carrying the same embedded cover collapse to one entry.
 * Pure (no node crypto) to stay trivially unit-testable.
 */
export function hashBytes(data: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `${data.length}:${(h >>> 0).toString(16)}`;
}

/**
 * Resolve the album's tracks to one entry per *distinct* embedded image,
 * deterministically (input order preserved), capped at `limit`. Tracks with no
 * embedded picture are skipped. `extract` is injected so tests don't touch disk.
 */
export async function selectDistinctEmbeddedCovers(
  songs: CoverSourceSong[],
  extract: (absPath: string) => Promise<EmbeddedPicture | null>,
  limit = 8,
): Promise<{ songId: string }[]> {
  const seen = new Set<string>();
  const out: { songId: string }[] = [];
  for (const s of songs) {
    if (out.length >= limit) break;
    let pic: EmbeddedPicture | null;
    try {
      pic = await extract(s.absPath);
    } catch {
      pic = null;
    }
    if (!pic || pic.data.length === 0) continue;
    const key = hashBytes(pic.data);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ songId: s.id });
  }
  return out;
}

/**
 * Read only the embedded picture from an audio file (no folder-art fallback).
 * Returns null when music-metadata is unavailable or the file carries no art.
 */
export async function extractEmbeddedPicture(
  absPath: string,
  loadMM: () => Promise<MusicMetadataApi | null> = getMusicMetadata,
): Promise<EmbeddedPicture | null> {
  try {
    const mm = await loadMM();
    if (!mm) return null;
    const meta = await mm.parseFile(absPath, { duration: false, skipCovers: false });
    const pic = meta.common.picture?.[0];
    if (pic) return { data: new Uint8Array(pic.data), contentType: pic.format || 'image/jpeg' };
  } catch {
    /* ignore */
  }
  return null;
}

function coverFileName(contentType: string): string {
  if (contentType.includes('png')) return 'cover.png';
  if (contentType.includes('webp')) return 'cover.webp';
  return 'cover.jpg';
}

/**
 * Write a picture into an album folder as `cover.<ext>` — the folder-art name the
 * cover route prefers — so it becomes the album's served cover after the
 * canonical override is cleared. Returns the written file's basename.
 */
export function writeFolderCover(albumDir: string, pic: EmbeddedPicture): string {
  const name = coverFileName(pic.contentType);
  writeFileSync(join(albumDir, name), pic.data);
  return name;
}

/**
 * Basenames and extensions the cover route treats as an album's folder image.
 * Shared so the write side (`preserveFolderCover`) and the read side
 * (`folderCover` in routes/streaming.ts) cannot disagree about what counts as
 * "this album already has a cover on disk".
 */
export const COVER_FILE_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
export const COVER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

/** The folder image already present in `dir`, or null. Sync; never throws. */
export function findFolderCoverName(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]));
  for (const base of COVER_FILE_NAMES) {
    for (const ext of COVER_EXTS) {
      const match = lower.get(base + ext);
      if (match) return match;
    }
  }
  return null;
}

/**
 * Materialise a file's embedded cover as the album folder's image, unless one is
 * already there. Best-effort: any failure is swallowed, because this runs beside
 * operations (a transcode, an organize) whose success must not depend on art.
 *
 * Why the folder and not the tag (issue #953): **zero of 1,719 non-mp3 files in
 * the library carry embedded art**, against ~87% of mp3s. `transcodeToOpus`
 * drops it with `-vn` (an attached cover is a video stream) and `-map_metadata`
 * does not bring it back — but simply removing `-vn` would not work either,
 * since ffmpeg's Ogg muxer cannot write an attached picture stream at all; Opus
 * carries art as a base64 `METADATA_BLOCK_PICTURE` comment instead. Writing the
 * folder image sidesteps that entirely: it is one write per album rather than
 * per track, it is format-independent so it also covers the m4a and yt-dlp
 * paths, and it feeds the tier `extractCover` checks **first**.
 *
 * Returns the basename written, or null when nothing was written.
 */
export async function preserveFolderCover(
  absPath: string,
  extract: (p: string) => Promise<EmbeddedPicture | null> = extractEmbeddedPicture,
): Promise<string | null> {
  try {
    const dir = dirname(absPath);
    if (findFolderCoverName(dir)) return null;
    const pic = await extract(absPath);
    if (!pic || pic.data.length === 0) return null;
    return writeFolderCover(dir, pic);
  } catch {
    return null;
  }
}
