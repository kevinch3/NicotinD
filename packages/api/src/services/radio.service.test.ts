import { describe, it, expect } from 'bun:test';
import {
  scoreSimilarity,
  camelotCompatibility,
  genreCloseness,
  cosineSim,
  rankCandidates,
  DEFAULT_WEIGHTS,
  type SongFeatures,
  type ScoringWeights,
} from './radio.service';

function makeSeed(overrides: Partial<SongFeatures> = {}): SongFeatures {
  return {
    bpm: 120,
    key: 'C major',
    genre: 'Electronic',
    duration: 240,
    year: 2020,
    artistId: 'artist-seed',
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<SongFeatures> = {}): SongFeatures {
  return {
    bpm: 122,
    key: 'C major',
    genre: 'Electronic',
    duration: 230,
    year: 2019,
    artistId: 'artist-other',
    ...overrides,
  };
}

describe('camelotCompatibility', () => {
  it('returns 1.0 for identical codes', () => {
    expect(camelotCompatibility('8B', '8B')).toBe(1.0);
    expect(camelotCompatibility('5A', '5A')).toBe(1.0);
  });

  it('returns 0.8 for same number, different ring (relative key)', () => {
    expect(camelotCompatibility('8B', '8A')).toBe(0.8);
    expect(camelotCompatibility('5A', '5B')).toBe(0.8);
  });

  it('returns 0.7 for adjacent numbers on the same ring', () => {
    expect(camelotCompatibility('8B', '7B')).toBe(0.7);
    expect(camelotCompatibility('8B', '9B')).toBe(0.7);
    expect(camelotCompatibility('5A', '4A')).toBe(0.7);
    expect(camelotCompatibility('5A', '6A')).toBe(0.7);
  });

  it('wraps around 1↔12', () => {
    expect(camelotCompatibility('1B', '12B')).toBe(0.7);
    expect(camelotCompatibility('12A', '1A')).toBe(0.7);
  });

  it('returns 0.4 for a ±2 move on the same ring (energy jump)', () => {
    expect(camelotCompatibility('8B', '6B')).toBe(0.4);
    expect(camelotCompatibility('8B', '10B')).toBe(0.4);
    // wraps: 12 and 2 are ±2 apart
    expect(camelotCompatibility('12A', '2A')).toBe(0.4);
    expect(camelotCompatibility('1B', '11B')).toBe(0.4);
  });

  it('returns 0.4 for a diagonal move (±1 number + ring swap)', () => {
    expect(camelotCompatibility('8B', '7A')).toBe(0.4);
    expect(camelotCompatibility('8B', '9A')).toBe(0.4);
    // wraps
    expect(camelotCompatibility('1B', '12A')).toBe(0.4);
  });

  it('returns 0 for distant codes', () => {
    expect(camelotCompatibility('8B', '3A')).toBe(0);
    expect(camelotCompatibility('1A', '6B')).toBe(0);
  });

  it('returns 0 when either is null', () => {
    expect(camelotCompatibility(null, '8B')).toBe(0);
    expect(camelotCompatibility('8B', null)).toBe(0);
    expect(camelotCompatibility(null, null)).toBe(0);
  });
});

describe('genreCloseness', () => {
  it('is 1.0 for an exact (case-insensitive) match', () => {
    expect(genreCloseness('House', 'house')).toBe(1.0);
    expect(genreCloseness('Deep House', 'deep house')).toBe(1.0);
  });

  it('gives strong partial credit when one token-set contains the other', () => {
    expect(genreCloseness('Deep House', 'House')).toBe(0.6);
    expect(genreCloseness('house', 'tech house')).toBe(0.6);
  });

  it('gives modest credit for partial token overlap, below containment', () => {
    const partial = genreCloseness('Deep House', 'Tech House');
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(0.6);
  });

  it('is 0 for disjoint genres', () => {
    expect(genreCloseness('Jazz', 'Death Metal')).toBe(0);
  });

  it('is null when either side is missing', () => {
    expect(genreCloseness(undefined, 'House')).toBeNull();
    expect(genreCloseness('House', undefined)).toBeNull();
    expect(genreCloseness('', 'House')).toBeNull();
  });
});

describe('cosineSim', () => {
  it('is 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSim(v, new Float32Array([1, 2, 3]))).toBeCloseTo(1, 6);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSim(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSim(new Float32Array([1, 1]), new Float32Array([-1, -1]))).toBeCloseTo(-1, 6);
  });

  it('is null for missing, empty, mismatched-dim, or zero vectors', () => {
    expect(cosineSim(undefined, new Float32Array([1]))).toBeNull();
    expect(cosineSim(new Float32Array([]), new Float32Array([]))).toBeNull();
    expect(cosineSim(new Float32Array([1, 2]), new Float32Array([1]))).toBeNull();
    expect(cosineSim(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBeNull();
  });
});

describe('scoreSimilarity', () => {
  it('produces a normalized 0..1 fit score for a matching different-artist track', () => {
    const score = scoreSimilarity(makeSeed(), makeCandidate());
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('gives highest score to a near-identical track', () => {
    const seed = makeSeed();
    const ideal = makeCandidate({ bpm: 120, key: 'C major', genre: 'Electronic', year: 2020 });
    const distant = makeCandidate({ bpm: 80, key: 'F# minor', genre: 'Classical', year: 1970 });
    expect(scoreSimilarity(seed, ideal)).toBeGreaterThan(scoreSimilarity(seed, distant));
  });

  it('penalizes same-artist candidates', () => {
    const seed = makeSeed();
    const sameArtist = makeCandidate({ artistId: 'artist-seed' });
    const diffArtist = makeCandidate({ artistId: 'artist-other' });
    expect(scoreSimilarity(seed, diffArtist)).toBeGreaterThan(scoreSimilarity(seed, sameArtist));
  });

  it('subtracts exactly the artistPenalty (normalized space) for same-artist', () => {
    const diff = scoreSimilarity(makeSeed(), makeCandidate({ artistId: 'artist-other' }));
    const same = scoreSimilarity(makeSeed(), makeCandidate({ artistId: 'artist-seed' }));
    expect(diff - same).toBeCloseTo(DEFAULT_WEIGHTS.artistPenalty, 10);
  });

  it('scores BPM proximity — closer BPM ranks higher', () => {
    const seed = makeSeed({ bpm: 120 });
    const close = makeCandidate({ bpm: 126 }); // 5%
    const far = makeCandidate({ bpm: 150 }); // 25%
    expect(scoreSimilarity(seed, close)).toBeGreaterThan(scoreSimilarity(seed, far));
  });

  it('handles missing BPM gracefully', () => {
    const seed = makeSeed({ bpm: undefined });
    const candidate = makeCandidate({ bpm: 120 });
    expect(typeof scoreSimilarity(seed, candidate)).toBe('number');
  });

  it('handles missing key gracefully', () => {
    const seed = makeSeed({ key: undefined });
    const candidate = makeCandidate({ key: 'A minor' });
    expect(typeof scoreSimilarity(seed, candidate)).toBe('number');
  });

  it('a single comparable axis normalizes to that axis score', () => {
    // Only genre is comparable (bpm/key/year/duration zeroed by weights); an
    // exact genre match then normalizes to 1.0 regardless of the weight value.
    const weights: ScoringWeights = {
      ...DEFAULT_WEIGHTS,
      bpm: 0,
      key: 0,
      year: 0,
      duration: 0,
      artistPenalty: 0,
    };
    const match = scoreSimilarity(makeSeed({ genre: 'Rock' }), makeCandidate({ genre: 'Rock' }), weights);
    const mismatch = scoreSimilarity(
      makeSeed({ genre: 'Rock' }),
      makeCandidate({ genre: 'Jazz' }),
      weights,
    );
    expect(match).toBe(1);
    expect(mismatch).toBe(0);
  });

  it('scores key compatibility via Camelot adjacency (relative ordering)', () => {
    const weights: ScoringWeights = {
      ...DEFAULT_WEIGHTS,
      genre: 0,
      bpm: 0,
      year: 0,
      duration: 0,
      artistPenalty: 0,
    };
    const seed = makeSeed({ key: 'C major' }); // 8B
    const same = scoreSimilarity(seed, makeCandidate({ key: 'C major' }), weights); // 8B exact → 1
    const relative = scoreSimilarity(seed, makeCandidate({ key: 'A minor' }), weights); // 8A → 0.8
    const adjacent = scoreSimilarity(seed, makeCandidate({ key: 'G major' }), weights); // 9B → 0.7
    const distant = scoreSimilarity(seed, makeCandidate({ key: 'F# minor' }), weights); // 2A → 0
    expect(same).toBe(1);
    expect(relative).toBeCloseTo(0.8, 10);
    expect(adjacent).toBeCloseTo(0.7, 10);
    expect(distant).toBe(0);
    expect(same).toBeGreaterThan(relative);
    expect(relative).toBeGreaterThan(adjacent);
    expect(adjacent).toBeGreaterThan(distant);
  });
});

describe('rankCandidates', () => {
  it('returns at most count results', () => {
    const seed = makeSeed();
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({ artistId: `artist-${i}` }),
    );
    const result = rankCandidates(seed, candidates, { count: 5 });
    expect(result.length).toBe(5);
  });

  it('enforces per-artist cap', () => {
    const seed = makeSeed();
    const candidates = Array.from({ length: 10 }, () =>
      makeCandidate({ artistId: 'artist-same' }),
    );
    const result = rankCandidates(seed, candidates, { count: 10, maxPerArtist: 2 });
    expect(result.length).toBe(2);
  });

  it('returns results sorted by score descending', () => {
    const seed = makeSeed({ bpm: 120, genre: 'Rock' });
    const candidates = [
      makeCandidate({ bpm: 180, genre: 'Jazz', artistId: 'a1' }),
      makeCandidate({ bpm: 120, genre: 'Rock', artistId: 'a2' }),
      makeCandidate({ bpm: 130, genre: 'Rock', artistId: 'a3' }),
    ];
    const result = rankCandidates(seed, candidates, { count: 10 });
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score);
    }
  });

  it('returns empty array for empty candidates', () => {
    const seed = makeSeed();
    const result = rankCandidates(seed, [], { count: 10 });
    expect(result).toEqual([]);
  });
});

describe('scoreSimilarity — normalization & perceptual axes', () => {
  it('does not penalize an un-analyzed candidate against an analyzed one at equal classic features', () => {
    // The core mid-backfill fix: the analyzed candidate must not automatically
    // outrank the un-analyzed one just for carrying perceptual features. Here
    // the seed is analyzed; the analyzed candidate's perceptual axes are a poor
    // match, so the un-analyzed candidate (scored only on its shared classic
    // features) should not lose purely for being un-analyzed.
    const seed = makeSeed({ energy: 0.9, valence: 0.9 });
    const unanalyzed = makeCandidate(); // classic features match well, no perceptual
    const analyzedButFar = makeCandidate({ energy: 0.0, valence: 0.0 });
    expect(scoreSimilarity(seed, unanalyzed)).toBeGreaterThan(
      scoreSimilarity(seed, analyzedButFar),
    );
  });

  it('a one-sided perceptual feature is ignored (axis skipped, not zero-scored)', () => {
    // With normalization, an un-comparable axis is dropped from BOTH numerator
    // and denominator, so a one-sided feature leaves the score unchanged.
    const base = scoreSimilarity(makeSeed(), makeCandidate());
    expect(scoreSimilarity(makeSeed({ energy: 0.9, valence: 0.9 }), makeCandidate())).toBeCloseTo(
      base,
      10,
    );
    expect(
      scoreSimilarity(makeSeed(), makeCandidate({ energy: 0.9, danceability: 1 })),
    ).toBeCloseTo(base, 10);
  });

  it('rewards perceptual closeness at equal classic features', () => {
    const seed = makeSeed({ energy: 0.8, valence: 0.7 });
    const close = makeCandidate({ energy: 0.75, valence: 0.65 });
    const far = makeCandidate({ energy: 0.2, valence: 0.1 });
    expect(scoreSimilarity(seed, close)).toBeGreaterThan(scoreSimilarity(seed, far));
  });

  it('perfect match on every comparable axis normalizes to 1.0 (before artist delta)', () => {
    const seed = makeSeed({
      energy: 0.5,
      valence: 0.5,
      danceability: 0.5,
      instrumental: 0.5,
      acousticness: 0.5,
    });
    const twin = makeCandidate({
      bpm: 120,
      key: 'C major',
      genre: 'Electronic',
      year: 2020,
      duration: 240,
      energy: 0.5,
      valence: 0.5,
      danceability: 0.5,
      instrumental: 0.5,
      acousticness: 0.5,
    });
    expect(scoreSimilarity(seed, twin)).toBeCloseTo(1, 10);
  });

  it('uses the embedding cosine axis when both sides carry an embedding', () => {
    const seed = makeSeed({ embedding: new Float32Array([1, 0, 0]) });
    const aligned = makeCandidate({ embedding: new Float32Array([1, 0, 0]) });
    const opposed = makeCandidate({ embedding: new Float32Array([-1, 0, 0]) });
    expect(scoreSimilarity(seed, aligned)).toBeGreaterThan(scoreSimilarity(seed, opposed));
  });
});

describe('genreSetCloseness (multi-genre)', () => {
  it('scores the best pairwise match across two genre sets', async () => {
    const { genreSetCloseness } = await import('./radio.service.js');
    // "House" appears in both sets → exact 1.0 despite different primaries.
    expect(genreSetCloseness(['Electronic', 'House'], ['House'])).toBe(1.0);
    // Best pair is containment ("Deep House" ⊇ "House") → 0.6.
    expect(genreSetCloseness(['Deep House'], ['House', 'Ambient'])).toBe(0.6);
    // Disjoint sets → 0.
    expect(genreSetCloseness(['Rock'], ['Salsa'])).toBe(0);
    // Either side empty/missing → null (axis skipped).
    expect(genreSetCloseness([], ['Rock'])).toBeNull();
    expect(genreSetCloseness(undefined, ['Rock'])).toBeNull();
    // String input (single-genre compat) still works.
    expect(genreSetCloseness('House', ['House'])).toBe(1.0);
  });
});

describe('scoreSimilarity — multi-genre axis', () => {
  it('uses the genre sets when present so a shared secondary genre scores 1.0', async () => {
    const { scoreSimilarity, DEFAULT_WEIGHTS } = await import('./radio.service.js');
    const base = { duration: 200, artistId: 'x' };
    const seed = { ...base, genres: ['Electronic', 'House'], genre: 'Electronic' };
    const single = scoreSimilarity(
      { ...base, genre: 'Electronic' },
      { ...base, genre: 'House' },
      DEFAULT_WEIGHTS,
    );
    const multi = scoreSimilarity(seed, { ...base, genres: ['House'], genre: 'House' }, DEFAULT_WEIGHTS);
    expect(multi).toBeGreaterThan(single);
  });
});

describe('explainSimilarity (per-axis breakdown — the diagnostic seam)', () => {
  it('reports a genre mismatch as an axis scored 0 (weighting problem), NOT skipped', async () => {
    const { explainSimilarity, DEFAULT_WEIGHTS } = await import('./radio.service.js');
    // Both sides carry genre but they are disjoint (Folk vs Pop) — the axis is
    // comparable, it just scores 0. This is the "genre lost on weight" case.
    const seed = makeSeed({ genre: 'Folk', genres: ['Folk'] });
    const cand = makeCandidate({ genre: 'Pop', genres: ['Pop'] });
    const ex = explainSimilarity(seed, cand, DEFAULT_WEIGHTS);
    const genre = ex.axes.find((a) => a.axis === 'genre');
    expect(genre).toBeDefined();
    expect(genre!.value).toBe(0);
    expect(genre!.weight).toBe(DEFAULT_WEIGHTS.genre);
    expect(genre!.contribution).toBe(0);
    expect(ex.skipped).not.toContain('genre');
  });

  it('floors a missing candidate genre instead of skipping it (data problem, but scored)', async () => {
    const { explainSimilarity, DEFAULT_WEIGHTS, MISSING_GENRE_FLOOR } = await import(
      './radio.service.js'
    );
    const seed = makeSeed({ genre: 'Folk', genres: ['Folk'] });
    const cand = makeCandidate({ genre: undefined, genres: undefined });
    const ex = explainSimilarity(seed, cand, DEFAULT_WEIGHTS);
    const genre = ex.axes.find((a) => a.axis === 'genre');
    expect(genre).toBeDefined();
    expect(genre!.value).toBe(MISSING_GENRE_FLOOR);
    expect(ex.skipped).not.toContain('genre');
    // Reported separately so the diagnostic can still tell a *data* gap apart
    // from a genuine 0.2-closeness match.
    expect(ex.floored).toContain('genre');
  });

  it('still skips genre when the SEED has none (nothing to compare against)', async () => {
    const { explainSimilarity, DEFAULT_WEIGHTS } = await import('./radio.service.js');
    const ex = explainSimilarity(
      makeSeed({ genre: undefined, genres: undefined }),
      makeCandidate({ genre: 'Pop', genres: ['Pop'] }),
      DEFAULT_WEIGHTS,
    );
    expect(ex.skipped).toContain('genre');
    expect(ex.floored).not.toContain('genre');
    expect(ex.axes.find((a) => a.axis === 'genre')).toBeUndefined();
  });

  it('a genre-less candidate no longer out-scores a genre-matched neighbour (the bug)', async () => {
    const { scoreSimilarity, DEFAULT_WEIGHTS } = await import('./radio.service.js');
    const seed = makeSeed({ genre: 'Folk', genres: ['Folk'], bpm: 145, energy: 0.57 });
    // The genre-matched neighbour is slightly *worse* on every other axis…
    const matched = makeCandidate({
      genre: 'Folk',
      genres: ['Folk'],
      bpm: 138,
      energy: 0.5,
      artistId: 'a1',
    });
    // …while the genre-less pop track is a perfect BPM/energy fit.
    const genreless = makeCandidate({
      genre: undefined,
      genres: undefined,
      bpm: 145,
      energy: 0.57,
      artistId: 'a2',
    });
    expect(scoreSimilarity(seed, matched, DEFAULT_WEIGHTS)).toBeGreaterThan(
      scoreSimilarity(seed, genreless, DEFAULT_WEIGHTS),
    );
  });

  it('flags the same-artist penalty', async () => {
    const { explainSimilarity, DEFAULT_WEIGHTS } = await import('./radio.service.js');
    const seed = makeSeed({ artistId: 'same' });
    const same = explainSimilarity(seed, makeCandidate({ artistId: 'same' }), DEFAULT_WEIGHTS);
    const diff = explainSimilarity(seed, makeCandidate({ artistId: 'other' }), DEFAULT_WEIGHTS);
    expect(same.artistPenaltyApplied).toBe(true);
    expect(diff.artistPenaltyApplied).toBe(false);
  });

  it('.score is identical to scoreSimilarity across a table of cases (delegation invariant)', async () => {
    const { explainSimilarity, scoreSimilarity, DEFAULT_WEIGHTS } = await import('./radio.service.js');
    const cases: Array<[SongFeatures, SongFeatures]> = [
      [makeSeed(), makeCandidate()],
      [makeSeed({ genre: 'Folk', genres: ['Folk'] }), makeCandidate({ genre: 'Pop', genres: ['Pop'] })],
      [makeSeed({ artistId: 'same' }), makeCandidate({ artistId: 'same' })],
      [makeSeed({ bpm: undefined, key: undefined }), makeCandidate({ energy: 0.9 })],
      [
        makeSeed({ energy: 0.3, valence: 0.7 }),
        makeCandidate({ energy: 0.35, valence: 0.65, genre: undefined, genres: undefined }),
      ],
    ];
    for (const [s, c] of cases) {
      expect(explainSimilarity(s, c, DEFAULT_WEIGHTS).score).toBe(scoreSimilarity(s, c, DEFAULT_WEIGHTS));
    }
  });

  it('contribution equals value × weight for every reported axis', async () => {
    const { explainSimilarity, DEFAULT_WEIGHTS } = await import('./radio.service.js');
    const ex = explainSimilarity(makeSeed(), makeCandidate(), DEFAULT_WEIGHTS);
    expect(ex.axes.length).toBeGreaterThan(0);
    for (const a of ex.axes) {
      expect(a.contribution).toBeCloseTo(a.value * a.weight, 10);
    }
  });
});
