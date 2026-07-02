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
