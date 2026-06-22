import { describe, it, expect } from 'bun:test';
import { looksLikeSourceWatermark, isNumericLikeName } from './library-quality.js';

describe('looksLikeSourceWatermark', () => {
  it('flags bare-domain watermarks seen in the prod library', () => {
    expect(looksLikeSourceWatermark('ftpdjemilio.com')).toBe(true);
    expect(looksLikeSourceWatermark('MUSICAUNO.COM')).toBe(true);
    expect(looksLikeSourceWatermark('www.somepool.net')).toBe(true);
  });

  it('flags DJ-pool / batea source keywords', () => {
    expect(looksLikeSourceWatermark('DJ KAIRUZ- SERVICIO ARG')).toBe(true);
    expect(looksLikeSourceWatermark('Batea Especial Casamientos + 50 Años')).toBe(true);
  });

  it('does not flag legitimate artists (incl. bare "DJ" prefix)', () => {
    expect(looksLikeSourceWatermark('DJ Snake')).toBe(false);
    expect(looksLikeSourceWatermark('Soda Stereo')).toBe(false);
    expect(looksLikeSourceWatermark('Calle 13')).toBe(false);
    expect(looksLikeSourceWatermark('blink-182')).toBe(false);
    expect(looksLikeSourceWatermark('')).toBe(false);
    expect(looksLikeSourceWatermark(undefined)).toBe(false);
  });
});

describe('isNumericLikeName', () => {
  it('flags bare numbers and disc-track shapes (mis-parsed tags)', () => {
    expect(isNumericLikeName('101')).toBe(true);
    expect(isNumericLikeName('208')).toBe(true);
    expect(isNumericLikeName('12')).toBe(true);
    expect(isNumericLikeName('07.')).toBe(true);
    expect(isNumericLikeName('02-03')).toBe(true);
    expect(isNumericLikeName('03,4,5,6')).toBe(true);
  });

  it('flags any bare number incl. 4-digit (context protects real album titles)', () => {
    // The raw predicate flags "1989" too; the auditor only treats a numeric value
    // as pollution when it's an ARTIST name, or an album title on a single-track
    // album — so legit numeric album titles like "1989"/"21" are never deleted.
    expect(isNumericLikeName('1989')).toBe(true);
    expect(isNumericLikeName('21')).toBe(true);
  });

  it('does not flag names containing letters', () => {
    expect(isNumericLikeName('Calle 13')).toBe(false);
    expect(isNumericLikeName('Maroon 5')).toBe(false);
    expect(isNumericLikeName('1000 Forms of Fear')).toBe(false);
    expect(isNumericLikeName('')).toBe(false);
    expect(isNumericLikeName(undefined)).toBe(false);
  });
});
