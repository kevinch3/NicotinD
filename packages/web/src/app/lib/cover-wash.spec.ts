import { describe, expect, it } from 'vitest';
import {
  COVER_WASH_MAX,
  COVER_WASH_MIN_CONTRAST,
  contrastRatio,
  coverWash,
  parseRgb,
  washOver,
  type Rgb,
} from './cover-wash';

// Midnight's and Daylight's surfaces and text levels (styles.css).
const MIDNIGHT = {
  surface: [10, 10, 15] as Rgb,
  texts: [
    [244, 244, 245],
    [168, 168, 180],
  ] as Rgb[],
};
const DAYLIGHT = {
  surface: [236, 236, 241] as Rgb,
  texts: [
    [24, 24, 27],
    [75, 75, 86],
  ] as Rgb[],
};

describe('parseRgb', () => {
  it('reads hex and both rgb() spellings', () => {
    expect(parseRgb('#0a0a0f')).toEqual([10, 10, 15]);
    expect(parseRgb('rgb(12, 34, 56)')).toEqual([12, 34, 56]);
    expect(parseRgb(' rgb(12 34 56) ')).toEqual([12, 34, 56]);
  });

  it('refuses what it cannot composite: a translucent colour, a keyword, nothing', () => {
    expect(parseRgb('rgba(12, 34, 56, 0.5)')).toBeNull();
    expect(parseRgb('transparent')).toBeNull();
    expect(parseRgb('')).toBeNull();
    expect(parseRgb(undefined)).toBeNull();
  });
});

describe('contrast maths', () => {
  it('is 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([90, 90, 90], [90, 90, 90])).toBe(1);
  });

  it('washOver is the surface at alpha 0 and the top colour at alpha 1', () => {
    expect(washOver([200, 0, 0], 0, [10, 10, 15])).toEqual([10, 10, 15]);
    expect(washOver([200, 0, 0], 1, [10, 10, 15])).toEqual([200, 0, 0]);
  });
});

describe('coverWash', () => {
  it('uses the full strength when the text stays legible', () => {
    const wash = coverWash([180, 40, 40], MIDNIGHT.surface, MIDNIGHT.texts)!;
    expect(wash.alpha).toBe(COVER_WASH_MAX);
    expect(wash.css).toBe('rgb(180 40 40 / 0.18)');
  });

  it('lowers the alpha until every text level clears 4.5:1', () => {
    // A mid-grey cover on Daylight: at 18% the secondary text falls short.
    const dominant: Rgb = [120, 120, 130];
    const wash = coverWash(dominant, DAYLIGHT.surface, DAYLIGHT.texts);
    expect(wash).not.toBeNull();
    const washed = washOver(dominant, wash!.alpha, DAYLIGHT.surface);
    for (const t of DAYLIGHT.texts) {
      expect(contrastRatio(t, washed)).toBeGreaterThanOrEqual(COVER_WASH_MIN_CONTRAST);
    }
    expect(wash!.alpha).toBeLessThanOrEqual(COVER_WASH_MAX);
  });

  it('holds 4.5:1 for every colour it accepts, across a spread of covers and both presets', () => {
    let accepted = 0;
    for (const preset of [MIDNIGHT, DAYLIGHT]) {
      for (let r = 0; r <= 255; r += 51) {
        for (let g = 0; g <= 255; g += 51) {
          for (let b = 0; b <= 255; b += 51) {
            const wash = coverWash([r, g, b], preset.surface, preset.texts);
            if (!wash) continue;
            accepted++;
            const washed = washOver([r, g, b], wash.alpha, preset.surface);
            for (const t of preset.texts) {
              expect(contrastRatio(t, washed)).toBeGreaterThanOrEqual(COVER_WASH_MIN_CONTRAST);
            }
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(300);
  });

  it('gives no wash at all when the text is already at the edge', () => {
    // Text at about 4.5:1 on the bare surface: any tint toward it breaks the floor.
    const surface: Rgb = [255, 255, 255];
    const text: Rgb = [118, 118, 118];
    expect(contrastRatio(text, surface)).toBeLessThan(4.6);
    expect(coverWash([118, 118, 118], surface, [text])).toBeNull();
  });
});
