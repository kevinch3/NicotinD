import { describe, expect, it } from 'bun:test';
import { shouldServeSpaIndex } from './spa-fallback.js';

const NAV = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const SCRIPT = '*/*';

describe('shouldServeSpaIndex', () => {
  it('serves the shell for a deep link the router owns', () => {
    expect(shouldServeSpaIndex('/library/albums/abc', NAV)).toBe(true);
    expect(shouldServeSpaIndex('/get', NAV)).toBe(true);
    expect(shouldServeSpaIndex('/', NAV)).toBe(true);
  });

  /**
   * The bug (#925). A client holding a pre-deploy build asks for a chunk that no
   * longer exists. Answering with index.html and a 200 means the browser parses
   * HTML as an ES module and reports "error loading dynamically imported
   * module" — an error that points at the bundler instead of at the truth,
   * which is that the asset is gone. A 404 is both correct and diagnosable.
   */
  it('refuses to answer a missing script with the HTML shell', () => {
    expect(shouldServeSpaIndex('/chunk-CXIY4XhS.js', SCRIPT)).toBe(false);
    expect(shouldServeSpaIndex('/main-HNDLC4J6.js', SCRIPT)).toBe(false);
  });

  it('refuses for every static asset kind, not just scripts', () => {
    for (const p of [
      '/styles-ABC.css',
      '/main.js.map',
      '/fonts/inter.woff2',
      '/media/cover.webp',
      '/ngsw.json',
    ]) {
      expect(shouldServeSpaIndex(p, SCRIPT), p).toBe(false);
    }
  });

  // A route segment can legitimately contain a dot — an album titled "Vol. 2",
  // an artist called "R.E.M." — so extension matching must be anchored to a
  // known asset list, never "contains a dot".
  it('still serves the shell for a route whose last segment has a dot', () => {
    expect(shouldServeSpaIndex('/library/artists/R.E.M.', NAV)).toBe(true);
    expect(shouldServeSpaIndex('/search/Vol. 2', NAV)).toBe(true);
  });

  // Belt and braces: a navigation request always wins, because a real router
  // path could end in anything and the browser tells us what it wants.
  it('serves the shell when the client explicitly asks for HTML', () => {
    expect(shouldServeSpaIndex('/library/weird.js', NAV)).toBe(true);
  });

  it('serves the shell when Accept is absent (curl, crawlers)', () => {
    expect(shouldServeSpaIndex('/library', undefined)).toBe(true);
    // …but an obvious asset is still refused, so a missing header cannot
    // resurrect the bug.
    expect(shouldServeSpaIndex('/chunk-abc.js', undefined)).toBe(false);
  });
});
