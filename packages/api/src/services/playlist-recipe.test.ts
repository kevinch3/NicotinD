import { describe, it, expect } from 'bun:test';
import {
  orderTracks,
  runRecipe,
  weekSeedFor,
  slugSeed,
  seedCentroid,
  type OrderableRow,
  type PlaylistRecipe,
} from './playlist-recipe';

function row(overrides: Partial<OrderableRow> = {}): OrderableRow {
  return {
    id: 'id',
    artist: 'Artist',
    artistId: 'a',
    duration: 200,
    ...overrides,
  };
}

describe('weekSeedFor', () => {
  it('is stable within a week and increments across weeks', () => {
    const base = Date.UTC(2026, 0, 1);
    expect(weekSeedFor(base)).toBe(weekSeedFor(base + 6 * 86_400_000));
    expect(weekSeedFor(base + 7 * 86_400_000)).toBe(weekSeedFor(base) + 1);
  });
});

describe('slugSeed', () => {
  it('is deterministic per slug and differs between slugs', () => {
    expect(slugSeed('late-night')).toBe(slugSeed('late-night'));
    expect(slugSeed('late-night')).not.toBe(slugSeed('workout'));
  });
});

describe('orderTracks', () => {
  it('returns empty for empty input and never mutates', () => {
    const input: OrderableRow[] = [];
    expect(orderTracks(input, 'harmonic')).toEqual([]);
    expect(input).toEqual([]);
  });

  it('sorts by bpm / year / newest ascending/descending', () => {
    const rows = [
      row({ id: 'a', bpm: 130, year: 2010, addedAt: 1 }),
      row({ id: 'b', bpm: 90, year: 2020, addedAt: 3 }),
      row({ id: 'c', bpm: 110, year: 2000, addedAt: 2 }),
    ];
    expect(orderTracks(rows, 'bpm').map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(orderTracks(rows, 'year').map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(orderTracks(rows, 'newest').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('shuffle preserves input order', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    expect(orderTracks(rows, 'shuffle').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('harmonic chains to Camelot-adjacent neighbours', () => {
    // 8B (C major) → 8A (A minor, relative) → 9A (E minor, adjacent) preferred
    // over an incompatible 2A (D minor swap distance).
    const rows = [
      row({ id: 'seed', key: 'C major', bpm: 120 }),
      row({ id: 'far', key: 'D# minor', bpm: 120 }),
      row({ id: 'rel', key: 'A minor', bpm: 120 }),
    ];
    const ordered = orderTracks(rows, 'harmonic').map((r) => r.id);
    expect(ordered[0]).toBe('seed');
    // The relative minor (8A) is compatible with 8B; the far key is not.
    expect(ordered[1]).toBe('rel');
    expect(ordered).toHaveLength(3);
  });
});

describe('runRecipe', () => {
  const recipe: PlaylistRecipe = {
    slug: 'r',
    name: 'R',
    description: '',
    palette: { from: '#000', to: '#fff' },
    where: '1=1',
    targetSize: 3,
    maxPerArtist: 1,
    cadence: 'weekly',
  };
  const rows = Array.from({ length: 10 }, (_, i) =>
    row({ id: `s${i}`, artist: `Artist${i}`, artistId: `a${i}`, bpm: 100 + i }),
  );

  it('same week ⇒ same list; next week ⇒ different but reproducible', () => {
    const w1 = runRecipe(recipe, rows, 100);
    expect(runRecipe(recipe, rows, 100)).toEqual(w1);
    const w2 = runRecipe(recipe, rows, 101);
    expect(runRecipe(recipe, rows, 101)).toEqual(w2);
    expect(w2).not.toEqual(w1);
  });

  it('respects maxPerArtist', () => {
    const sameArtist = Array.from({ length: 5 }, (_, i) =>
      row({ id: `s${i}`, artist: 'One', artistId: 'one' }),
    );
    expect(runRecipe(recipe, sameArtist, 1)).toHaveLength(1);
  });

  it('empty candidate set ⇒ empty list', () => {
    expect(runRecipe(recipe, [], 1)).toEqual([]);
  });

  it('static cadence ignores the week seed', () => {
    const staticRecipe: PlaylistRecipe = { ...recipe, cadence: 'static' };
    expect(runRecipe(staticRecipe, rows, 1)).toEqual(runRecipe(staticRecipe, rows, 999));
  });
});

describe('seedCentroid', () => {
  it('returns null for empty input', () => {
    expect(seedCentroid([])).toBeNull();
  });

  it('averages numerics and takes the modal genre/key with a neutral artist', () => {
    const c = seedCentroid([
      row({ bpm: 100, year: 2000, duration: 200, genre: 'Rock', key: 'C major' }),
      row({ bpm: 140, year: 2010, duration: 300, genre: 'Rock', key: 'A minor' }),
    ]);
    expect(c).not.toBeNull();
    expect(c!.bpm).toBe(120);
    expect(c!.year).toBe(2005);
    expect(c!.duration).toBe(250);
    expect(c!.genre).toBe('Rock');
    expect(c!.artistId).toBe('');
  });
});

describe('orderTracks — energy-arc', () => {
  it('builds a ramp-up → peak → ramp-down shape', () => {
    const rows = [0.1, 0.9, 0.3, 0.7, 0.5].map((energy, i) => row({ id: `e${i}`, energy }));
    const ordered = orderTracks(rows, 'energy-arc');
    const energies = ordered.map((r) => r.energy!);
    // Peak sits strictly inside the set, not at either edge.
    const peakIdx = energies.indexOf(Math.max(...energies));
    expect(peakIdx).toBeGreaterThan(0);
    expect(peakIdx).toBeLessThan(energies.length - 1);
    // Non-decreasing up to the peak, non-increasing after it.
    for (let i = 1; i <= peakIdx; i++) expect(energies[i]!).toBeGreaterThanOrEqual(energies[i - 1]!);
    for (let i = peakIdx + 1; i < energies.length; i++)
      expect(energies[i]!).toBeLessThanOrEqual(energies[i - 1]!);
  });

  it('keeps every input row and pushes energy-less tracks to the edges', () => {
    const rows = [
      row({ id: 'nul1' }),
      row({ id: 'hi', energy: 0.9 }),
      row({ id: 'mid', energy: 0.5 }),
      row({ id: 'nul2' }),
      row({ id: 'lo', energy: 0.1 }),
    ];
    const ordered = orderTracks(rows, 'energy-arc');
    expect(ordered).toHaveLength(rows.length);
    expect(new Set(ordered.map((r) => r.id)).size).toBe(rows.length);
    // The unknown-energy rows must not occupy the peak position.
    const ids = ordered.map((r) => r.id);
    expect(ids.indexOf('hi')).toBeGreaterThan(ids.indexOf('nul1'));
    expect(ordered[0]!.energy ?? -1).toBeLessThanOrEqual(0.1);
    // Never mutates.
    expect(rows.map((r) => r.id)).toEqual(['nul1', 'hi', 'mid', 'nul2', 'lo']);
  });
});

describe('harmonicChain — energy tiebreak', () => {
  it('prefers the energy-closer neighbour when key/bpm tie', () => {
    // Same key + bpm for all: harmonic + bpm axes tie, energy decides.
    const rows = [
      row({ id: 'start', key: 'C major', bpm: 120, energy: 0.8 }),
      row({ id: 'far', key: 'C major', bpm: 120, energy: 0.1 }),
      row({ id: 'near', key: 'C major', bpm: 120, energy: 0.75 }),
    ];
    const ordered = orderTracks(rows, 'harmonic');
    expect(ordered.map((r) => r.id)).toEqual(['start', 'near', 'far']);
  });

  it('chains identically to before when no track carries energy', () => {
    const rows = [
      row({ id: 'a', key: 'C major', bpm: 120 }),
      row({ id: 'x', key: 'F# major', bpm: 80 }),
      row({ id: 'b', key: 'A minor', bpm: 121 }),
    ];
    // 'a' (8B) chains to relative-minor 'b' (8A) before the distant 'x'.
    expect(orderTracks(rows, 'harmonic').map((r) => r.id)).toEqual(['a', 'b', 'x']);
  });
});

describe('seedCentroid — perceptual means', () => {
  it('averages the perceptual fields over rows that have them', () => {
    const c = seedCentroid([
      row({ id: 'a', energy: 0.2, valence: 0.4, danceability: 0.6 }),
      row({ id: 'b', energy: 0.8, valence: 0.6 }), // no danceability
      row({ id: 'c' }), // un-analyzed
    ]);
    expect(c?.energy).toBeCloseTo(0.5);
    expect(c?.valence).toBeCloseTo(0.5);
    expect(c?.danceability).toBeCloseTo(0.6);
    expect(c?.instrumental).toBeUndefined();
    expect(c?.acousticness).toBeUndefined();
  });
});
