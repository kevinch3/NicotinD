import type { Database } from 'bun:sqlite';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createLogger } from '@nicotind/core';
import { folderArtBelongsToAlbum } from './album-folder.js';
import { COVER_EXTS, COVER_FILE_NAMES } from './cover-sources.js';
import { bumpCoverRev } from './cover-rev.js';

const log = createLogger('album-art-stamp');

/** An album folder's image (cover.jpg, folder.jpg, …) as an absolute path, or null. */
export async function folderImagePath(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]));
  for (const base of COVER_FILE_NAMES) {
    for (const ext of COVER_EXTS) {
      const match = lower.get(base + ext);
      if (match) return join(dir, match);
    }
  }
  return null;
}

/**
 * The stamp of the on-disk image the cover route would pick for a track,
 * without reading it: the album folder's image when folder art applies (never
 * in a shared bucket, #978), else the audio file itself (embedded art).
 * `kind|path|mtime|size`, so a replaced cover.jpg, a retagged file, or a folder
 * that gains or loses its image changes it (#1310, #1752).
 */
export async function diskArtSource(
  db: Database,
  track: { abs: string; relPath: string },
): Promise<{ stamp: string; folderImage: string | null } | null> {
  const folderImage = folderArtBelongsToAlbum(db, track.relPath)
    ? await folderImagePath(dirname(track.abs))
    : null;
  const statPath = folderImage ?? track.abs;
  try {
    const st = await stat(statPath);
    return {
      stamp: `${folderImage ? 'f' : 'e'}|${statPath}|${st.mtimeMs}|${st.size}`,
      folderImage,
    };
  } catch {
    return null;
  }
}

/**
 * The album's representative track, exactly as the cover route resolves an
 * album id: its first track (lowest disc/track), so the folder image found is
 * the album's real cover. Null outside the music root.
 */
export function albumRepresentativeTrack(
  db: Database,
  musicRoot: string,
  albumId: string,
): { abs: string; relPath: string } | null {
  const row = db
    .query<{ path: string }, [string]>(
      `SELECT path FROM library_songs WHERE album_id = ?
         ORDER BY COALESCE(disc, 1), COALESCE(track, 999999), path LIMIT 1`,
    )
    .get(albumId);
  if (!row) return null;
  const root = resolve(musicRoot);
  const abs = resolve(join(root, row.path));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return { abs, relPath: row.path };
}

/** The stored marker for "recorded, and the album has no on-disk art". */
const NO_ART = '';

/**
 * Re-stamp these albums' on-disk art and bump `cover_rev` for every album whose
 * art changed since the last scan (#1752). The service-layer writers bump the
 * rev for a cover set through the app; this catches the ones that change on
 * disk — a hand-swapped cover.jpg, a re-download replacing folder art, new
 * embedded art — which the cover route would otherwise keep serving under the
 * same versioned URL.
 *
 * `library_albums.art_stamp` is NULL until an album is first stamped, and that
 * first stamp records without bumping (no churn on the deploy's first scan).
 * '' records "no art", so an album that later gains a cover is a change.
 * Returns the ids whose rev was bumped.
 */
export async function refreshAlbumArtStamps(
  db: Database,
  musicRoot: string,
  albumIds: Iterable<string>,
): Promise<string[]> {
  const bumped: string[] = [];
  const ids = [...new Set(albumIds)];
  const read = db.query<{ art_stamp: string | null }, [string]>(
    'SELECT art_stamp FROM library_albums WHERE id = ?',
  );
  const write = db.query('UPDATE library_albums SET art_stamp = ? WHERE id = ?');
  // A bounded batch of stats at a time: a full scan stamps every album.
  for (let i = 0; i < ids.length; i += 32) {
    const batch = ids.slice(i, i + 32);
    const stamps = await Promise.all(
      batch.map(async (id) => {
        const track = albumRepresentativeTrack(db, musicRoot, id);
        const source = track ? await diskArtSource(db, track) : null;
        return { id, stamp: source?.stamp ?? NO_ART };
      }),
    );
    for (const { id, stamp } of stamps) {
      const row = read.get(id);
      if (!row || row.art_stamp === stamp) continue;
      write.run(stamp, id);
      if (row.art_stamp !== null) {
        bumpCoverRev(db, 'album', id);
        bumped.push(id);
      }
    }
  }
  if (bumped.length) log.info({ albums: bumped.length }, 'on-disk cover changed; cover_rev bumped');
  return bumped;
}
