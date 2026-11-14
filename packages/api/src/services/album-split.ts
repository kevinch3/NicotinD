import type { Database } from 'bun:sqlite';
import { relative } from 'node:path';
import { albumIdFor } from './library-scanner.js';
import { setSongAlbumOverride } from './metadata-override-store.js';
import { setReleaseType, type ReleaseType } from './release-meta-store.js';
import { expandDir, resolveSongPath } from './song-path.js';

/**
 * Split one album row that holds several releases into separate albums (#1866),
 * e.g. a double-album rip "Winelight / The Best Is Yet to Come".
 *
 * Each group's songs get a durable song-scoped album override
 * (`library_song_album_overrides`), then only those files are rescanned. The
 * scanner applies the override in `resolveTags`, so the re-bucket, the new album
 * rows and every aggregate come from the same code a full rescan runs, and a full
 * rescan reproduces the split. No file moves, so song ids (path-derived), likes,
 * playlists and history stay put. The result is read back, never assumed.
 */

export interface SplitGroup {
  songIds: string[];
  album: string;
  year?: number;
  releaseType?: ReleaseType;
  /** Album artist; defaults to the source album's. */
  artist?: string;
}

export interface SplitAlbumDeps {
  musicDir?: string;
  scanIncremental?: (relPaths: string[]) => Promise<void>;
}

export interface SplitAlbumResult {
  ok: true;
  albums: Array<{
    albumId: string;
    album: string;
    artist: string;
    year: number | null;
    songIds: string[];
  }>;
  /** Songs whose row did not land in its group's album after the rescan. */
  notApplied: Array<{ songId: string; expectedAlbumId: string; actualAlbumId: string | null }>;
  /** Songs left in the source album (it is gone when this is 0). */
  remaining: number;
}

export type SplitAlbumOutcome = SplitAlbumResult | { ok: false; error: string };

/** Pure validation, so every refusal is testable without a library. */
export function validateSplit(
  albumSongIds: ReadonlySet<string>,
  groups: readonly SplitGroup[],
): string | null {
  if (groups.length === 0) return 'At least one group is required';
  const seen = new Set<string>();
  for (const [i, g] of groups.entries()) {
    if (!g.album?.trim()) return `Group ${i + 1} has no album title`;
    if (g.songIds.length === 0) return `Group ${i + 1} has no songs: it would make an empty album`;
    for (const id of g.songIds) {
      if (!albumSongIds.has(id)) return `Song ${id} is not on this album`;
      if (seen.has(id)) return `Song ${id} is in more than one group`;
      seen.add(id);
    }
  }
  return null;
}

export async function splitAlbum(
  db: Database,
  deps: SplitAlbumDeps,
  albumId: string,
  groups: readonly SplitGroup[],
): Promise<SplitAlbumOutcome> {
  const album = db
    .query<{ artist: string }, [string]>('SELECT artist FROM library_albums WHERE id = ?')
    .get(albumId);
  if (!album) return { ok: false, error: 'Album not found' };
  if (!deps.musicDir || !deps.scanIncremental) {
    return { ok: false, error: 'Rescanning is not available on this server' };
  }
  const songs = db
    .query<{ id: string; path: string }, [string]>(
      'SELECT id, path FROM library_songs WHERE album_id = ?',
    )
    .all(albumId);
  const pathOf = new Map(songs.map((s) => [s.id, s.path]));
  const invalid = validateSplit(new Set(pathOf.keys()), groups);
  if (invalid) return { ok: false, error: invalid };

  const planned = groups.map((g) => {
    const artist = g.artist?.trim() || album.artist;
    const name = g.album.trim();
    return { group: g, artist, name, albumId: albumIdFor(artist, name) };
  });

  db.transaction(() => {
    for (const p of planned) {
      for (const songId of p.group.songIds) {
        setSongAlbumOverride(
          db,
          songId,
          { album: p.name, artist: p.artist, year: p.group.year },
          { source: 'manual' },
        );
      }
    }
  })();

  const md = expandDir(deps.musicDir);
  const relPaths = planned.flatMap((p) =>
    p.group.songIds.map((id) => relative(md, resolveSongPath(md, pathOf.get(id)!))),
  );
  await deps.scanIncremental(relPaths);

  const actualAlbum = db.query<{ album_id: string }, [string]>(
    'SELECT album_id FROM library_songs WHERE id = ?',
  );
  const notApplied: SplitAlbumResult['notApplied'] = [];
  for (const p of planned) {
    for (const songId of p.group.songIds) {
      const actual = actualAlbum.get(songId)?.album_id ?? null;
      if (actual !== p.albumId)
        notApplied.push({ songId, expectedAlbumId: p.albumId, actualAlbumId: actual });
    }
    if (p.group.releaseType) {
      setReleaseType(db, p.albumId, p.group.releaseType, {
        canonicalTitle: p.name,
        source: 'manual',
      });
    }
  }

  const yearOf = db.query<{ year: number | null }, [string]>(
    'SELECT year FROM library_albums WHERE id = ?',
  );
  const remaining =
    db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM library_songs WHERE album_id = ?')
      .get(albumId)?.n ?? 0;
  return {
    ok: true,
    albums: planned.map((p) => ({
      albumId: p.albumId,
      album: p.name,
      artist: p.artist,
      year: yearOf.get(p.albumId)?.year ?? null,
      songIds: p.group.songIds,
    })),
    notApplied,
    remaining,
  };
}
