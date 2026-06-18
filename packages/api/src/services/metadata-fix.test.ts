/**
 * Tests for the user-driven metadata fix: candidate ranking (pure) and the apply
 * transaction (re-points canonical rows, preserves curation, prunes the orphaned
 * artist) against a real in-memory DB.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Lidarr, LidarrAlbum } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import {
  scoreCandidate,
  rankCandidates,
  searchCandidates,
  applyMetadataFix,
  type FixLidarr,
} from './metadata-fix.js';
import { albumIdFor, artistIdFor } from './library-scanner.js';
import { getOverride } from './metadata-override-store.js';
import { setArtwork } from './artwork-store.js';
import { getReleaseType } from './release-meta-store.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

/** Seed an album + one song + the artist aggregate, mirroring scanner output. */
function seedAlbum(a: { artist: string; album: string; year?: number; songId?: string }): {
  albumId: string;
  artistId: string;
  songId: string;
} {
  const artistId = artistIdFor(a.artist);
  const albumId = albumIdFor(a.artist, a.album);
  const songId = a.songId ?? `song-${a.album}`;
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, year, synced_at)
     VALUES (?, ?, ?, ?, ?, 1, 200, ?, 0)`,
    [albumId, a.album, a.artist, artistId, albumId, a.year ?? null],
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
     VALUES (?, ?, 'T1', ?, ?, 200, ?, 0)`,
    [songId, albumId, a.artist, artistId, `${a.artist}/${a.album}/01.opus`],
  );
  db.run(
    `INSERT INTO library_artists (id, name, album_count, cover_art, synced_at) VALUES (?, ?, 1, ?, 0)`,
    [artistId, a.artist, artistId],
  );
  return { albumId, artistId, songId };
}

function fakeLidarr(hits: Partial<LidarrAlbum>[]): FixLidarr {
  return { album: { lookup: async () => hits as LidarrAlbum[] } } as unknown as Lidarr;
}

describe('scoreCandidate', () => {
  it('is diacritic-insensitive and token-based', () => {
    expect(scoreCandidate('la portuaria selva', 'La Portuária', 'Selva')).toBe(100);
    expect(scoreCandidate('la portuaria', 'La Portuaria', 'Selva')).toBe(100);
    expect(scoreCandidate('la portuaria', 'Completely', 'Different')).toBe(0);
  });
  it('returns 0 for an empty query', () => {
    expect(scoreCandidate('', 'A', 'B')).toBe(0);
  });
});

describe('rankCandidates', () => {
  it('maps fields, sorts best-first and caps the list', () => {
    const hits: Partial<LidarrAlbum>[] = [
      { foreignAlbumId: 'mb-2', title: 'Other', albumType: 'Album', artist: { artistName: 'Nope' } as never },
      {
        foreignAlbumId: 'mb-1',
        title: 'Selva',
        albumType: 'Album',
        releaseDate: '1996-01-01',
        images: [{ coverType: 'cover', url: 'x', remoteUrl: 'http://img/selva.jpg' }],
        artist: { artistName: 'La Portuaria' } as never,
      },
    ];
    const out = rankCandidates(hits as LidarrAlbum[], 'La Portuaria Selva', 8);
    expect(out[0]).toEqual({
      releaseGroupId: 'mb-1',
      artist: 'La Portuaria',
      title: 'Selva',
      year: 1996,
      releaseType: 'album',
      coverUrl: 'http://img/selva.jpg',
      score: 100,
    });
    expect(out[0]!.score).toBeGreaterThanOrEqual(out[1]!.score);
    expect(rankCandidates(hits as LidarrAlbum[], 'x', 1).length).toBe(1);
  });
});

describe('searchCandidates', () => {
  it('returns null for a missing album', async () => {
    expect(await searchCandidates(db, fakeLidarr([]), 'nope')).toBeNull();
  });
  it('defaults the query to "<artist> <album>" and ranks hits', async () => {
    const { albumId } = seedAlbum({ artist: 'La Portuaria', album: 'Selva' });
    const res = await searchCandidates(
      db,
      fakeLidarr([{ foreignAlbumId: 'mb', title: 'Selva', artist: { artistName: 'La Portuaria' } as never }]),
      albumId,
    );
    expect(res?.query).toBe('La Portuaria Selva');
    expect(res?.candidates[0]?.artist).toBe('La Portuaria');
  });
  it('drops a placeholder artist from the default query (searches album only)', async () => {
    // "<Desconocido> Selva" never matches the real band — fall back to "Selva".
    const { albumId } = seedAlbum({ artist: '<Desconocido>', album: 'Selva' });
    const res = await searchCandidates(
      db,
      fakeLidarr([{ foreignAlbumId: 'mb', title: 'Selva', artist: { artistName: 'La Portuaria' } as never }]),
      albumId,
    );
    expect(res?.query).toBe('Selva');
    expect(res?.candidates[0]?.artist).toBe('La Portuaria');
  });
  it('honors an editable query override', async () => {
    const { albumId } = seedAlbum({ artist: '<Desconocido>', album: 'Selva' });
    const res = await searchCandidates(db, fakeLidarr([]), albumId, 'La Portuaria');
    expect(res?.query).toBe('La Portuaria');
  });
});

describe('applyMetadataFix', () => {
  it('returns null when the album is absent', () => {
    expect(applyMetadataFix(db, 'nope', { artist: 'X' })).toBeNull();
  });

  it('re-buckets a mis-tagged artist, preserving curation and pruning the orphan', () => {
    const { albumId, artistId, songId } = seedAlbum({ artist: '<Desconocido>', album: 'Selva' });
    // Curation + references that must survive (songId is path-derived, unchanged).
    db.run('UPDATE library_songs SET starred = ? WHERE id = ?', ['2020-01-01', songId]);
    db.run(
      `INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u-1', 'u', 'h', 'admin', 0)`,
    );
    db.run(
      'INSERT INTO playlists (id, user_id, name, created_at, modified_at) VALUES (?, ?, ?, 0, 0)',
      ['pl-1', 'u-1', 'P'],
    );
    db.run(
      'INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES (?, ?, 0, 0)',
      ['pl-1', songId],
    );
    setArtwork(db, albumId, 'album', 'http://img/OLD.jpg');

    const result = applyMetadataFix(
      db,
      albumId,
      { artist: 'La Portuaria', album: 'Selva', year: 1996, releaseType: 'album', source: 'manual' },
      {},
    );

    const newArtistId = artistIdFor('La Portuaria');
    const newAlbumId = albumIdFor('La Portuaria', 'Selva');
    expect(result).toMatchObject({ albumId: newAlbumId, artistId: newArtistId, artist: 'La Portuaria', movedSongs: 1 });

    // Song moved in place: same id, new artist/album, curation + playlist intact.
    const song = db
      .query<
        { album_id: string; artist: string; artist_id: string; starred: string | null },
        [string]
      >('SELECT album_id, artist, artist_id, starred FROM library_songs WHERE id = ?')
      .get(songId);
    expect(song).toEqual({
      album_id: newAlbumId,
      artist: 'La Portuaria',
      artist_id: newArtistId,
      starred: '2020-01-01',
    });
    expect(db.query('SELECT 1 FROM playlist_songs WHERE song_id = ?').get(songId)).not.toBeNull();

    // Album row moved to the corrected id; old id gone.
    expect(db.query('SELECT id FROM library_albums WHERE id = ?').get(albumId)).toBeNull();
    const alb = db
      .query<{ name: string; artist: string; year: number }, [string]>(
        'SELECT name, artist, year FROM library_albums WHERE id = ?',
      )
      .get(newAlbumId);
    expect(alb).toEqual({ name: 'Selva', artist: 'La Portuaria', year: 1996 });

    // Old artist pruned; new artist present.
    expect(db.query('SELECT 1 FROM library_artists WHERE id = ?').get(artistId)).toBeNull();
    expect(db.query('SELECT name FROM library_artists WHERE id = ?').get(newArtistId)).toEqual({
      name: 'La Portuaria',
    } as never);

    // Side tables re-pointed.
    const art = db
      .query<{ cover_url: string }, [string]>('SELECT cover_url FROM library_artwork WHERE id = ?')
      .get(newAlbumId);
    expect(art?.cover_url).toBe('http://img/OLD.jpg');
    expect(getReleaseType(db, newAlbumId)).toBe('album');

    // Durable override keyed on the raw albumId.
    expect(getOverride(db, albumId)).toEqual({ artist: 'La Portuaria', album: 'Selva', year: 1996 });
  });

  it('overwrites the cover when a candidate cover is confirmed', () => {
    const { albumId } = seedAlbum({ artist: 'X', album: 'A' });
    setArtwork(db, albumId, 'album', 'http://img/OLD.jpg');
    const result = applyMetadataFix(db, albumId, { coverUrl: 'http://img/NEW.jpg', source: 'lidarr' });
    const art = db
      .query<{ cover_url: string }, [string]>('SELECT cover_url FROM library_artwork WHERE id = ?')
      .get(result!.albumId);
    expect(art?.cover_url).toBe('http://img/NEW.jpg');
  });

  it('updates the same raw-keyed override when re-correcting an already-fixed album', () => {
    const { albumId } = seedAlbum({ artist: '<Desconocido>', album: 'Selva' });
    applyMetadataFix(db, albumId, { artist: 'La Portuara', album: 'Selva' }); // typo
    const correctedId = albumIdFor('La Portuara', 'Selva');
    applyMetadataFix(db, correctedId, { artist: 'La Portuaria', album: 'Selva' }); // fix the typo

    const rows = db.query('SELECT raw_album_id FROM library_metadata_overrides').all();
    expect(rows.length).toBe(1); // not orphaned: same raw row updated
    expect(getOverride(db, albumId)).toEqual({ artist: 'La Portuaria', album: 'Selva' });
  });
});
