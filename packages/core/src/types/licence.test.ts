import { describe, expect, it } from 'bun:test';
import {
  LICENCE_VOCAB,
  LICENCE_LABELS,
  LICENCE_BADGES,
  isLicenceCode,
  isFreeLicence,
  normalizeLicence,
} from './licence.js';

describe('licence vocabulary', () => {
  it('has a label and a badge for every code', () => {
    for (const code of LICENCE_VOCAB) {
      expect(LICENCE_LABELS[code]).toBeTruthy();
      expect(LICENCE_BADGES[code]).toBeTruthy();
    }
  });

  it('isLicenceCode guards the closed set', () => {
    expect(isLicenceCode('public-domain')).toBe(true);
    expect(isLicenceCode('cc-by-nc-sa')).toBe(true);
    expect(isLicenceCode('bogus')).toBe(false);
    expect(isLicenceCode(42)).toBe(false);
    expect(isLicenceCode(undefined)).toBe(false);
  });

  it('isFreeLicence covers public-domain + cc0 only', () => {
    expect(isFreeLicence('public-domain')).toBe(true);
    expect(isFreeLicence('cc0')).toBe(true);
    expect(isFreeLicence('cc-by')).toBe(false);
    expect(isFreeLicence('all-rights-reserved')).toBe(false);
    expect(isFreeLicence(null)).toBe(false);
  });
});

describe('normalizeLicence — Creative Commons URLs', () => {
  it('maps licence URLs to the right flavour', () => {
    expect(normalizeLicence('https://creativecommons.org/licenses/by/4.0/')).toBe('cc-by');
    expect(normalizeLicence('http://creativecommons.org/licenses/by-sa/3.0/')).toBe('cc-by-sa');
    expect(normalizeLicence('https://creativecommons.org/licenses/by-nc/4.0')).toBe('cc-by-nc');
    expect(normalizeLicence('https://creativecommons.org/licenses/by-nd/4.0/')).toBe('cc-by-nd');
    expect(normalizeLicence('https://creativecommons.org/licenses/by-nc-sa/4.0/')).toBe(
      'cc-by-nc-sa',
    );
    expect(normalizeLicence('https://creativecommons.org/licenses/by-nc-nd/4.0/')).toBe(
      'cc-by-nc-nd',
    );
  });

  it('maps public-domain URLs', () => {
    expect(normalizeLicence('https://creativecommons.org/publicdomain/zero/1.0/')).toBe('cc0');
    expect(normalizeLicence('https://creativecommons.org/publicdomain/mark/1.0/')).toBe(
      'public-domain',
    );
  });
});

describe('normalizeLicence — free text', () => {
  it('recognises public domain / CC0 phrasings', () => {
    expect(normalizeLicence('Public Domain')).toBe('public-domain');
    expect(normalizeLicence('public-domain')).toBe('public-domain');
    expect(normalizeLicence('CC0')).toBe('cc0');
    expect(normalizeLicence('Creative Commons Zero')).toBe('cc0');
  });

  it('assembles a CC licence from clause text', () => {
    expect(normalizeLicence('CC BY')).toBe('cc-by');
    expect(normalizeLicence('CC BY-SA 4.0')).toBe('cc-by-sa');
    expect(normalizeLicence('cc_by_nc_sa')).toBe('cc-by-nc-sa');
    expect(normalizeLicence('Creative Commons Attribution-NonCommercial')).toBe('cc-by-nc');
    expect(normalizeLicence('Creative Commons Attribution-ShareAlike')).toBe('cc-by-sa');
    expect(normalizeLicence('Attribution-NoDerivs Creative Commons')).toBe('cc-by-nd');
  });

  it('maps explicit all-rights-reserved only', () => {
    expect(normalizeLicence('All Rights Reserved')).toBe('all-rights-reserved');
    expect(normalizeLicence('all-rights-reserved')).toBe('all-rights-reserved');
  });

  it('never guesses ARR from a bare copyright notice', () => {
    expect(normalizeLicence('© 2020 Some Artist')).toBeNull();
    expect(normalizeLicence('(C) 1999 Label Ltd')).toBeNull();
    expect(normalizeLicence('Copyright Big Records')).toBeNull();
  });

  it('returns null for unknown / empty / non-licence input', () => {
    expect(normalizeLicence('')).toBeNull();
    expect(normalizeLicence('   ')).toBeNull();
    expect(normalizeLicence(undefined)).toBeNull();
    expect(normalizeLicence(null)).toBeNull();
    expect(normalizeLicence('unknown')).toBeNull();
    expect(normalizeLicence('Song by The Beatles')).toBeNull();
  });

  it('round-trips every positive canonical code (except unknown)', () => {
    for (const code of LICENCE_VOCAB) {
      if (code === 'unknown') continue;
      expect(normalizeLicence(code)).toBe(code);
    }
  });
});
