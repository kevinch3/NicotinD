import { describe, it, expect } from 'bun:test';
import {
  scoreSimilarity,
  camelotCompatibility,
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

describe('scoreSimilarity', () => {
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

  it('scores BPM proximity — ±5% gets near-full weight', () => {
    const seed = makeSeed({ bpm: 120 });
    const close = makeCandidate({ bpm: 126 }); // 5%
    const far = makeCandidate({ bpm: 150 }); // 25%
    const scoreClose = scoreSimilarity(seed, close);
    const scoreFar = scoreSimilarity(seed, far);
    expect(scoreClose).toBeGreaterThan(scoreFar);
  });

  it('handles missing BPM gracefully', () => {
    const seed = makeSeed({ bpm: undefined });
    const candidate = makeCandidate({ bpm: 120 });
    const score = scoreSimilarity(seed, candidate);
    expect(typeof score).toBe('number');
  });

  it('handles missing key gracefully', () => {
    const seed = makeSeed({ key: undefined });
    const candidate = makeCandidate({ key: 'A minor' });
    const score = scoreSimilarity(seed, candidate);
    expect(typeof score).toBe('number');
  });

  it('gives genre match the configured weight', () => {
    const weights: ScoringWeights = { ...DEFAULT_WEIGHTS, genre: 20, bpm: 0, key: 0, year: 0, duration: 0, artistPenalty: 0 };
    const seed = makeSeed({ genre: 'Rock' });
    const match = makeCandidate({ genre: 'Rock' });
    const mismatch = makeCandidate({ genre: 'Jazz' });
    expect(scoreSimilarity(seed, match, weights)).toBe(20);
    expect(scoreSimilarity(seed, mismatch, weights)).toBe(0);
  });

  it('scores key compatibility via Camelot adjacency', () => {
    const weights: ScoringWeights = { ...DEFAULT_WEIGHTS, genre: 0, bpm: 0, key: 10, year: 0, duration: 0, artistPenalty: 0 };
    const seed = makeSeed({ key: 'C major' }); // 8B
    const same = makeCandidate({ key: 'C major' }); // 8B — exact
    const adjacent = makeCandidate({ key: 'G major' }); // 9B — adjacent
    const relative = makeCandidate({ key: 'A minor' }); // 8A — relative
    const distant = makeCandidate({ key: 'F# minor' }); // 2A — distant

    expect(scoreSimilarity(seed, same, weights)).toBe(10);
    expect(scoreSimilarity(seed, adjacent, weights)).toBe(7);
    expect(scoreSimilarity(seed, relative, weights)).toBe(8);
    expect(scoreSimilarity(seed, distant, weights)).toBe(0);
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

describe('scoreSimilarity — perceptual axes', () => {
  it('is unchanged for feature-less songs (NULL neutrality pin)', () => {
    // Neither side carries perceptual features: the score must be exactly what
    // the pre-feature scorer produced — genre(10) + bpm + key(6) + year + duration.
    const seed = makeSeed();
    const cand = makeCandidate();
    const score = scoreSimilarity(seed, cand);
    const bpm = Math.max(0, Math.min(1, 1 - (Math.abs(120 - 122) / 120) * 5)) * 10 * 0.8;
    const year = (1 - 1 / 20) * 2;
    const duration = (1 - 10 / 240) * 1;
    expect(score).toBeCloseTo(10 + bpm + 6 + year + duration, 10);
  });

  it('a one-sided feature contributes exactly 0', () => {
    const base = scoreSimilarity(makeSeed(), makeCandidate());
    // Seed analyzed, candidate not: no change.
    expect(scoreSimilarity(makeSeed({ energy: 0.9, valence: 0.9 }), makeCandidate())).toBe(base);
    // Candidate analyzed, seed not: no change.
    expect(scoreSimilarity(makeSeed(), makeCandidate({ energy: 0.9, danceability: 1 }))).toBe(base);
  });

  it('rewards energy closeness with the energy weight', () => {
    const base = scoreSimilarity(makeSeed(), makeCandidate());
    const identical = scoreSimilarity(makeSeed({ energy: 0.7 }), makeCandidate({ energy: 0.7 }));
    expect(identical).toBeCloseTo(base + DEFAULT_WEIGHTS.energy, 10);
    const distant = scoreSimilarity(makeSeed({ energy: 1 }), makeCandidate({ energy: 0 }));
    expect(distant).toBeCloseTo(base, 10);
  });

  it('scores each perceptual axis independently with its weight', () => {
    const base = scoreSimilarity(makeSeed(), makeCandidate());
    const all = scoreSimilarity(
      makeSeed({ energy: 0.5, valence: 0.5, danceability: 0.5, instrumental: 0.5, acousticness: 0.5 }),
      makeCandidate({ energy: 0.5, valence: 0.5, danceability: 0.5, instrumental: 0.5, acousticness: 0.5 }),
    );
    const featureSum =
      DEFAULT_WEIGHTS.energy +
      DEFAULT_WEIGHTS.valence +
      DEFAULT_WEIGHTS.danceability +
      DEFAULT_WEIGHTS.instrumental +
      DEFAULT_WEIGHTS.acousticness;
    expect(all).toBeCloseTo(base + featureSum, 10);
  });

  it('prefers the perceptually-closer candidate at equal classic features', () => {
    const seed = makeSeed({ energy: 0.8, valence: 0.7 });
    const close = makeCandidate({ energy: 0.75, valence: 0.65 });
    const far = makeCandidate({ energy: 0.2, valence: 0.1 });
    expect(scoreSimilarity(seed, close)).toBeGreaterThan(scoreSimilarity(seed, far));
  });
});
