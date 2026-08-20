import { describe, it, expect } from 'bun:test';
import {
  ANCHOR_MIN_MEMBERS,
  DEPTH_CREDIT,
  SHARE_REFERENCE,
  anchorCentroid,
  genreDepthScore,
  matchedGenrePosition,
  stationAffinity,
} from './station-affinity';

describe('matchedGenrePosition', () => {
  it('returns the shallowest matching position', () => {
    expect(matchedGenrePosition(['Rock', 'Pop', 'Electronic'], ['Electronic'])).toBe(2);
    expect(matchedGenrePosition(['Electronic', 'House'], ['Electronic'])).toBe(0);
  });

  it('matches case- and whitespace-insensitively, like the pool SQL', () => {
    expect(matchedGenrePosition(['  deep   house '], ['Deep House'])).toBe(0);
  });

  it('takes the shallowest across a multi-genre station', () => {
    expect(matchedGenrePosition(['Rock', 'House'], ['Electronic', 'House'])).toBe(1);
  });

  it('is null when the candidate carries none of them', () => {
    expect(matchedGenrePosition(['Rock', 'Pop'], ['Electronic'])).toBeNull();
    expect(matchedGenrePosition([], ['Electronic'])).toBeNull();
    expect(matchedGenrePosition(undefined, ['Electronic'])).toBeNull();
    expect(matchedGenrePosition(['Electronic'], [])).toBeNull();
  });

  it('does NOT partially match a sub-genre — there is no taxonomy here', () => {
    expect(matchedGenrePosition(['House'], ['Electronic'])).toBeNull();
  });
});

describe('genreDepthScore', () => {
  it('credits a primary tag above a secondary above a footnote', () => {
    const primary = genreDepthScore(['Electronic'], ['Electronic'])!;
    const secondary = genreDepthScore(['Pop', 'Electronic'], ['Electronic'])!;
    const deep = genreDepthScore(['Rock', 'Pop', 'Electronic'], ['Electronic'])!;
    expect(primary).toBeGreaterThan(secondary);
    expect(secondary).toBeGreaterThan(deep);
    expect(primary).toBe(DEPTH_CREDIT[0]!);
  });

  it('treats anything past the table as equally a footnote', () => {
    const third = genreDepthScore(['a', 'b', 'Electronic'], ['Electronic'])!;
    const eighth = genreDepthScore(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'Electronic'],
      ['Electronic'],
    )!;
    expect(eighth).toBe(third);
  });

  it('is null for a non-member', () => {
    expect(genreDepthScore(['Rock'], ['Electronic'])).toBeNull();
  });
});

describe('stationAffinity', () => {
  it('ranks a genre native above a marginally-tagged track by a foreign artist', () => {
    // The reported case: Calvin Harris (primary tag, ~90% of his catalogue) vs
    // a Queen track wearing the tag third by an artist who is ~3% Electronic.
    const native = stationAffinity(genreDepthScore(['Electronic'], ['Electronic']), 0.9);
    const marginal = stationAffinity(
      genreDepthScore(['Rock', 'Pop', 'Electronic'], ['Electronic']),
      0.03,
    );
    expect(native).toBeGreaterThan(marginal);
    expect(native - marginal).toBeGreaterThan(0.5);
  });

  it('lets a primary tag carry a track by an otherwise-foreign artist', () => {
    // A genuinely electronic record by a mostly-pop artist must still place —
    // the station should survive a broad-but-legitimate tag, not depend on
    // perfect tagging.
    const realRecord = stationAffinity(genreDepthScore(['Electronic'], ['Electronic']), 0.05);
    const footnote = stationAffinity(
      genreDepthScore(['Rock', 'Pop', 'Electronic'], ['Electronic']),
      0.05,
    );
    expect(realRecord).toBeGreaterThan(footnote);
    expect(realRecord).toBeGreaterThan(0.4);
  });

  it('lets a high artist share carry a deep tag', () => {
    const deepTagNativeArtist = stationAffinity(
      genreDepthScore(['House', 'Techno', 'Electronic'], ['Electronic']),
      1,
    );
    expect(deepTagNativeArtist).toBeGreaterThan(0.6);
  });

  it('is monotonic in artist share and saturates at the reference', () => {
    const depth = genreDepthScore(['Electronic'], ['Electronic']);
    expect(stationAffinity(depth, 0.1)).toBeLessThan(stationAffinity(depth, 0.3));
    expect(stationAffinity(depth, SHARE_REFERENCE)).toBe(stationAffinity(depth, 1));
  });

  it('stays within 0..1 for missing/degenerate inputs', () => {
    expect(stationAffinity(null, undefined)).toBe(0);
    expect(stationAffinity(1, 5)).toBe(1);
    expect(stationAffinity(null, 1)).toBeGreaterThan(0);
  });
});

/** Deterministic unit-ish vector pointing in one of two directions. */
function vec(dir: 'a' | 'b', jitter = 0): Float32Array {
  return dir === 'a' ? new Float32Array([1, jitter, 0]) : new Float32Array([0, jitter, 1]);
}

describe('anchorCentroid', () => {
  it('is null without vectors', () => {
    expect(anchorCentroid([])).toBeNull();
    expect(anchorCentroid([{ affinity: 1 }, { affinity: 0.5 }])).toBeNull();
  });

  it('returns an L2-normalised vector', () => {
    const out = anchorCentroid([
      { affinity: 1, embedding: vec('a') },
      { affinity: 1, embedding: vec('a', 0.1) },
    ])!;
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('follows the high-affinity members, not the majority', () => {
    // 4 central "a" members outrank 20 low-affinity "b" ones: the anchor must
    // point at "a". Averaging the tagged pool is the bug this replaces.
    const members = [
      ...Array.from({ length: 4 }, () => ({ affinity: 1, embedding: vec('a') })),
      ...Array.from({ length: 20 }, () => ({ affinity: 0.05, embedding: vec('b') })),
    ];
    const out = anchorCentroid(members)!;
    expect(out[0]!).toBeGreaterThan(out[2]!);
  });

  it('settles on the denser mode of a bimodal tag instead of the gap between', () => {
    // Uniform affinity and INTERLEAVED, so neither the affinity sort nor the
    // input order can decide this — only the trim pass can. Two audio modes at
    // 2:1; a single weighted mean lands between them (~0.89 / ~0.45), which is
    // the "average of everything tagged Electronic" failure one level down.
    // Sized past ANCHOR_MIN_MEMBERS * 2 so the trim actually runs.
    const members = Array.from({ length: 90 }, (_, i) => ({
      affinity: 0.8,
      embedding: vec(i % 3 === 2 ? 'b' : 'a', i * 1e-4),
    }));
    const out = anchorCentroid(members)!;
    expect(out[0]!).toBeGreaterThan(0.99);
    expect(out[2]!).toBeLessThan(0.05);
  });

  it('ignores vectors of a foreign dimension rather than throwing', () => {
    const members = [
      ...Array.from({ length: ANCHOR_MIN_MEMBERS }, () => ({ affinity: 1, embedding: vec('a') })),
      { affinity: 1, embedding: new Float32Array([1, 2, 3, 4, 5]) },
    ];
    const out = anchorCentroid(members)!;
    expect(out.length).toBe(3);
  });
});
