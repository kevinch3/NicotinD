import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  getReleaseType,
  setReleaseType,
  loadReleaseTypes,
  mapLidarrAlbumType,
} from './release-meta-store.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('mapLidarrAlbumType', () => {
  it('maps known Lidarr types', () => {
    expect(mapLidarrAlbumType('Album')).toBe('album');
    expect(mapLidarrAlbumType('EP')).toBe('ep');
    expect(mapLidarrAlbumType('Single')).toBe('single');
    expect(mapLidarrAlbumType('Compilation')).toBe('compilation');
  });

  it('returns null for unmappable types so the caller falls back to heuristic', () => {
    expect(mapLidarrAlbumType('Broadcast')).toBeNull();
    expect(mapLidarrAlbumType('Other')).toBeNull();
    expect(mapLidarrAlbumType(undefined)).toBeNull();
  });
});

describe('release-meta-store', () => {
  it('upserts and reads a release type keyed on album id', () => {
    setReleaseType(db, 'alb-1', 'single', { canonicalTitle: 'Mi Canción', source: 'lidarr' });
    expect(getReleaseType(db, 'alb-1')).toBe('single');
  });

  it('returns null for an unknown album id', () => {
    expect(getReleaseType(db, 'missing')).toBeNull();
  });

  it('updates the type on conflict', () => {
    setReleaseType(db, 'alb-1', 'single');
    setReleaseType(db, 'alb-1', 'ep');
    expect(getReleaseType(db, 'alb-1')).toBe('ep');
  });

  it('survives a simulated full rescan of library_albums (side table untouched)', () => {
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
       VALUES ('alb-1', 'X', 'A', 'art-1', 1, 0, 'single', 1)`,
    );
    setReleaseType(db, 'alb-1', 'single', { source: 'lidarr' });
    // Prune + re-insert the album row (what scanFull does).
    db.run('DELETE FROM library_albums');
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
       VALUES ('alb-1', 'X', 'A', 'art-1', 1, 0, 'unknown', 2)`,
    );
    expect(getReleaseType(db, 'alb-1')).toBe('single');
  });

  it('loads every mapping for the curator', () => {
    setReleaseType(db, 'a', 'album');
    setReleaseType(db, 'b', 'ep');
    const map = loadReleaseTypes(db);
    expect(map.get('a')).toBe('album');
    expect(map.get('b')).toBe('ep');
    expect(map.size).toBe(2);
  });
});
