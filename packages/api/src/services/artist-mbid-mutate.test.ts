import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { mutateArtistMbid } from './artist-mbid-mutate.js';
import { getArtistMeta, upsertArtistMeta } from './artist-meta-store.js';
import { normalizeArtistForGrouping } from './album-grouping.js';
import { getMbid, isMbidTombstoned, upsertMbid, usableMbid } from './mbid-store.js';

let db: Database;

/** The real #1112 case: an mbid pointing at the Israeli psytrance producer while
 *  every song filed under "Rocky" is the French electro-pop band from Lille. */
const WRONG = 'c7b8495c-8cec-4aac-b051-19578bbd4ade';
const RIGHT = 'ac0ee862-a6ca-4d39-a7a4-d8460534ba30';

const key = (): string => normalizeArtistForGrouping('Rocky');

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_artists (id, name, album_count, hidden, synced_at) VALUES ('a1', 'Rocky', 0, 0, 1)`,
  );
  upsertMbid(db, { scope: 'artist', key: key(), mbid: WRONG, source: 'lidarr', confidence: 0.8 });
});

describe('mutateArtistMbid (#1112)', () => {
  it('pins a replacement id as a user decision', () => {
    const r = mutateArtistMbid(db, 'a1', RIGHT);
    expect(r.ok).toBe(true);
    expect(getMbid(db, 'artist', key())).toMatchObject({
      mbid: RIGHT,
      source: 'user',
      confidence: 1,
    });
  });

  it('reports what it replaced, so the wrong identity is on the record', () => {
    const r = mutateArtistMbid(db, 'a1', RIGHT);
    expect(r.ok && r.previous).toMatchObject({ mbid: WRONG, source: 'lidarr' });
  });

  it('accepts an uppercase id and stores it canonically', () => {
    expect(mutateArtistMbid(db, 'a1', RIGHT.toUpperCase()).ok).toBe(true);
    expect(getMbid(db, 'artist', key())?.mbid).toBe(RIGHT);
  });

  it('rejects a non-UUID rather than storing a value no provider can resolve', () => {
    const r = mutateArtistMbid(db, 'a1', 'the french one');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(getMbid(db, 'artist', key())?.mbid).toBe(WRONG); // unchanged
  });

  it('404s on an unknown artist', () => {
    expect(mutateArtistMbid(db, 'nope', RIGHT)).toMatchObject({ ok: false, status: 404 });
  });

  it('treats a missing key as an error but null as a decision', () => {
    expect(mutateArtistMbid(db, 'a1', undefined)).toMatchObject({ ok: false, status: 400 });
    expect(mutateArtistMbid(db, 'a1', null).ok).toBe(true);
  });

  describe('the tombstone', () => {
    it('detaches the identity and reads as no usable id', () => {
      expect(mutateArtistMbid(db, 'a1', null).ok).toBe(true);
      const row = getMbid(db, 'artist', key());
      expect(isMbidTombstoned(row)).toBe(true);
      expect(usableMbid(row)).toBeNull();
    });

    it('keeps the rejected id as provenance without handing it out', () => {
      mutateArtistMbid(db, 'a1', null);
      // Which id was wrong is exactly what a later investigation needs; the row
      // holds it, and every reader goes through `usableMbid`, which does not.
      expect(getMbid(db, 'artist', key())?.mbid).toBe(WRONG);
      expect(usableMbid(getMbid(db, 'artist', key()))).toBeNull();
    });

    it('survives a later automatic pass — the whole point over a delete', () => {
      mutateArtistMbid(db, 'a1', null);
      // This is what the next enrichment window does with a name it thinks is
      // unresolved. A deleted row would take this write and re-attach the homonym.
      upsertMbid(db, {
        scope: 'artist',
        key: key(),
        mbid: WRONG,
        source: 'lidarr',
        confidence: 0.8,
      });
      expect(isMbidTombstoned(getMbid(db, 'artist', key()))).toBe(true);
    });

    it('is meaningful even when nothing was attached yet', () => {
      const fresh = new Database(':memory:');
      applySchema(fresh);
      fresh.run(
        `INSERT INTO library_artists (id, name, album_count, hidden, synced_at) VALUES ('a1', 'Rocky', 0, 0, 1)`,
      );
      // Pre-empting a resolution a curator already knows is wrong.
      expect(mutateArtistMbid(fresh, 'a1', null).ok).toBe(true);
      expect(isMbidTombstoned(getMbid(fresh, 'artist', key()))).toBe(true);
    });

    it('can be lifted by pinning a real id', () => {
      mutateArtistMbid(db, 'a1', null);
      expect(mutateArtistMbid(db, 'a1', RIGHT).ok).toBe(true);
      const row = getMbid(db, 'artist', key());
      expect(isMbidTombstoned(row)).toBe(false);
      expect(usableMbid(row)).toBe(RIGHT);
    });
  });

  describe('the derived bio moves with the identity (#1114)', () => {
    it('drops a derived bio, so the page cannot contradict itself', () => {
      upsertArtistMeta(db, {
        artistId: 'a1',
        bio: 'Progressive psychedelic trance DJ producer based in Herzelia, Israel',
        urls: [],
        source: 'discogs',
        mbid: WRONG,
      });
      const r = mutateArtistMbid(db, 'a1', RIGHT);
      expect(r.ok && r.clearedBio).toBe(true);
      // Absent, not blanked: `artist-info`'s pending set is `NOT EXISTS`, so this
      // is what makes the next pass refetch from the id just pinned.
      expect(getArtistMeta(db, 'a1')).toBeNull();
    });

    it('leaves a curator’s manual bio alone — they have already overruled the derivation', () => {
      upsertArtistMeta(db, {
        artistId: 'a1',
        bio: 'The French electro-pop band from Lille',
        urls: [],
        source: 'user',
        manualOverride: true,
      });
      const r = mutateArtistMbid(db, 'a1', RIGHT);
      expect(r.ok && r.clearedBio).toBe(false);
      expect(getArtistMeta(db, 'a1')?.bio).toBe('The French electro-pop band from Lille');
    });

    it('reports no bio drop when there was none', () => {
      const r = mutateArtistMbid(db, 'a1', null);
      expect(r.ok && r.clearedBio).toBe(false);
    });
  });
});
