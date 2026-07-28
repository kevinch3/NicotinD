import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { artistGenreDistribution, MAX_AXES } from './genre-distribution.js';

function db(): Database {
  const d = new Database(':memory:');
  applySchema(d);
  d.run(
    `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('a1', 'Test', 1, 1)`,
  );
  return d;
}

/** Add a landed song by `a1` carrying `genres` (position 0 = primary). */
function song(d: Database, id: string, genres: string[], landed = 1): void {
  d.run(
    `INSERT INTO library_songs (id, title, artist, artist_id, album_id, path, landed_at, synced_at)
     VALUES (?, ?, 'Test', 'a1', 'al1', ?, ?, 1)`,
    [id, id, `/m/${id}.flac`, landed],
  );
  genres.forEach((g, i) =>
    d.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES (?, ?, ?)`, [
      id,
      g,
      i,
    ]),
  );
}

describe('artistGenreDistribution', () => {
  it('weights each genre by the share of tracks carrying it', () => {
    const d = db();
    song(d, 's1', ['Cumbia']);
    song(d, 's2', ['Cumbia']);
    song(d, 's3', ['Rock']);
    song(d, 's4', ['Rock']);

    const dist = artistGenreDistribution(d, 'a1');

    expect(dist.trackCount).toBe(4);
    expect(dist.slices).toEqual([
      { genre: 'Cumbia', count: 2, weight: 0.5 },
      { genre: 'Rock', count: 2, weight: 0.5 },
    ]);
  });

  it('counts extras, not just the primary — weights need not sum to 1', () => {
    const d = db();
    song(d, 's1', ['Cumbia', 'Folk']);
    song(d, 's2', ['Cumbia']);

    const dist = artistGenreDistribution(d, 'a1');

    expect(dist.slices).toEqual([
      { genre: 'Cumbia', count: 2, weight: 1 },
      { genre: 'Folk', count: 1, weight: 0.5 },
    ]);
    // Overlapping sets: treating these as part-to-whole would under-report both.
    expect(dist.slices.reduce((n, s) => n + s.weight, 0)).toBeGreaterThan(1);
  });

  it('never reports a weight above 1 — no axis can escape the outer ring', () => {
    const d = db();
    song(d, 's1', ['Cumbia', 'Folk', 'Rock']);
    song(d, 's2', ['Cumbia', 'Folk']);

    const dist = artistGenreDistribution(d, 'a1');

    // library_song_genres is UNIQUE(song_id, genre), so a genre can be counted
    // at most once per track — the radar's radius is always in range.
    for (const s of dist.slices) expect(s.weight).toBeLessThanOrEqual(1);
  });

  it('excludes quarantined tracks that have not landed', () => {
    const d = db();
    song(d, 's1', ['Cumbia']);
    d.run(
      `INSERT INTO library_songs (id, title, artist, artist_id, album_id, path, landed_at, synced_at)
       VALUES ('s2', 's2', 'Test', 'a1', 'al1', '/m/s2.flac', NULL, 1)`,
    );
    d.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES ('s2', 'Rock', 0)`);

    const dist = artistGenreDistribution(d, 'a1');
    expect(dist.trackCount).toBe(1);
    expect(dist.slices.map((s) => s.genre)).toEqual(['Cumbia']);
  });

  it('folds everything past the axis cap into a single "Other"', () => {
    const d = db();
    for (let i = 0; i < MAX_AXES + 3; i++) {
      // Descending counts so the fold order is deterministic.
      for (let j = 0; j <= MAX_AXES + 3 - i; j++) song(d, `s${i}-${j}`, [`G${i}`]);
    }

    const dist = artistGenreDistribution(d, 'a1');

    expect(dist.slices).toHaveLength(MAX_AXES + 1);
    expect(dist.slices.at(-1)?.genre).toBe('Other');
    expect(dist.genreCount).toBe(MAX_AXES + 3);
  });

  it('caps the folded "Other" weight at 1 rather than summing past the whole', () => {
    const d = db();
    // One track carrying many low-frequency genres: the naive sum would exceed
    // trackCount and render an axis past the outer ring.
    song(d, 's1', ['Top', 'Top2']);
    song(d, 's2', ['Top', 'Top2']);
    for (let i = 0; i < MAX_AXES + 5; i++) {
      d.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES ('s1', ?, ?)`, [
        `X${i}`,
        i + 2,
      ]);
    }

    const other = artistGenreDistribution(d, 'a1').slices.at(-1);
    expect(other?.genre).toBe('Other');
    expect(other?.weight).toBeLessThanOrEqual(1);
  });

  it('returns an empty distribution for an artist with no landed tracks', () => {
    expect(artistGenreDistribution(db(), 'a1')).toEqual({
      trackCount: 0,
      genreCount: 0,
      slices: [],
    });
  });
});
