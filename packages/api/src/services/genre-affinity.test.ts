import { describe, expect, it } from 'bun:test';
import {
  BREADTH_DISCOUNT,
  COHERENCE_HIGH,
  COHERENCE_LOW,
  COS_FLOOR,
  MIN_MEMBERS,
  breadthCredit,
  explainGenrePair,
  makeGenreAffinity,
  rankNeighbours,
  rescaleCosine,
  type GenreCentroid,
} from './genre-affinity.js';

const MODEL = 'discogs-effnet-bs64-1';

function centroid(
  genre: string,
  vec: number[],
  opts: { members?: number; coherence?: number; model?: string } = {},
): GenreCentroid {
  const v = new Float32Array(vec);
  let n = 0;
  for (const x of v) n += x * x;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  return {
    genre,
    model: opts.model ?? MODEL,
    vec: v.map((x) => x * inv),
    members: opts.members ?? 20,
    coherence: opts.coherence ?? COHERENCE_HIGH,
  };
}

function mapOf(...cs: GenreCentroid[]): Map<string, GenreCentroid> {
  return new Map(cs.map((c) => [c.genre.toLowerCase(), c]));
}

describe('breadthCredit / rescaleCosine (the two priors)', () => {
  it('gives a coherent leaf full credit and a diffuse umbrella the discounted floor', () => {
    expect(breadthCredit({ coherence: COHERENCE_HIGH })).toBe(1);
    expect(breadthCredit({ coherence: 1 })).toBe(1);
    expect(breadthCredit({ coherence: COHERENCE_LOW })).toBeCloseTo(1 - BREADTH_DISCOUNT, 6);
    expect(breadthCredit({ coherence: 0 })).toBeCloseTo(1 - BREADTH_DISCOUNT, 6);
    const mid = breadthCredit({ coherence: (COHERENCE_LOW + COHERENCE_HIGH) / 2 });
    expect(mid).toBeGreaterThan(1 - BREADTH_DISCOUNT);
    expect(mid).toBeLessThan(1);
  });

  it('maps the cosine floor to 0 and identity to 1, clamped', () => {
    expect(rescaleCosine(COS_FLOOR)).toBe(0);
    expect(rescaleCosine(COS_FLOOR - 0.5)).toBe(0);
    expect(rescaleCosine(1)).toBe(1);
    expect(rescaleCosine((COS_FLOOR + 1) / 2)).toBeCloseTo(0.5, 6);
  });
});

describe('explainGenrePair', () => {
  it('is 1.0 for an exact match on a genre nobody has a centroid for (lexical semantics kept)', () => {
    const ex = explainGenrePair('Tango', 'tango', new Map());
    expect(ex.affinity).toBe(1);
    expect(ex.source).toBe('exact');
  });

  it('discounts an exact match on an umbrella tag by its (low) coherence', () => {
    const umbrella = centroid('Electronic', [1, 0], { coherence: COHERENCE_LOW });
    const ex = explainGenrePair('Electronic', 'electronic', mapOf(umbrella));
    expect(ex.source).toBe('exact');
    expect(ex.affinity).toBeCloseTo(1 - BREADTH_DISCOUNT, 6);
    // A leaf keeps the full 1.0.
    const leaf = centroid('Tech House', [1, 0]);
    expect(explainGenrePair('Tech House', 'Tech House', mapOf(leaf)).affinity).toBe(1);
  });

  it('scores a known pair from the centroid cosine, rescaled, times the weaker credit', () => {
    const a = centroid('Tech House', [1, 0]);
    const b = centroid('Minimal Techno', [1, 0.2]);
    const ex = explainGenrePair('Tech House', 'Minimal Techno', mapOf(a, b));
    expect(ex.source).toBe('centroid');
    expect(ex.cosine).toBeCloseTo(1 / Math.sqrt(1.04), 5);
    expect(ex.credit).toBe(1);
    expect(ex.affinity).toBeCloseTo(rescaleCosine(ex.cosine!), 6);
  });

  it('is symmetric', () => {
    const a = centroid('Tech House', [1, 0], { coherence: 0.8 });
    const b = centroid('Electronic', [0.9, 0.4], { coherence: 0.6 });
    const ab = explainGenrePair('Tech House', 'Electronic', mapOf(a, b));
    const ba = explainGenrePair('Electronic', 'Tech House', mapOf(a, b));
    expect(ab.affinity).toBeCloseTo(ba.affinity!, 9);
    expect(ab.credit).toBeCloseTo(ba.credit!, 9);
  });

  it('returns null (lexical fallback) when a side is unknown or too thin', () => {
    const a = centroid('Tech House', [1, 0]);
    const thin = centroid('Chacarera', [0, 1], { members: MIN_MEMBERS - 1 });
    expect(explainGenrePair('Tech House', 'Tango', mapOf(a)).affinity).toBeNull();
    expect(explainGenrePair('Tech House', 'Chacarera', mapOf(a, thin)).affinity).toBeNull();
    expect(explainGenrePair('Tech House', 'Chacarera', mapOf(a, thin)).source).toBe('unknown');
    // A thin exact match is still exact, and still discounted only by coherence.
    expect(explainGenrePair('Chacarera', 'Chacarera', mapOf(thin)).affinity).toBe(1);
  });

  it('never compares centroids across embedding models', () => {
    const a = centroid('Tech House', [1, 0]);
    const b = centroid('Minimal Techno', [1, 0], { model: 'other-model' });
    expect(explainGenrePair('Tech House', 'Minimal Techno', mapOf(a, b)).affinity).toBeNull();
  });

  it('a far pair (cosine at or below the floor) scores 0, not null', () => {
    const a = centroid('Tech House', [1, 0]);
    const b = centroid('Tango', [0, 1]);
    const ex = explainGenrePair('Tech House', 'Tango', mapOf(a, b));
    expect(ex.affinity).toBe(0);
    expect(ex.source).toBe('centroid');
  });

  /**
   * The reported failure: a shared umbrella tag ("Electronic") used to be a
   * perfect 1.0 between "Electronic; Tech House" and "Electronic; Big Room",
   * masking the specific mismatch. With coherence-discounted exact matches, a
   * real neighbour named by the audio outranks the shared umbrella.
   */
  it('lets a specific neighbour beat a shared umbrella tag', () => {
    const cs = mapOf(
      centroid('Electronic', [1, 1], { coherence: 0.5 }),
      centroid('Tech House', [1, 0.1], { coherence: 0.9 }),
      centroid('Minimal Techno', [1, 0.2], { coherence: 0.9 }),
      centroid('Big Room', [0.2, 1], { coherence: 0.9 }),
    );
    const umbrella = explainGenrePair('Electronic', 'Electronic', cs).affinity!;
    const neighbour = explainGenrePair('Tech House', 'Minimal Techno', cs).affinity!;
    const wrong = explainGenrePair('Tech House', 'Big Room', cs).affinity!;
    expect(neighbour).toBeGreaterThan(umbrella);
    expect(umbrella).toBeGreaterThan(wrong);
  });
});

describe('makeGenreAffinity / rankNeighbours', () => {
  const cs = mapOf(
    centroid('Tech House', [1, 0.1]),
    centroid('Minimal Techno', [1, 0.2]),
    centroid('Deep House', [1, 0.4]),
    centroid('Tango', [0, 1]),
    centroid('Chacarera', [0.1, 1], { members: 2 }),
  );

  it('is the scorer-facing view of explainGenrePair', () => {
    const fn = makeGenreAffinity(cs);
    expect(fn('Tech House', 'Minimal Techno')).toBeCloseTo(
      explainGenrePair('Tech House', 'Minimal Techno', cs).affinity!,
      9,
    );
    expect(fn('Tech House', 'Unknown Genre')).toBeNull();
  });

  it('ranks a vocabulary by affinity, omitting self and unknown/thin entries', () => {
    const ranked = rankNeighbours(
      'Tech House',
      ['Tech House', 'Minimal Techno', 'Deep House', 'Tango', 'Chacarera', 'Nope'],
      cs,
    );
    expect(ranked.map((r) => r.genre)).toEqual(['Minimal Techno', 'Deep House', 'Tango']);
    expect(rankNeighbours('Tech House', ['Minimal Techno', 'Deep House'], cs, 1)).toHaveLength(1);
  });
});
