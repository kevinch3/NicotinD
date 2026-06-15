import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  getOverride,
  setOverride,
  loadOverrides,
  findByCorrectedId,
} from './metadata-override-store.js';
import { albumIdFor } from './library-scanner.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('metadata-override-store', () => {
  it('upserts and reads a correction by raw albumId', () => {
    setOverride(db, 'raw-1', { artist: 'La Portuaria', album: 'Selva', year: 1996 });
    expect(getOverride(db, 'raw-1')).toEqual({ artist: 'La Portuaria', album: 'Selva', year: 1996 });

    // Upsert replaces.
    setOverride(db, 'raw-1', { artist: 'La Portuaria', album: 'Huija' });
    expect(getOverride(db, 'raw-1')).toEqual({ artist: 'La Portuaria', album: 'Huija' });
  });

  it('returns null for an unknown id', () => {
    expect(getOverride(db, 'nope')).toBeNull();
  });

  it('loadOverrides returns every mapping', () => {
    setOverride(db, 'a', { artist: 'A', album: 'x' });
    setOverride(db, 'b', { artist: 'B', album: 'y', year: 2000 });
    const map = loadOverrides(db);
    expect(map.size).toBe(2);
    expect(map.get('b')).toEqual({ artist: 'B', album: 'y', year: 2000 });
  });

  it('reverse-resolves by the corrected albumId', () => {
    setOverride(db, 'raw-1', { artist: 'La Portuaria', album: 'Selva' });
    const correctedId = albumIdFor('La Portuaria', 'Selva');
    const row = findByCorrectedId(db, correctedId);
    expect(row?.rawAlbumId).toBe('raw-1');
    expect(findByCorrectedId(db, 'unrelated')).toBeNull();
  });
});
