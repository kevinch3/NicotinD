import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { normalizeArtistForGrouping } from './album-grouping.js';
import {
  RELATION_MIN_SCORE,
  RELATION_TTL_MS,
  artistMbidIndex,
  culturalNeighbours,
  pendingRelationArtists,
  storeSimilarArtists,
} from './artist-relations.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function artist(
  id: string,
  name: string,
  mbid: string | null,
  opts: { albums?: number; hidden?: number; tombstone?: boolean } = {},
): void {
  db.run(
    `INSERT INTO library_artists (id, name, album_count, hidden, split_compound, synced_at)
     VALUES (?, ?, ?, ?, 0, 1)`,
    [id, name, opts.albums ?? 1, opts.hidden ?? 0],
  );
  if (mbid) {
    db.run(
      `INSERT OR REPLACE INTO library_mbids (scope, key, mbid, source, confidence, checked_at)
       VALUES ('artist', ?, ?, ?, ?, 1)`,
      [
        normalizeArtistForGrouping(name),
        mbid,
        opts.tombstone ? 'user' : 'lidarr',
        opts.tombstone ? 0 : 0.9,
      ],
    );
  }
}

describe('artistMbidIndex', () => {
  it('maps library artists to their MBID and back, through the normalized name', () => {
    artist('a1', 'Pink Floyd', 'mb-pf');
    artist('a2', 'No Mbid', null);
    const { mbidOf, artistOf } = artistMbidIndex(db);
    expect([...mbidOf]).toEqual([['a1', 'mb-pf']]);
    expect(artistOf.get('mb-pf')).toBe('a1');
  });

  it('never hands out a tombstoned id, and skips hidden artists', () => {
    artist('a1', 'Wrong Person', 'mb-wrong', { tombstone: true });
    artist('a2', 'Hidden', 'mb-hidden', { hidden: 1 });
    expect(artistMbidIndex(db).mbidOf.size).toBe(0);
  });
});

describe('storeSimilarArtists and culturalNeighbours', () => {
  const similar = [
    { mbid: 'mb-lz', name: 'Led Zeppelin', score: 11_033 },
    { mbid: 'mb-q', name: 'Queen', score: 5_516.5 },
    { mbid: 'mb-x', name: 'Barely Related', score: 110 },
  ];

  it('normalizes each score against the best one, and keeps the raw score', () => {
    storeSimilarArtists(db, 'mb-pf', similar, 1000);
    const rows = db
      .query<{ target_mbid: string; score: number; raw_score: number }, []>(
        'SELECT target_mbid, score, raw_score FROM library_artist_relations ORDER BY score DESC',
      )
      .all();
    expect(rows.map((r) => [r.target_mbid, Number(r.score.toFixed(3)), r.raw_score])).toEqual([
      ['mb-lz', 1, 11_033],
      ['mb-q', 0.5, 5_516.5],
      ['mb-x', 0.01, 110],
    ]);
  });

  it('resolves owned artists to their library id and leaves the rest as discovery rows', () => {
    artist('a1', 'Pink Floyd', 'mb-pf');
    artist('a2', 'Queen', 'mb-q');
    storeSimilarArtists(db, 'mb-pf', similar);
    expect(culturalNeighbours(db, 'a1', 10)).toEqual([
      { id: null, mbid: 'mb-lz', name: 'Led Zeppelin', score: 1, source: 'listenbrainz' },
      { id: 'a2', mbid: 'mb-q', name: 'Queen', score: 0.5, source: 'listenbrainz' },
    ]);
  });

  it('drops relations under the floor', () => {
    artist('a1', 'Pink Floyd', 'mb-pf');
    storeSimilarArtists(db, 'mb-pf', similar);
    const got = culturalNeighbours(db, 'a1', 10)!;
    expect(got.every((n) => n.score >= RELATION_MIN_SCORE)).toBe(true);
    expect(got.map((n) => n.mbid)).not.toContain('mb-x');
  });

  it('tells "not asked yet" (null) from "asked, nothing known" (empty)', () => {
    artist('a1', 'Pink Floyd', 'mb-pf');
    artist('a2', 'No Mbid', null);
    expect(culturalNeighbours(db, 'a1', 10)).toBeNull();
    expect(culturalNeighbours(db, 'a2', 10)).toBeNull();
    storeSimilarArtists(db, 'mb-pf', []);
    expect(culturalNeighbours(db, 'a1', 10)).toEqual([]);
  });

  it('a refetch replaces the earlier answer', () => {
    artist('a1', 'Pink Floyd', 'mb-pf');
    storeSimilarArtists(db, 'mb-pf', similar);
    storeSimilarArtists(db, 'mb-pf', [{ mbid: 'mb-new', name: 'New', score: 3 }]);
    expect(culturalNeighbours(db, 'a1', 10)!.map((n) => n.mbid)).toEqual(['mb-new']);
  });
});

describe('pendingRelationArtists', () => {
  it('lists artists with an MBID that were never asked, biggest first, one per MBID', () => {
    artist('a1', 'Small', 'mb-1', { albums: 1 });
    artist('a2', 'Big', 'mb-2', { albums: 9 });
    artist('a3', 'No Mbid', null);
    expect(pendingRelationArtists(db, 0)).toEqual([
      { id: 'a2', mbid: 'mb-2' },
      { id: 'a1', mbid: 'mb-1' },
    ]);
    expect(pendingRelationArtists(db, 0, 1)).toHaveLength(1);
  });

  it('drops an artist once asked, even when the answer was empty, until the TTL lapses', () => {
    artist('a1', 'Asked', 'mb-1');
    const now = 10 * RELATION_TTL_MS;
    storeSimilarArtists(db, 'mb-1', [], now);
    expect(pendingRelationArtists(db, now - RELATION_TTL_MS)).toEqual([]);
    expect(pendingRelationArtists(db, now + 1)).toEqual([{ id: 'a1', mbid: 'mb-1' }]);
  });
});
