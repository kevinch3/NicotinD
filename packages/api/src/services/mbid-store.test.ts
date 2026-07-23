import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { applySchema } from '../db.js';
import { getMbid, upsertMbid } from './mbid-store.js';

const freshDb = (): Database => {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
};

describe('mbid-store', () => {
  it('round-trips an id', () => {
    const db = freshDb();
    upsertMbid(db, {
      scope: 'artist',
      key: 'jose larralde',
      mbid: 'bd60',
      source: 'tag',
      confidence: 1,
    });
    expect(getMbid(db, 'artist', 'jose larralde')?.mbid).toBe('bd60');
  });

  it('never lets a fuzzy search downgrade a tag-read id', () => {
    const db = freshDb();
    upsertMbid(db, { scope: 'artist', key: 'k', mbid: 'from-tag', source: 'tag', confidence: 1 });
    expect(
      upsertMbid(db, {
        scope: 'artist',
        key: 'k',
        mbid: 'from-search',
        source: 'mb-search',
        confidence: 0.3,
      }),
    ).toBe(false);
    expect(getMbid(db, 'artist', 'k')?.mbid).toBe('from-tag');
  });

  it('lets a user decision override anything', () => {
    const db = freshDb();
    upsertMbid(db, { scope: 'artist', key: 'k', mbid: 'from-tag', source: 'tag', confidence: 1 });
    expect(
      upsertMbid(db, {
        scope: 'artist',
        key: 'k',
        mbid: 'corrected',
        source: 'user',
        confidence: 1,
      }),
    ).toBe(true);
    expect(getMbid(db, 'artist', 'k')?.mbid).toBe('corrected');
  });

  it('returns null for an unknown key', () => {
    expect(getMbid(freshDb(), 'album', 'nope')).toBeNull();
  });
});
