import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { applySchema } from '../db.js';
import { getExternalId, upsertExternalId } from './external-id-store.js';

const freshDb = (): Database => {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
};

describe('external-id-store', () => {
  it('round-trips a Discogs release id', () => {
    const db = freshDb();
    upsertExternalId(db, {
      provider: 'discogs',
      scope: 'release',
      key: 'jose larralde::herencia',
      externalId: '123456',
      source: 'name-search',
    });
    expect(getExternalId(db, 'discogs', 'release', 'jose larralde::herencia')?.externalId).toBe(
      '123456',
    );
  });

  it('keys are independent per provider and scope', () => {
    const db = freshDb();
    upsertExternalId(db, {
      provider: 'discogs',
      scope: 'release',
      key: 'k',
      externalId: 'r1',
      source: 'mbid',
    });
    upsertExternalId(db, {
      provider: 'discogs',
      scope: 'artist',
      key: 'k',
      externalId: 'a1',
      source: 'mbid',
    });
    expect(getExternalId(db, 'discogs', 'release', 'k')?.externalId).toBe('r1');
    expect(getExternalId(db, 'discogs', 'artist', 'k')?.externalId).toBe('a1');
  });

  it('upsert overwrites in place (a re-fetch updates provenance)', () => {
    const db = freshDb();
    upsertExternalId(db, {
      provider: 'discogs',
      scope: 'release',
      key: 'k',
      externalId: 'old',
      source: 'name-search',
    });
    upsertExternalId(db, {
      provider: 'discogs',
      scope: 'release',
      key: 'k',
      externalId: 'new',
      source: 'mbid',
    });
    const row = getExternalId(db, 'discogs', 'release', 'k');
    expect(row?.externalId).toBe('new');
    expect(row?.source).toBe('mbid');
  });

  it('returns null for an unknown key', () => {
    expect(getExternalId(freshDb(), 'discogs', 'release', 'nope')).toBeNull();
  });
});
