import { describe, expect, it } from 'bun:test';
import {
  CURATED_PLAYLISTS,
  selectCuratedTracks,
  type CandidateRow,
} from './curated-playlists.js';

function rows(spec: Array<[artist: string, count: number]>): CandidateRow[] {
  const out: CandidateRow[] = [];
  let n = 0;
  for (const [artist, count] of spec) {
    for (let i = 0; i < count; i++) out.push({ id: `${artist}-${i}-${n++}`, artist });
  }
  return out;
}

describe('CURATED_PLAYLISTS', () => {
  it('has 15 playlists with unique slugs and names', () => {
    expect(CURATED_PLAYLISTS).toHaveLength(15);
    expect(new Set(CURATED_PLAYLISTS.map((p) => p.slug)).size).toBe(15);
    expect(new Set(CURATED_PLAYLISTS.map((p) => p.name)).size).toBe(15);
  });

  it('every def has a where clause and sane sizing', () => {
    for (const p of CURATED_PLAYLISTS) {
      expect(p.where.trim().length).toBeGreaterThan(0);
      expect(p.targetSize).toBeGreaterThan(0);
      expect(p.maxPerArtist).toBeGreaterThan(0);
    }
  });
});

describe('selectCuratedTracks', () => {
  it('never exceeds maxPerArtist for any artist', () => {
    const picked = selectCuratedTracks(rows([['A', 50], ['B', 50], ['C', 50]]), {
      targetSize: 40,
      maxPerArtist: 2,
    });
    const perArtist = new Map<string, number>();
    for (const id of picked) {
      const artist = id.split('-')[0];
      perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
    }
    for (const count of perArtist.values()) expect(count).toBeLessThanOrEqual(2);
  });

  it('caps at targetSize when supply is ample', () => {
    // 30 artists × 5 tracks, cap 2 → 60 eligible, more than the target of 40.
    const ample = rows(Array.from({ length: 30 }, (_, i) => [`A${i}`, 5] as [string, number]));
    const picked = selectCuratedTracks(ample, { targetSize: 40, maxPerArtist: 2 });
    expect(picked).toHaveLength(40);
  });

  it('returns a shorter list when the per-artist cap exhausts the supply', () => {
    // 3 artists × cap 2 = at most 6, even though targetSize is 30.
    const picked = selectCuratedTracks(rows([['A', 20], ['B', 20], ['C', 20]]), {
      targetSize: 30,
      maxPerArtist: 2,
    });
    expect(picked).toHaveLength(6);
  });

  it('produces no duplicate ids', () => {
    const picked = selectCuratedTracks(rows([['A', 30], ['B', 30]]), {
      targetSize: 40,
      maxPerArtist: 5,
    });
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('is deterministic for a given seed and varies across seeds', () => {
    const input = rows([['A', 50], ['B', 50], ['C', 50]]);
    const a1 = selectCuratedTracks(input, { targetSize: 20, maxPerArtist: 5, seed: 7 });
    const a2 = selectCuratedTracks(input, { targetSize: 20, maxPerArtist: 5, seed: 7 });
    const b = selectCuratedTracks(input, { targetSize: 20, maxPerArtist: 5, seed: 99 });
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });
});

describe('expandGenreWhere (multi-genre recipe predicates)', () => {
  it('rewrites s.genre to the full-set expression so LIKE sees every genre', async () => {
    const { expandGenreWhere, GENRE_SET_EXPR } = await import('./curated-playlists.js');
    const where = "(s.genre LIKE '%house%' OR s.genre LIKE '%techno%') AND s.bpm > 0";
    const out = expandGenreWhere(where);
    expect(out).not.toContain('s.genre ');
    expect(out).toContain(GENRE_SET_EXPR);
    expect(out.endsWith('AND s.bpm > 0')).toBe(true);
  });

  it('matches a song whose SECONDARY genre satisfies the predicate', async () => {
    const { Database } = await import('bun:sqlite');
    const { applySchema } = await import('../db.js');
    const { expandGenreWhere } = await import('./curated-playlists.js');
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, genre, path, size, suffix, content_type, synced_at, hidden)
       VALUES ('s1', 'al1', 'T', 'A', 'ar1', 200, 'Electronic', 'p1', 1, 'mp3', 'audio/mpeg', 0, 0)`,
    );
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES ('s1', 'Electronic', 0)`);
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES ('s1', 'House', 1)`);
    const rows = db
      .query<{ id: string }, []>(
        `SELECT s.id FROM library_songs s WHERE ${expandGenreWhere("s.genre LIKE '%house%'")}`,
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual(['s1']);
  });
});
