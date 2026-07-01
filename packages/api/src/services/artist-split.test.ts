import { describe, expect, it } from 'bun:test';
import { splitArtists, formatArtistDisplay } from './artist-split.js';
import type { ArtistCredit } from './artist-split.js';

function names(credits: ArtistCredit[]): string[] {
  return credits.map((c) => c.name);
}

function primaries(credits: ArtistCredit[]): string[] {
  return credits.filter((c) => c.role === 'primary').map((c) => c.name);
}

function featuring(credits: ArtistCredit[]): string[] {
  return credits.filter((c) => c.role === 'featuring').map((c) => c.name);
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

  describe('delimiter splitting', () => {
    it('splits on " & "', () => {
      const result = splitArtists('Charly Garcia & Spinetta');
      expect(primaries(result)).toEqual(['Charly Garcia', 'Spinetta']);
    });

    it('splits on ", "', () => {
      const result = splitArtists('Artist A, Artist B');
      expect(primaries(result)).toEqual(['Artist A', 'Artist B']);
    });

    it('splits on " / "', () => {
      const result = splitArtists('Artist A / Artist B');
      expect(primaries(result)).toEqual(['Artist A', 'Artist B']);
    });

    it('does not split AC/DC (no spaces around /)', () => {
      const result = splitArtists('AC/DC');
      expect(primaries(result)).toEqual(['AC/DC']);
    });

    it('splits on " + "', () => {
      const result = splitArtists('Axwell + Ingrosso');
      expect(primaries(result)).toEqual(['Axwell', 'Ingrosso']);
    });

    it('splits on " and "', () => {
      const result = splitArtists('Hall and Oates');
      expect(primaries(result)).toEqual(['Hall', 'Oates']);
    });

    it('splits on " x " (word boundary)', () => {
      const result = splitArtists('Skrillex x Diplo');
      expect(primaries(result)).toEqual(['Skrillex', 'Diplo']);
    });

    it('splits on " y " (Spanish and)', () => {
      const result = splitArtists('Calle 13 y Rubén Blades');
      expect(primaries(result)).toEqual(['Calle 13', 'Rubén Blades']);
    });

    it('splits on " con "', () => {
      const result = splitArtists('Daddy Yankee con Luis Fonsi');
      expect(primaries(result)).toEqual(['Daddy Yankee', 'Luis Fonsi']);
    });

    it('splits on " vs "', () => {
      const result = splitArtists('DJ Shadow vs Cut Chemist');
      expect(primaries(result)).toEqual(['DJ Shadow', 'Cut Chemist']);
    });

    it('handles three-way split', () => {
      const result = splitArtists('A, B & C');
      expect(primaries(result)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('cross-reference guard', () => {
    it('does not split when full string is a known artist', () => {
      const known = new Set(['earth, wind & fire']);
      const result = splitArtists('Earth, Wind & Fire', known);
      expect(primaries(result)).toEqual(['Earth, Wind & Fire']);
    });

    it('does not split Simon & Garfunkel when known', () => {
      const known = new Set(['simon & garfunkel']);
      const result = splitArtists('Simon & Garfunkel', known);
      expect(primaries(result)).toEqual(['Simon & Garfunkel']);
    });

    it('splits when full string is NOT known', () => {
      const known = new Set(['charly garcia', 'spinetta']);
      const result = splitArtists('Charly Garcia & Spinetta', known);
      expect(primaries(result)).toEqual(['Charly Garcia', 'Spinetta']);
    });

    it('does not split known artist even with featuring', () => {
      const known = new Set(['earth, wind & fire']);
      const result = splitArtists('Earth, Wind & Fire feat. Pharrell', known);
      expect(primaries(result)).toEqual(['Earth, Wind & Fire']);
      expect(featuring(result)).toEqual(['Pharrell']);
    });

    it('splits unknown combo even if individual parts not in library', () => {
      const result = splitArtists('New Artist A & New Artist B', new Set());
      expect(primaries(result)).toEqual(['New Artist A', 'New Artist B']);
    });
  });

  describe('featuring extraction', () => {
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

    it('handles primary split + featuring', () => {
      const result = splitArtists('A & B feat. C & D');
      expect(primaries(result)).toEqual(['A', 'B']);
      expect(featuring(result)).toEqual(['C', 'D']);
    });

    it('handles parenthesized featuring with multiple artists', () => {
      const result = splitArtists('Major Lazer (feat. MØ & DJ Snake)');
      expect(primaries(result)).toEqual(['Major Lazer']);
      expect(featuring(result)).toEqual(['MØ', 'DJ Snake']);
    });
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
