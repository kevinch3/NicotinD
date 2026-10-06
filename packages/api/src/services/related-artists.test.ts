import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { computeArtistCentroids, MIN_ARTIST_MEMBERS } from './artist-centroids.js';
import { rankRelated, relatedArtists, type RelatedCandidate } from './related-artists.js';

let db: Database;
let songSeq = 0;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  songSeq = 0;
});

function seedAnalysedArtist(
  id: string,
  vec: number[],
  opts: { hidden?: number; splitCompound?: number; fragmentOf?: string; coverArt?: string } = {},
): void {
  db.run(
    `INSERT INTO library_artists (id, name, album_count, cover_art, hidden, split_compound, fragment_of, synced_at)
     VALUES (?, ?, 2, ?, ?, ?, ?, 1)`,
    [
      id,
      `Name ${id}`,
      opts.coverArt ?? null,
      opts.hidden ?? 0,
      opts.splitCompound ?? 0,
      opts.fragmentOf ?? null,
    ],
  );
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES (?, 'Album', ?, ?, 1, 0, 1)`,
    [`al-${id}`, id, id],
  );
  for (let i = 0; i < MIN_ARTIST_MEMBERS; i++) {
    const sid = `s${++songSeq}`;
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
       VALUES (?, ?, ?, ?, ?, 200, ?, 1000, '2024-01-01', 1)`,
      [sid, `al-${id}`, sid, id, id, `${sid}.opus`],
    );
    db.run(
      `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES (?, ?, 'primary', 0)`,
      [sid, id],
    );
    db.run(
      `INSERT INTO library_embeddings (song_id, model, dim, vec, file_size, updated_at)
       VALUES (?, 'm', ?, ?, 1000, 1)`,
      [sid, vec.length, Buffer.from(new Float32Array(vec).buffer)],
    );
  }
}

describe('relatedArtists', () => {
  it('returns visible library artists with their row fields and the evidence behind them', () => {
    seedAnalysedArtist('seed', [1, 0]);
    seedAnalysedArtist('near', [1, 0.1], { coverArt: 'ar-near' });
    computeArtistCentroids(db);

    const res = relatedArtists(db, 'seed');
    expect('reason' in res).toBe(false);
    expect(res.artists).toHaveLength(1);
    const [a] = res.artists;
    expect(a).toMatchObject({ id: 'near', name: 'Name near', coverArt: 'ar-near', albumCount: 2 });
    expect(a!.signals.audio!.members).toBe(MIN_ARTIST_MEMBERS);
    expect(a!.score).toBeCloseTo(a!.signals.audio!.cosine, 6);
  });

  it('filters hidden, compound and fragment artists at read time, without a rebuild', () => {
    seedAnalysedArtist('seed', [1, 0]);
    seedAnalysedArtist('ok', [1, 0.3]);
    seedAnalysedArtist('compound', [1, 0.01], { splitCompound: 1 });
    seedAnalysedArtist('fragment', [1, 0.02], { fragmentOf: 'ok' });
    seedAnalysedArtist('later-hidden', [1, 0.03]);
    computeArtistCentroids(db);
    expect(relatedArtists(db, 'seed').artists.map((a) => a.id)).toEqual(['later-hidden', 'ok']);

    db.run(`UPDATE library_artists SET hidden = 1 WHERE id = 'later-hidden'`);
    expect(relatedArtists(db, 'seed').artists.map((a) => a.id)).toEqual(['ok']);
  });

  it('says there is no signal for an artist no source knows', () => {
    seedAnalysedArtist('seed', [1, 0]);
    computeArtistCentroids(db);
    expect(relatedArtists(db, 'nobody')).toEqual({ artists: [], reason: 'no-signal' });
    // Known, but alone in the library: an empty row, not "no signal".
    expect(relatedArtists(db, 'seed')).toEqual({ artists: [] });
  });

  it('honours the limit', () => {
    seedAnalysedArtist('seed', [1, 0]);
    for (const [i, y] of [0.1, 0.2, 0.3, 0.4].entries()) seedAnalysedArtist(`n${i}`, [1, y]);
    computeArtistCentroids(db);
    expect(relatedArtists(db, 'seed', 2).artists.map((a) => a.id)).toEqual(['n0', 'n1']);
  });
});

// The contract any ranking rule must keep, whatever it weighs.
describe('rankRelated contract', () => {
  const candidates: RelatedCandidate[] = [0.95, 0.9, 0.85, 0.8, 0.78].map((cosine, i) => ({
    id: `c${i}`,
    signals: { audio: { cosine, members: 3 + i * 10, coherence: 0.8 } },
  }));

  it('returns at most `limit` picks, drawn from the candidates, best first', () => {
    const picks = rankRelated(candidates, 3);
    expect(picks.length).toBeLessThanOrEqual(3);
    const ids = new Set(candidates.map((c) => c.id));
    for (const p of picks) expect(ids.has(p.id)).toBe(true);
    for (let i = 1; i < picks.length; i++) {
      expect(picks[i - 1]!.score).toBeGreaterThanOrEqual(picks[i]!.score);
    }
    expect(new Set(picks.map((p) => p.id)).size).toBe(picks.length);
  });

  it('drops everything when nothing is close', () => {
    const far = candidates.map((c) => ({
      ...c,
      signals: { audio: { ...c.signals.audio!, cosine: 0.2 } },
    }));
    expect(rankRelated(far, 12)).toEqual([]);
  });

  it('is empty for no candidates', () => {
    expect(rankRelated([], 12)).toEqual([]);
  });
});
