import { describe, expect, it } from 'bun:test';
import {
  ALL_COUNTRY_CODES,
  countryFlagEmoji,
  isCountryCode,
  normalizeMbCountry,
  originCloseness,
  originSetCloseness,
  regionOf,
  superRegionOf,
} from './origin.js';

describe('isCountryCode', () => {
  it('accepts real ISO 3166-1 alpha-2 codes', () => {
    expect(isCountryCode('AR')).toBe(true);
    expect(isCountryCode('GB')).toBe(true);
  });
  it('rejects non-codes, lowercase, and MB special codes', () => {
    expect(isCountryCode('ZZ')).toBe(false);
    expect(isCountryCode('ar')).toBe(false);
    expect(isCountryCode('XW')).toBe(false); // MB "worldwide" is not a country
    expect(isCountryCode(3)).toBe(false);
    expect(isCountryCode(null)).toBe(false);
  });
});

describe('normalizeMbCountry', () => {
  it('uppercases and validates', () => {
    expect(normalizeMbCountry('ar')).toBe('AR');
    expect(normalizeMbCountry(' cl ')).toBe('CL');
  });
  it('maps MB non-country codes and garbage to null', () => {
    expect(normalizeMbCountry('XW')).toBe(null);
    expect(normalizeMbCountry('XE')).toBe(null);
    expect(normalizeMbCountry('Argentina')).toBe(null); // codes only, never names
    expect(normalizeMbCountry('')).toBe(null);
    expect(normalizeMbCountry(null)).toBe(null);
  });
});

describe('regionOf / superRegionOf', () => {
  it('maps countries to musical-cultural regions', () => {
    expect(regionOf('AR')).toBe('rio-de-la-plata');
    expect(regionOf('UY')).toBe('rio-de-la-plata');
    expect(regionOf('GB')).toBe('uk-ireland');
    expect(regionOf('BR')).toBe('brazil');
  });
  it('returns null for a country with no region entry', () => {
    expect(regionOf('AQ')).toBe(null); // Antarctica — deliberately unmapped
  });
  it('maps regions to super-regions', () => {
    expect(superRegionOf('AR')).toBe('latin-america');
    expect(superRegionOf('GB')).toBe('anglosphere');
    expect(superRegionOf('US')).toBe('anglosphere');
    expect(superRegionOf('DE')).toBe('europe');
  });
});

describe('originCloseness', () => {
  it('same country → 1.0', () => {
    expect(originCloseness('AR', 'AR')).toBe(1.0);
  });
  it('same region → 0.7 (Argentina/Uruguay)', () => {
    expect(originCloseness('AR', 'UY')).toBe(0.7);
  });
  it('same super-region → 0.4 (Argentina/Mexico both latin-america)', () => {
    expect(originCloseness('AR', 'MX')).toBe(0.4);
  });
  it('different worlds → 0.1 floor, never 0 (the cuarteto/Queen case)', () => {
    expect(originCloseness('AR', 'GB')).toBe(0.1);
  });
  it('US and GB share the anglosphere → 0.4', () => {
    expect(originCloseness('US', 'GB')).toBe(0.4);
  });
  it('unknown either side → null (axis skipped)', () => {
    expect(originCloseness(null, 'AR')).toBe(null);
    expect(originCloseness('AR', undefined)).toBe(null);
    expect(originCloseness('ZZ', 'AR')).toBe(null); // invalid code = unknown
  });
});

describe('originSetCloseness', () => {
  it('max pairwise over credited-artist sets (a collab matches both sides)', () => {
    expect(originSetCloseness(['AR'], ['ES', 'AR'])).toBe(1.0);
    // CL (andean) ↔ AR (rio-de-la-plata): cross-region, same latin-america super → 0.4;
    // FR ↔ AR → 0.1; max pairwise = 0.4.
    expect(originSetCloseness(['CL', 'FR'], ['AR'])).toBe(0.4);
  });
  it('null when either side is empty', () => {
    expect(originSetCloseness([], ['AR'])).toBe(null);
    expect(originSetCloseness(undefined, ['AR'])).toBe(null);
  });
});

describe('countryFlagEmoji', () => {
  it('derives the flag arithmetically from the code', () => {
    expect(countryFlagEmoji('AR')).toBe('🇦🇷');
    expect(countryFlagEmoji('gb')).toBe('🇬🇧');
  });
  it('empty string for invalid codes', () => {
    expect(countryFlagEmoji('ZZ')).toBe('');
  });
});

describe('ALL_COUNTRY_CODES', () => {
  it('is the sorted full ISO list', () => {
    expect(ALL_COUNTRY_CODES).toHaveLength(249);
    expect([...ALL_COUNTRY_CODES]).toEqual([...ALL_COUNTRY_CODES].sort());
    expect(ALL_COUNTRY_CODES).toContain('AR');
  });
  it('every region-table country is a real ISO code', () => {
    for (const code of ALL_COUNTRY_CODES) expect(isCountryCode(code)).toBe(true);
  });
});
