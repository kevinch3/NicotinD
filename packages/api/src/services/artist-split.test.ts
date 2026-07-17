import { describe, expect, it } from 'bun:test';
import { splitArtists, formatArtistDisplay, isAtomicArtist } from './artist-split.js';
import type { ArtistCredit } from './artist-split.js';

function primaries(credits: ArtistCredit[]): string[] {
  return credits.filter((c) => c.role === 'primary').map((c) => c.name);
}

function featuring(credits: ArtistCredit[]): string[] {
  return credits.filter((c) => c.role === 'featuring').map((c) => c.name);
}

// Helper: build a confirmed-artist set from raw names (normalized like the scanner does).
function confirmed(...names: string[]) {
  return { confirmedArtists: new Set(names.map((n) => n.toLowerCase())) };
}

describe('splitArtists', () => {
  describe('single artist (no splitting)', () => {
    it('returns a single primary for a plain artist', () => {
      const result = splitArtists('Daft Punk');
      expect(primaries(result)).toEqual(['Daft Punk']);
      expect(featuring(result)).toEqual([]);
    });

    it('returns Unknown Artist for empty string', () => {
      expect(primaries(splitArtists(''))).toEqual(['Unknown Artist']);
    });

    it('returns Unknown Artist as-is', () => {
      expect(primaries(splitArtists('Unknown Artist'))).toEqual(['Unknown Artist']);
    });
  });

  describe('conservative splitting — only when every part is confirmed', () => {
    it('splits on " & " when both parts are confirmed artists', () => {
      const result = splitArtists(
        'Charly Garcia & Spinetta',
        confirmed('charly garcia', 'spinetta'),
      );
      expect(primaries(result)).toEqual(['Charly Garcia', 'Spinetta']);
    });

    it('splits on ";" (a known acquisition divider) when both parts confirmed', () => {
      // confirmed() names are de-accented, matching normalizeArtistForGrouping.
      const result = splitArtists(
        'C. Tangana; Andrés Calamaro',
        confirmed('c. tangana', 'andres calamaro'),
      );
      expect(primaries(result)).toEqual(['C. Tangana', 'Andrés Calamaro']);
    });

    it('splits on ";" with no surrounding spaces', () => {
      const result = splitArtists('Artist A;Artist B', confirmed('artist a', 'artist b'));
      expect(primaries(result)).toEqual(['Artist A', 'Artist B']);
    });

    it('keeps a ";"-joined compound whole when a part is unconfirmed', () => {
      const result = splitArtists('C. Tangana; Andrés Calamaro', confirmed('c. tangana'));
      expect(primaries(result)).toEqual(['C. Tangana; Andrés Calamaro']);
    });

    it('splits on " y " (Spanish and) when both parts confirmed', () => {
      const result = splitArtists(
        'Charly García y Luis Alberto Spinetta',
        confirmed('charly garcia', 'luis alberto spinetta'),
      );
      expect(primaries(result)).toEqual(['Charly García', 'Luis Alberto Spinetta']);
    });

    it('splits on ", "', () => {
      const result = splitArtists('Artist A, Artist B', confirmed('artist a', 'artist b'));
      expect(primaries(result)).toEqual(['Artist A', 'Artist B']);
    });

    it('splits on " / "', () => {
      const result = splitArtists('Artist A / Artist B', confirmed('artist a', 'artist b'));
      expect(primaries(result)).toEqual(['Artist A', 'Artist B']);
    });

    it('splits on " + "', () => {
      const result = splitArtists('Axwell + Ingrosso', confirmed('axwell', 'ingrosso'));
      expect(primaries(result)).toEqual(['Axwell', 'Ingrosso']);
    });

    it('splits on " and "', () => {
      const result = splitArtists('Hall and Oates', confirmed('hall', 'oates'));
      expect(primaries(result)).toEqual(['Hall', 'Oates']);
    });

    it('splits on " x " (word boundary)', () => {
      const result = splitArtists('Skrillex x Diplo', confirmed('skrillex', 'diplo'));
      expect(primaries(result)).toEqual(['Skrillex', 'Diplo']);
    });

    it('splits on " con "', () => {
      const result = splitArtists(
        'Daddy Yankee con Luis Fonsi',
        confirmed('daddy yankee', 'luis fonsi'),
      );
      expect(primaries(result)).toEqual(['Daddy Yankee', 'Luis Fonsi']);
    });

    it('splits on " vs "', () => {
      const result = splitArtists(
        'DJ Shadow vs Cut Chemist',
        confirmed('dj shadow', 'cut chemist'),
      );
      expect(primaries(result)).toEqual(['DJ Shadow', 'Cut Chemist']);
    });

    it('handles three-way split when all confirmed', () => {
      const result = splitArtists('A, B & C', confirmed('a', 'b', 'c'));
      expect(primaries(result)).toEqual(['A', 'B', 'C']);
    });

    it('does not split AC/DC (no spaces around /)', () => {
      const result = splitArtists('AC/DC', confirmed('ac', 'dc'));
      expect(primaries(result)).toEqual(['AC/DC']);
    });
  });

  describe('keep-whole guard — the conservative default', () => {
    it('keeps a compound whole when NO parts are confirmed', () => {
      const result = splitArtists('Bob Marley & The Wailers');
      expect(primaries(result)).toEqual(['Bob Marley & The Wailers']);
    });

    it('keeps a compound whole when only SOME parts are confirmed', () => {
      // Peter Tosh not in the library / not confirmed -> do not split.
      const result = splitArtists('Bob Marley, Peter Tosh', confirmed('bob marley'));
      expect(primaries(result)).toEqual(['Bob Marley, Peter Tosh']);
    });

    it('keeps a band whole even though a part is confirmed (Patricio Rey)', () => {
      const result = splitArtists(
        'Patricio Rey y sus Redonditos de Ricota',
        confirmed('patricio rey'),
      );
      expect(primaries(result)).toEqual(['Patricio Rey y sus Redonditos de Ricota']);
    });

    it('does NOT split an unknown combo (no confirmations)', () => {
      const result = splitArtists('New Artist A & New Artist B');
      expect(primaries(result)).toEqual(['New Artist A & New Artist B']);
    });
  });

  describe('canonicalWhole protection — duos/bands kept whole even if all parts confirmed', () => {
    it('keeps a duo whole when marked canonical even though both members are confirmed', () => {
      const result = splitArtists('Wisin & Yandel', {
        confirmedArtists: new Set(['wisin', 'yandel']),
        canonicalWhole: new Set(['wisin & yandel']),
      });
      expect(primaries(result)).toEqual(['Wisin & Yandel']);
    });

    it('still splits a genuine collab when both members confirmed and NOT canonical', () => {
      const result = splitArtists('Wisin & Yandel', {
        confirmedArtists: new Set(['wisin', 'yandel']),
      });
      expect(primaries(result)).toEqual(['Wisin', 'Yandel']);
    });
  });

  describe('featuring extraction (unconditional)', () => {
    it('extracts bare "feat." credit', () => {
      const result = splitArtists('Daft Punk feat. Pharrell');
      expect(primaries(result)).toEqual(['Daft Punk']);
      expect(featuring(result)).toEqual(['Pharrell']);
    });

    it('extracts bare "ft." credit', () => {
      const result = splitArtists('Drake ft. Rihanna');
      expect(primaries(result)).toEqual(['Drake']);
      expect(featuring(result)).toEqual(['Rihanna']);
    });

    it('extracts bare "featuring" credit', () => {
      const result = splitArtists('Kanye West featuring Kid Cudi');
      expect(primaries(result)).toEqual(['Kanye West']);
      expect(featuring(result)).toEqual(['Kid Cudi']);
    });

    it('extracts bracketed "(feat. X)" credit', () => {
      const result = splitArtists('Eminem (feat. Rihanna)');
      expect(primaries(result)).toEqual(['Eminem']);
      expect(featuring(result)).toEqual(['Rihanna']);
    });

    it('extracts square-bracketed "[ft. X]" credit', () => {
      const result = splitArtists('Jay-Z [ft. Beyoncé]');
      expect(primaries(result)).toEqual(['Jay-Z']);
      expect(featuring(result)).toEqual(['Beyoncé']);
    });

    it('extracts "with" as featuring', () => {
      const result = splitArtists('David Bowie with Mick Jagger');
      expect(primaries(result)).toEqual(['David Bowie']);
      expect(featuring(result)).toEqual(['Mick Jagger']);
    });

    it('splits multiple featured artists', () => {
      const result = splitArtists('Daft Punk feat. Pharrell & Nile Rodgers');
      expect(primaries(result)).toEqual(['Daft Punk']);
      expect(featuring(result)).toEqual(['Pharrell', 'Nile Rodgers']);
    });

    it('handles confirmed primary split + featuring', () => {
      const result = splitArtists('A & B feat. C & D', confirmed('a', 'b'));
      expect(primaries(result)).toEqual(['A', 'B']);
      expect(featuring(result)).toEqual(['C', 'D']);
    });

    it('keeps unconfirmed primary whole but still extracts featuring', () => {
      const result = splitArtists('A & B feat. C');
      expect(primaries(result)).toEqual(['A & B']);
      expect(featuring(result)).toEqual(['C']);
    });

    it('does not split a canonical primary even with featuring', () => {
      const result = splitArtists('Earth, Wind & Fire feat. Pharrell', {
        canonicalWhole: new Set(['earth, wind & fire']),
      });
      expect(primaries(result)).toEqual(['Earth, Wind & Fire']);
      expect(featuring(result)).toEqual(['Pharrell']);
    });

    it('handles parenthesized featuring with multiple artists', () => {
      const result = splitArtists('Major Lazer (feat. MØ & DJ Snake)');
      expect(primaries(result)).toEqual(['Major Lazer']);
      expect(featuring(result)).toEqual(['MØ', 'DJ Snake']);
    });
  });
});

describe('isAtomicArtist', () => {
  it('treats a plain name as atomic', () => {
    expect(isAtomicArtist('Charly García')).toBe(true);
  });

  it('treats Unknown Artist / empty as atomic', () => {
    expect(isAtomicArtist('Unknown Artist')).toBe(true);
    expect(isAtomicArtist('')).toBe(true);
  });

  it('treats a delimited compound as NOT atomic', () => {
    expect(isAtomicArtist('Bob Marley, Peter Tosh')).toBe(false);
    expect(isAtomicArtist('Wisin & Yandel')).toBe(false);
    expect(isAtomicArtist('Charly García y Luis Alberto Spinetta')).toBe(false);
    expect(isAtomicArtist('C. Tangana; Andrés Calamaro')).toBe(false);
  });

  it('treats a name with a featuring credit as NOT atomic', () => {
    expect(isAtomicArtist('Daft Punk feat. Pharrell')).toBe(false);
  });

  it('keeps AC/DC atomic (no spaced slash)', () => {
    expect(isAtomicArtist('AC/DC')).toBe(true);
  });
});

describe('formatArtistDisplay', () => {
  it('formats a single primary', () => {
    expect(formatArtistDisplay([{ name: 'Daft Punk', role: 'primary' }])).toBe('Daft Punk');
  });

  it('formats multiple primaries', () => {
    expect(
      formatArtistDisplay([
        { name: 'A', role: 'primary' },
        { name: 'B', role: 'primary' },
      ]),
    ).toBe('A & B');
  });

  it('formats primary + featuring', () => {
    expect(
      formatArtistDisplay([
        { name: 'Daft Punk', role: 'primary' },
        { name: 'Pharrell', role: 'featuring' },
      ]),
    ).toBe('Daft Punk feat. Pharrell');
  });

  it('formats multiple primaries + multiple featuring', () => {
    expect(
      formatArtistDisplay([
        { name: 'A', role: 'primary' },
        { name: 'B', role: 'primary' },
        { name: 'C', role: 'featuring' },
        { name: 'D', role: 'featuring' },
      ]),
    ).toBe('A & B feat. C & D');
  });
});
