import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  MAX_NEXT_UP,
  MAX_SCENARIOS,
  RadioPollGenerationError,
  generatePollScenarios,
  mergePollWeights,
  describeFilter,
  normalizePollSettings,
  stripFeatures,
} from './radio-poll-generate.js';
import { DEFAULT_WEIGHTS } from './radio.service.js';
import { BAND_NAMES, GROOVE_NAMES, TIMBRE_NAMES } from './descriptor-axes.js';
import { DESCRIPTOR_VERSION, upsertDescriptors } from './descriptor-store.js';

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

  it('stamps voteScale stars5 server-side, overriding any client value', () => {
    expect(normalizePollSettings({ scenarioCount: 3, nextUpCount: 3 }).voteScale).toBe('stars5');
    expect(
      normalizePollSettings({ scenarioCount: 3, nextUpCount: 3, voteScale: 'binary' }).voteScale,
    ).toBe('stars5');
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
    seedSong({ id: 'hidden', title: 'H', artist: 'H', hidden: true });
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
        { scenarioCount: 1, nextUpCount: 2, pinnedSeedIds: ['hidden'] },
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
  it('drops embedding, recentPlayFactor and recordingKey, keeps the rest', () => {
    const stripped = stripFeatures({
      duration: 200,
      artistId: 'a',
      bpm: 120,
      embedding: new Float32Array([1, 2]),
      recentPlayFactor: 0.5,
      recordingKey: 'a|song|200',
    });
    expect(stripped).toEqual({ duration: 200, artistId: 'a', bpm: 120 });
  });

  it('keeps the descriptor blocks (formula v5) — they are plain arrays and replayable', () => {
    const stripped = stripFeatures({
      duration: 200,
      artistId: 'a',
      timbre: [0.1, -0.2],
      groove: [1, 0],
      bands: [0.5, 0.5],
      embedding: new Float32Array([1]),
    });
    expect(stripped).toEqual({
      duration: 200,
      artistId: 'a',
      timbre: [0.1, -0.2],
      groove: [1, 0],
      bands: [0.5, 0.5],
    });
    // What a Float32Array would have become — the reason blocks are number[].
    expect(JSON.parse(JSON.stringify(stripped)).timbre).toEqual([0.1, -0.2]);
  });
});

describe('station (filter) scenarios', () => {
  function station(): void {
    for (let i = 1; i <= 6; i++) {
      seedSong({
        id: `e${i}`,
        title: `E${i}`,
        artist: 'Producer',
        artistId: 'prod',
        genre: 'Electronic',
        bpm: 128,
      });
      db.run(
        `INSERT OR REPLACE INTO library_song_genres (song_id, genre, position) VALUES (?, 'Electronic', 0)`,
        [`e${i}`],
      );
    }
    for (let i = 1; i <= 6; i++) {
      seedSong({
        id: `r${i}`,
        title: `R${i}`,
        artist: 'Band',
        artistId: 'band',
        genre: 'Rock',
        bpm: 128,
      });
      db.run(
        `INSERT OR REPLACE INTO library_song_genres (song_id, genre, position) VALUES (?, 'Rock', 0)`,
        [`r${i}`],
      );
      if (i === 1) {
        db.run(
          `INSERT OR REPLACE INTO library_song_genres (song_id, genre, position) VALUES (?, 'Electronic', 1)`,
          [`r${i}`],
        );
      }
    }
  }

  it('freezes a station scenario with its centroid and filter', () => {
    station();
    const scenarios = generatePollScenarios(
      db,
      normalizePollSettings({
        scenarioCount: 1,
        nextUpCount: 5,
        filters: [{ genres: ['Electronic'] }],
      }),
      DEFAULT_WEIGHTS,
    );
    expect(scenarios).toHaveLength(1);
    const sc = scenarios[0]!;
    expect(sc.kind).toBe('filter');
    expect(sc.seedSongId).toBeNull();
    expect(sc.snapshot.seed).toBeNull();
    expect(sc.snapshot.filter).toEqual({ genres: ['Electronic'] });
    // Without a centroid the eval harness has nothing to re-score against and
    // silently drops the whole scenario.
    expect(sc.snapshot.centroid).toBeDefined();
    expect(sc.snapshot.candidates.length).toBeGreaterThan(0);
  });

  it('never leaks the source row (file paths) into a frozen snapshot', () => {
    station();
    const scenarios = generatePollScenarios(
      db,
      normalizePollSettings({
        scenarioCount: 1,
        nextUpCount: 5,
        filters: [{ genres: ['Electronic'] }],
      }),
      DEFAULT_WEIGHTS,
    );
    const json = JSON.stringify(scenarios[0]!.snapshot.candidates.map((c) => c.features));
    expect(json).not.toContain('/music/');
    expect(json).not.toContain('_row');
  });

  it('carries the station grade so a replay reproduces the served ranking', () => {
    station();
    const scenarios = generatePollScenarios(
      db,
      normalizePollSettings({
        scenarioCount: 1,
        nextUpCount: 5,
        filters: [{ genres: ['Electronic'] }],
      }),
      DEFAULT_WEIGHTS,
    );
    const features = scenarios[0]!.snapshot.candidates.map((c) => c.features);
    expect(features.every((f) => typeof f.stationAffinity === 'number')).toBe(true);
    expect(
      scenarios[0]!.snapshot.candidates[0]!.explanation.axes.some((a) => a.axis === 'station'),
    ).toBe(true);
  });

  it('generates stations after pinned seeds and before random auto seeds', () => {
    station();
    const scenarios = generatePollScenarios(
      db,
      normalizePollSettings({
        scenarioCount: 3,
        nextUpCount: 3,
        pinnedSeedIds: ['e1'],
        filters: [{ genres: ['Electronic'] }],
      }),
      DEFAULT_WEIGHTS,
    );
    expect(scenarios.map((s) => s.kind)).toEqual(['seed', 'filter', 'seed']);
  });

  it('drops a filter that matches nothing rather than failing the poll', () => {
    station();
    const scenarios = generatePollScenarios(
      db,
      normalizePollSettings({
        scenarioCount: 2,
        nextUpCount: 3,
        filters: [{ genres: ['Nonexistent'] }, { genres: ['Electronic'] }],
      }),
      DEFAULT_WEIGHTS,
    );
    expect(scenarios.some((s) => s.kind === 'filter')).toBe(true);
  });
});

describe('describeFilter', () => {
  it('names a genre station', () => {
    expect(describeFilter({ genres: ['Electronic'] })).toBe('Electronic');
    expect(describeFilter({ genres: ['House', 'Techno'] })).toBe('House / Techno');
  });

  it('joins the parts of a compound vibe', () => {
    expect(describeFilter({ moods: ['happy'], bpmMin: 120 })).toBe('happy · 120+ bpm');
    expect(describeFilter({ bpmMin: 100, bpmMax: 130 })).toBe('100-130 bpm');
    expect(describeFilter({ buckets: { energy: ['high'] } })).toBe('high energy');
  });

  it('never renders an empty label', () => {
    expect(describeFilter({})).toBe('Everything');
  });
});

describe('generatePollScenarios — strategy stamping', () => {
  it('stamps the strategy onto every scenario snapshot, defaulting to balanced', () => {
    for (let i = 0; i < 8; i++) {
      seedSong({ id: `s${i}`, title: `Song ${i}`, artist: `Artist ${i}`, genre: 'Rock', bpm: 120 });
    }
    const settings = normalizePollSettings({ scenarioCount: 2, nextUpCount: 3 });
    for (const sc of generatePollScenarios(db, settings, mergePollWeights(undefined))) {
      expect(sc.snapshot.strategy).toBe('balanced');
    }
    const different = normalizePollSettings({
      scenarioCount: 2,
      nextUpCount: 3,
      strategy: 'different',
    });
    expect(different.strategy).toBe('different');
    for (const sc of generatePollScenarios(db, different, mergePollWeights(undefined))) {
      expect(sc.snapshot.strategy).toBe('different');
    }
    // An unknown id is dropped by normalisation rather than stored.
    expect(
      normalizePollSettings({ scenarioCount: 1, nextUpCount: 1, strategy: 'random' as never })
        .strategy,
    ).toBeUndefined();
  });
});

describe('snapshot descriptor blocks (issue #940)', () => {
  function seedDescriptors(songId: string, offset: number): void {
    const features: Record<string, number> = {};
    for (const [i, n] of [...TIMBRE_NAMES, ...GROOVE_NAMES, ...BAND_NAMES].entries()) {
      features[n] = (i + offset) / 100;
    }
    upsertDescriptors(db, { songId, version: DESCRIPTOR_VERSION, features, fileSize: null });
  }

  beforeEach(() => {
    for (const [i, id] of ['s1', 's2', 's3', 's4'].entries()) {
      seedSong({
        id,
        title: `T${id}`,
        artist: `A${id}`,
        genre: 'Electronic',
        bpm: 120,
        landed: true,
      });
      seedDescriptors(id, i);
    }
  });

  // The eval harness replays the stored snapshot, so an axis missing from it
  // is an axis the poll cannot grade — `--weights timbre=N` silently does
  // nothing. → docs/radio-eval-polls.md
  it('carries the descriptor blocks the live formula scored on', () => {
    const scenarios = generatePollScenarios(
      db,
      normalizePollSettings({ scenarioCount: 1, nextUpCount: 3 }),
      mergePollWeights(undefined),
    );
    expect(scenarios.length).toBeGreaterThan(0);

    for (const sc of scenarios) {
      const all = [
        ...(sc.snapshot.seed ? [sc.snapshot.seed.features] : []),
        ...sc.snapshot.candidates.map((c) => c.features),
      ];
      for (const f of all) {
        expect(f.timbre?.length).toBe(TIMBRE_NAMES.length);
        expect(f.groove?.length).toBe(GROOVE_NAMES.length);
        expect(f.bands?.length).toBe(BAND_NAMES.length);
      }
    }
  });

  // The re-derivation this replaces existed to keep `_row` (file paths) out of
  // the snapshot. Dropping it structurally must not reintroduce that leak.
  it('still keeps _row and embedding out of every persisted snapshot', () => {
    const scenarios = generatePollScenarios(
      db,
      normalizePollSettings({ scenarioCount: 1, nextUpCount: 3 }),
      mergePollWeights(undefined),
    );
    for (const sc of scenarios) {
      const all = [
        ...(sc.snapshot.seed ? [sc.snapshot.seed.features] : []),
        ...sc.snapshot.candidates.map((c) => c.features),
      ];
      for (const f of all) {
        expect('_row' in f).toBe(false);
        expect('embedding' in f).toBe(false);
        expect('recentPlayFactor' in f).toBe(false);
        expect('recordingKey' in f).toBe(false);
      }
      // `song` carries `path` by design (rowToSong); the guard is that the
      // raw row never rides along inside `features`.
      const featureJson = JSON.stringify(all);
      expect(featureJson).not.toContain('.mp3');
    }
  });
});
