import { describe, it, expect } from 'bun:test';
import { looksConcatenatedGenre } from './dump-radio';

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
