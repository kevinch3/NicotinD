import { describe, it, expect } from 'bun:test';
import { descriptorSpreadLines, looksConcatenatedGenre, parseWeightOverrides } from './dump-radio';
import { DEFAULT_WEIGHTS, type SongFeatures } from '../services/radio.service';

describe('descriptorSpreadLines (the v4 tripwire, applied to the v5 axes)', () => {
  const base = (over: Partial<SongFeatures>): SongFeatures => ({
    duration: 200,
    artistId: 'x',
    ...over,
  });
  const t = (a: number, b: number): number[] => [a, b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  it('reports mean/sd per new axis across the SERVED window and flags a constant axis', () => {
    const seed = base({ timbre: t(1, 0), bands: [1, 0, 0, 0, 0, 0] });
    const served = [
      base({ timbre: t(1, 0), bands: [1, 0, 0, 0, 0, 0] }),
      base({ timbre: t(0, 1), bands: [1, 0, 0, 0, 0, 0] }),
      base({ timbre: t(-1, 0), bands: [1, 0, 0, 0, 0, 0] }),
    ];
    const lines = descriptorSpreadLines(seed, served, DEFAULT_WEIGHTS);
    const timbre = lines.find((l) => l.includes('timbre'))!;
    const balance = lines.find((l) => l.includes('spectralBalance'))!;
    expect(timbre).toMatch(/mean 0\.500 sd 0\.408/);
    expect(timbre).not.toContain('GATING');
    expect(balance).toMatch(/sd 0\.000/);
    expect(balance).toContain('GATING, NOT ORDERING');
    // groove: no side carries it → reported as absent, not as a number.
    expect(lines.find((l) => l.includes('groove'))).toContain('0/3');
  });

  it('is silent when no served track carries descriptors', () => {
    const seed = base({});
    expect(descriptorSpreadLines(seed, [base({}), base({})], DEFAULT_WEIGHTS)).toEqual([]);
  });
});

describe('parseWeightOverrides (--weights, the A/B measurement lever)', () => {
  it('returns the defaults unchanged when no override is given', () => {
    expect(parseWeightOverrides(undefined)).toEqual(DEFAULT_WEIGHTS);
  });

  it('overrides only the named axes', () => {
    const w = parseWeightOverrides('genre=14,embedding=8');
    expect(w.genre).toBe(14);
    expect(w.embedding).toBe(8);
    expect(w.bpm).toBe(DEFAULT_WEIGHTS.bpm);
    // Never mutates the shared defaults.
    expect(DEFAULT_WEIGHTS.genre).not.toBe(14);
  });

  it('accepts fractional values and surrounding whitespace', () => {
    expect(parseWeightOverrides(' artistPenalty = 0.25 ').artistPenalty).toBe(0.25);
  });

  it('throws on an unknown axis or a non-numeric value (a typo must not silently no-op)', () => {
    expect(() => parseWeightOverrides('genr=14')).toThrow(/unknown/i);
    expect(() => parseWeightOverrides('genre=lots')).toThrow(/numeric/i);
    expect(() => parseWeightOverrides('genre')).toThrow();
  });
});

describe('looksConcatenatedGenre (genre-detection miss flag)', () => {
  it('flags un-split concatenations seen in the real library', () => {
    // Both observed verbatim in a José Larralde radio dump.
    expect(looksConcatenatedGenre('LatinWorld')).toBe(true);
    expect(looksConcatenatedGenre('EuropopPopSoft RockElectronicRockSchlager')).toBe(true);
    expect(looksConcatenatedGenre('PsychedelicRockGarageRock')).toBe(true);
  });

  it('does NOT flag clean single genres', () => {
    expect(looksConcatenatedGenre('Folk')).toBe(false);
    expect(looksConcatenatedGenre('Chamamé')).toBe(false);
    expect(looksConcatenatedGenre('House')).toBe(false);
    expect(looksConcatenatedGenre('Hip-Hop')).toBe(false);
  });

  it('does NOT flag properly delimited multi-genre (splitGenres handles those)', () => {
    expect(looksConcatenatedGenre('Rock; Indie; Psychedelic')).toBe(false);
    expect(looksConcatenatedGenre('Hip-Hop, Rap')).toBe(false);
    expect(looksConcatenatedGenre('Deep House | Tech House')).toBe(false);
  });

  it('does not flag short or hump-free tags', () => {
    expect(looksConcatenatedGenre('Dubstep')).toBe(false); // no mid-string capital
    expect(looksConcatenatedGenre('NewWave')).toBe(false); // 1 hump but < 8 chars
    expect(looksConcatenatedGenre('Acid House')).toBe(false); // space-separated, no hump
  });
});
