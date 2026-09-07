import { describe, expect, it } from 'bun:test';
import { mapDiscogsGenres, DISCOGS_TOP_LEVEL_GENRES } from './discogs-genre-vocab.js';

describe('mapDiscogsGenres', () => {
  it('splits the comma-bearing "Folk, World, & Country" without leaking fragments', () => {
    const out = mapDiscogsGenres(['Folk, World, & Country']);
    expect(out).toEqual(['Folk', 'World', 'Country']);
    // The whole point: no "& Country" / bare-comma fragment ever escapes.
    expect(out.some((g) => g.includes(',') || g.startsWith('&'))).toBe(false);
  });

  it('splits "Funk / Soul" deterministically regardless of the known-set', () => {
    expect(mapDiscogsGenres(['Funk / Soul'])).toEqual(['Funk', 'Soul']);
  });

  it('canonicalizes "Hip Hop" to the library spelling "Hip-Hop"', () => {
    expect(mapDiscogsGenres(['Hip Hop'])).toEqual(['Hip-Hop']);
  });

  it('drops "Non-Music" (not a musical genre)', () => {
    expect(mapDiscogsGenres(['Non-Music'])).toEqual([]);
  });

  it('passes coarse single-word genres through unchanged', () => {
    expect(mapDiscogsGenres(['Rock', 'Latin', 'Jazz', 'Reggae', 'Pop'])).toEqual([
      'Rock',
      'Latin',
      'Jazz',
      'Reggae',
      'Pop',
    ]);
  });

  it('de-duplicates while preserving first-seen order', () => {
    expect(mapDiscogsGenres(['Rock', 'Funk / Soul', 'Rock', 'Funk'])).toEqual([
      'Rock',
      'Funk',
      'Soul',
    ]);
  });

  it('maps the real spike sample (Los Tetas) with no comma/slash fragments', () => {
    const out = mapDiscogsGenres(['Hip Hop', 'Jazz', 'Rock', 'Reggae', 'Latin', 'Funk / Soul']);
    expect(out).toEqual(['Hip-Hop', 'Jazz', 'Rock', 'Reggae', 'Latin', 'Funk', 'Soul']);
    expect(out.some((g) => /[,/|;]/.test(g))).toBe(false);
  });

  it('never emits a hard-separator character for ANY top-level genre (anti-shatter invariant)', () => {
    for (const g of DISCOGS_TOP_LEVEL_GENRES) {
      for (const mapped of mapDiscogsGenres([g])) {
        expect(/[,;|/]/.test(mapped)).toBe(false);
      }
    }
  });

  it('ignores empty/whitespace entries', () => {
    expect(mapDiscogsGenres(['', '   ', 'Rock'])).toEqual(['Rock']);
  });
});

/**
 * Issue #941: `mapDiscogsGenres` had exactly one non-test caller — the Discogs
 * plugin — while the `genre-audio` enrichment task consumes the SAME closed
 * vocabulary from the analysis sidecar (`genre_discogs400_labels.json`: 400
 * classes over 15 distinct genre halves, byte-identical to
 * DISCOGS_TOP_LEVEL_GENRES) and wrote the raw label straight through.
 *
 * These assert the four labels that are wrong without the mapping, so the second
 * door cannot silently reopen.
 */
describe('the sidecar vocabulary needs the same mapping as the plugin (issue #941)', () => {
  it('never emits a value the scanner would re-split', () => {
    // Stored ';'-encoded and ';'-decoded, then shattered by the file-tag mirror
    // on the next scan into Folk / World / "& Country".
    expect(mapDiscogsGenres(['Folk, World, & Country'])).toEqual(['Folk', 'World', 'Country']);
    // A '/' additionally excludes the value from the known vocabulary entirely.
    expect(mapDiscogsGenres(['Funk / Soul'])).toEqual(['Funk', 'Soul']);
  });

  it("folds a label that would coexist with the library's own spelling", () => {
    expect(mapDiscogsGenres(['Hip Hop'])).toEqual(['Hip-Hop']);
  });

  it('drops a label that is not a genre, leaving nothing to write', () => {
    expect(mapDiscogsGenres(['Non-Music'])).toEqual([]);
  });
});
