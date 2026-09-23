import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * On-disk-art cover cache, keyed by SOURCE rather than by the requesting id (#1310).
 *
 * The scanner gives every song `coverArt = <songId>`, so a per-id cache stored a
 * folder-art album's one image once per track, plus up to five sizes each. Now
 * the image is stored once under `d_<sha1 of its bytes>` (+ `d_<sha1>@<size>`),
 * and each id keeps only a tiny `<id>.ref` pointer: `{ stamp, key }`.
 *
 * The stamp is the chosen source's `kind|path|mtime|size` — the folder image, or
 * the audio file when the art is embedded — so a per-id lookup costs a stat, not
 * a picture read or a hash. A replaced cover.jpg, a retagged file, or a folder
 * that gains/loses its image changes the stamp and re-resolves; content hashing
 * keeps tracks with genuinely different embedded art on different keys.
 */

export const DISK_ART_PREFIX = 'd_';
export const DISK_ART_REF_EXT = '.ref';

export interface DiskArtRef {
  stamp: string;
  key: string;
}

/** Cache key for disk-art bytes: identical images share one file. */
export function diskArtCacheKey(data: Uint8Array): string {
  return DISK_ART_PREFIX + createHash('sha1').update(data).digest('hex');
}

function parseRef(text: string): DiskArtRef | null {
  try {
    const v = JSON.parse(text) as Partial<DiskArtRef>;
    if (typeof v.stamp !== 'string' || typeof v.key !== 'string') return null;
    // Only ever point into the disk-art namespace — a hand-edited ref must not
    // be able to aim a song at a canonical/remote/override entry.
    if (!/^d_[0-9a-f]{40}$/.test(v.key)) return null;
    return { stamp: v.stamp, key: v.key };
  } catch {
    return null;
  }
}

export async function readDiskArtRef(
  coverCacheDir: string,
  id: string,
): Promise<DiskArtRef | null> {
  try {
    return parseRef(await readFile(join(coverCacheDir, id + DISK_ART_REF_EXT), 'utf8'));
  } catch {
    return null;
  }
}

/** Sync read for the prune, which runs entirely synchronously. */
export function readDiskArtRefFile(path: string): DiskArtRef | null {
  try {
    return parseRef(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeDiskArtRef(
  coverCacheDir: string,
  id: string,
  ref: DiskArtRef,
): Promise<void> {
  await mkdir(coverCacheDir, { recursive: true });
  await writeFile(join(coverCacheDir, id + DISK_ART_REF_EXT), JSON.stringify(ref));
}
