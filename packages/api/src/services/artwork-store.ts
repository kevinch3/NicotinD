import type { Database } from 'bun:sqlite';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LidarrImage } from '@nicotind/lidarr-client';

/**
 * Canonical artwork store (Lidarr/MusicBrainz cover & poster URLs).
 *
 * The cover route (`/api/cover/:id`) prefers these URLs over the file's
 * embedded/folder art, so album thumbnails in the app match the ones the hunt
 * tool shows, and artists get real poster images (audio files carry none).
 *
 * Rows are keyed on the scanner's deterministic ids (`albumIdFor` / `artistIdFor`),
 * which is why this lives in its own `library_artwork` table rather than a column
 * on the scanner-managed `library_albums`/`library_artists` rows: it survives full
 * rescans untouched and can be written at hunt time before the album exists on disk.
 */

export type ArtworkKind = 'album' | 'artist';

/** Canonical-cache filename namespace, kept distinct from disk-art cache ids. */
const CANONICAL_PREFIX = 'c_';
const CACHE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

export interface ResolvedArtwork {
  /** The remote canonical image URL to fetch. */
  url: string;
  /** Cache key (album/artist id) — shared by every request that resolves here. */
  key: string;
}

/**
 * Resolve the canonical artwork for any library id. A direct album/artist hit
 * wins; otherwise a song id maps to its album's artwork so per-track requests
 * (e.g. the player) show the same canonical cover. Returns null when no
 * canonical URL is known — the caller then falls back to on-disk art.
 */
export function resolveArtwork(db: Database, id: string): ResolvedArtwork | null {
  const direct = db
    .query<{ cover_url: string }, [string]>('SELECT cover_url FROM library_artwork WHERE id = ?')
    .get(id);
  if (direct) return { url: direct.cover_url, key: id };

  const song = db
    .query<{ album_id: string }, [string]>('SELECT album_id FROM library_songs WHERE id = ?')
    .get(id);
  if (song) {
    const album = db
      .query<{ cover_url: string }, [string]>('SELECT cover_url FROM library_artwork WHERE id = ?')
      .get(song.album_id);
    if (album) return { url: album.cover_url, key: song.album_id };
  }
  return null;
}

/**
 * Upsert a canonical artwork URL. When the URL changes, purge the stale
 * canonical-cache image so the next request re-fetches the new one. `coverCacheDir`
 * is optional (tests / contexts without a cache dir skip the purge).
 */
export function setArtwork(
  db: Database,
  id: string,
  kind: ArtworkKind,
  url: string,
  coverCacheDir?: string,
): void {
  if (!url) return;
  const prev = db
    .query<{ cover_url: string }, [string]>('SELECT cover_url FROM library_artwork WHERE id = ?')
    .get(id);
  db.run(
    `INSERT INTO library_artwork (id, kind, cover_url, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       cover_url = excluded.cover_url,
       updated_at = excluded.updated_at`,
    [id, kind, url, Date.now()],
  );
  if (coverCacheDir && prev && prev.cover_url !== url) {
    purgeCanonicalCache(coverCacheDir, id);
  }
}

/** Cache filename for a resolved canonical artwork key. */
export function canonicalCacheKey(key: string): string {
  return CANONICAL_PREFIX + key;
}

/**
 * Remove any cached canonical image for a key — the full-size `c_<key>.<ext>`
 * and every resized `c_<key>@<size>.<ext>` thumbnail variant — so a corrected
 * cover doesn't leave stale thumbnails behind (the cover route re-materializes
 * them on the next sized request).
 */
export function purgeCanonicalCache(coverCacheDir: string, key: string): void {
  // Full-size variants by exact name.
  for (const ext of CACHE_EXTS) {
    const p = join(coverCacheDir, CANONICAL_PREFIX + key + ext);
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {
        /* best-effort */
      }
    }
  }
  // Sized variants: `c_<key>@<size>.<ext>` — match by prefix since the size set
  // can grow independently of this module.
  const sizedPrefix = `${CANONICAL_PREFIX}${key}@`;
  let entries: string[];
  try {
    entries = readdirSync(coverCacheDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(sizedPrefix)) {
      try {
        rmSync(join(coverCacheDir, name));
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Lidarr exposes album covers under coverType 'cover'; fall back to the first. */
export function pickAlbumCover(images: LidarrImage[] | undefined): string | undefined {
  const img = images?.find((i) => i.coverType === 'cover') ?? images?.[0];
  return img?.remoteUrl ?? img?.url;
}

/** Lidarr exposes artist photos under coverType 'poster'; fall back to the first. */
export function pickArtistImage(images: LidarrImage[] | undefined): string | undefined {
  const img = images?.find((i) => i.coverType === 'poster') ?? images?.[0];
  return img?.remoteUrl ?? img?.url;
}
