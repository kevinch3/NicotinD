import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  MAX_NEXT_UP,
  MAX_SCENARIOS,
  RadioPollGenerationError,
  generatePollScenarios,
  mergePollWeights,
  normalizePollSettings,
  stripFeatures,
} from './radio-poll-generate.js';
import { DEFAULT_WEIGHTS } from './radio.service.js';

let db: Database;

function seedSong(s: {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  albumId?: string;
  genre?: string;
  bpm?: number;
  landed?: boolean;
  hidden?: boolean;
}): void {
  const artistId = s.artistId ?? s.artist;
  const albumId = s.albumId ?? `alb-${s.id}`;
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
     VALUES (?, ?, ?, ?, 1, 0, '2024-01-01', 0)`,
    [albumId, `Album ${s.id}`, s.artist, artistId],
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, genre, bpm, landed_at, hidden, synced_at)
     VALUES (?, ?, ?, ?, ?, 240, ?, 0, 320, 'mp3', 'audio/mpeg', '2024-01-01', ?, ?, ?, ?, 0)`,
    [
      s.id,
      albumId,
      s.title,
      s.artist,
      artistId,
      `/music/${s.id}.mp3`,
      s.genre ?? null,
      s.bpm ?? null,
      s.landed === false ? null : 1,
      s.hidden ? 1 : 0,
    ],
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('mergePollWeights', () => {
  it('merges overrides onto the defaults', () => {
    const w = mergePollWeights({ genre: 30 });
    expect(w.genre).toBe(30);
    expect(w.bpm).toBe(DEFAULT_WEIGHTS.bpm);
  });

  it('rejects an unknown axis instead of silently ignoring it', () => {
    expect(() => mergePollWeights({ vibes: 5 })).toThrow(RadioPollGenerationError);
  });

  it('rejects a non-finite value', () => {
    expect(() => mergePollWeights({ genre: Number.NaN })).toThrow(RadioPollGenerationError);
  });

  it('returns the plain defaults with no overrides', () => {
    expect(mergePollWeights(undefined)).toEqual(DEFAULT_WEIGHTS);
  });
});

describe('normalizePollSettings', () => {
  it('clamps counts into range', () => {
    const s = normalizePollSettings({ scenarioCount: 99, nextUpCount: 0 });
    expect(s.scenarioCount).toBe(MAX_SCENARIOS);
    expect(s.nextUpCount).toBe(1);
  });

  it('falls back on non-numeric counts', () => {
    const s = normalizePollSettings({
      scenarioCount: 'x' as unknown as number,
      nextUpCount: MAX_NEXT_UP + 5,
    });
    expect(s.scenarioCount).toBe(5);
    expect(s.nextUpCount).toBe(MAX_NEXT_UP);
  });

  it('dedupes pinned seed ids', () => {
    const s = normalizePollSettings({
      scenarioCount: 3,
      nextUpCount: 3,
      pinnedSeedIds: ['a', 'a', 'b'],
    });
    expect(s.pinnedSeedIds).toEqual(['a', 'b']);
  });
});

describe('generatePollScenarios', () => {
  const weights = DEFAULT_WEIGHTS;

  function seedLibrary(n: number): void {
    for (let i = 0; i < n; i++) {
      seedSong({ id: `s${i}`, title: `Song ${i}`, artist: `Artist ${i}`, genre: 'Rock', bpm: 120 });
    }
  }

  it('generates the requested number of scenarios with ranked candidates', () => {
    seedLibrary(8);
    const scenarios = generatePollScenarios(db, { scenarioCount: 2, nextUpCount: 3 }, weights);
    expect(scenarios).toHaveLength(2);
    for (const [i, sc] of scenarios.entries()) {
      expect(sc.position).toBe(i);
      expect(sc.kind).toBe('seed');
      expect(sc.snapshot.seed).not.toBeNull();
      expect(sc.snapshot.candidates.length).toBeGreaterThanOrEqual(1);
      expect(sc.snapshot.candidates.length).toBeLessThanOrEqual(3);
      for (const [j, c] of sc.snapshot.candidates.entries()) {
        expect(c.rank).toBe(j + 1);
        expect(c.displayOrder).toBe(j + 1);
        expect(c.explanation.axes.length).toBeGreaterThan(0);
        // The candidate never suggests its own seed.
        expect(c.song.id).not.toBe(sc.seedSongId);
      }
    }
  });

  it('persists JSON-safe snapshots: no embedding / recentPlayFactor keys survive', () => {
    seedLibrary(4);
    const scenarios = generatePollScenarios(db, { scenarioCount: 1, nextUpCount: 3 }, weights);
    const roundTripped = JSON.parse(JSON.stringify(scenarios[0]!.snapshot));
    expect(Object.keys(roundTripped.seed.features)).not.toContain('embedding');
    expect(Object.keys(roundTripped.seed.features)).not.toContain('recentPlayFactor');
    for (const c of roundTripped.candidates) {
      expect(Object.keys(c.features)).not.toContain('embedding');
      expect(Object.keys(c.features)).not.toContain('recentPlayFactor');
    }
  });

  it('honors pinned seeds first and never reuses them for auto slots', () => {
    seedLibrary(6);
    const scenarios = generatePollScenarios(
      db,
      { scenarioCount: 3, nextUpCount: 2, pinnedSeedIds: ['s5'] },
      weights,
    );
    expect(scenarios[0]!.seedSongId).toBe('s5');
    const seedIds = scenarios.map((s) => s.seedSongId);
    expect(new Set(seedIds).size).toBe(seedIds.length);
  });

  it('records the full weight set actually used', () => {
    seedLibrary(4);
    const custom = { ...weights, genre: 30 };
    const scenarios = generatePollScenarios(db, { scenarioCount: 1, nextUpCount: 2 }, custom);
    expect(scenarios[0]!.snapshot.weights['genre']).toBe(30);
    expect(scenarios[0]!.snapshot.weights['bpm']).toBe(weights.bpm);
  });

  it('rejects a pinned seed that is missing or not playable', () => {
    seedLibrary(3);
    seedSong({ id: 'quarantined', title: 'Q', artist: 'Q', landed: false });
    expect(() =>
      generatePollScenarios(
        db,
        { scenarioCount: 1, nextUpCount: 2, pinnedSeedIds: ['nope'] },
        weights,
      ),
    ).toThrow(RadioPollGenerationError);
    expect(() =>
      generatePollScenarios(
        db,
        { scenarioCount: 1, nextUpCount: 2, pinnedSeedIds: ['quarantined'] },
        weights,
      ),
    ).toThrow(RadioPollGenerationError);
  });

  it('throws on an empty library', () => {
    expect(() => generatePollScenarios(db, { scenarioCount: 2, nextUpCount: 3 }, weights)).toThrow(
      RadioPollGenerationError,
    );
  });

  it('returns fewer scenarios than asked when the library is exhausted', () => {
    seedLibrary(2);
    const scenarios = generatePollScenarios(db, { scenarioCount: 10, nextUpCount: 2 }, weights);
    expect(scenarios.length).toBeGreaterThanOrEqual(1);
    expect(scenarios.length).toBeLessThanOrEqual(2);
  });
});

describe('stripFeatures', () => {
  it('drops embedding and recentPlayFactor, keeps the rest', () => {
    const stripped = stripFeatures({
      duration: 200,
      artistId: 'a',
      bpm: 120,
      embedding: new Float32Array([1, 2]),
      recentPlayFactor: 0.5,
    });
    expect(stripped).toEqual({ duration: 200, artistId: 'a', bpm: 120 });
  });
});
