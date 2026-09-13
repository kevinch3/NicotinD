import { describe, it, expect } from 'bun:test';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cacheControlForStatic, IMMUTABLE, REVALIDATE } from './static-cache.js';

describe('cacheControlForStatic', () => {
  it('never lets the shell or the worker control files be reused unrevalidated', () => {
    // These are the whole bug: a heuristically-cached copy of any of them pins
    // an installed PWA on an old build with no way to notice (#1126).
    for (const path of [
      '/',
      '/index.html',
      '/ngsw.json',
      '/ngsw-worker.js',
      '/safety-worker.js',
      '/manifest.webmanifest',
    ]) {
      expect(cacheControlForStatic(path)).toBe(REVALIDATE);
    }
  });

  it('pins content-hashed build output forever, in both hash alphabets', () => {
    // Upper-case base32 from the Angular builder, mixed case from esbuild's
    // chunks — the reason the rule anchors on the emitter prefix, not a shape.
    for (const path of [
      '/main-TUDTPOOO.js',
      '/styles-OKZLROGE.css',
      '/chunk-9yGxcBWO.js',
      '/chunk-B8oVmGNL2.js',
    ]) {
      expect(cacheControlForStatic(path)).toBe(IMMUTABLE);
    }
  });

  it('does not mistake an ordinary hyphenated name for a fingerprint', () => {
    // Each of these would be pinned for a year by a "dash then 8+ characters"
    // rule, and each keeps its name across deploys.
    for (const path of ['/worker-basic.min.js', '/safety-worker.js', '/some-component.js']) {
      expect(cacheControlForStatic(path)).toBe(REVALIDATE);
    }
  });

  it('revalidates the catalogs the app fetches at runtime', () => {
    expect(cacheControlForStatic('/i18n/en.json')).toBe(REVALIDATE);
    expect(cacheControlForStatic('/changelog.json')).toBe(REVALIDATE);
  });

  it('revalidates a deep link, which the catch-all answers with the shell', () => {
    expect(cacheControlForStatic('/library/albums/abc123')).toBe(REVALIDATE);
  });

  it('leaves the API and the docs to their own handlers', () => {
    for (const path of ['/api/health', '/api/stream/abc', '/doc', '/openapi.json']) {
      expect(cacheControlForStatic(path)).toBeNull();
    }
  });

  /**
   * The classification is only as good as its coverage of what the build
   * actually emits, and the two rules disagree in opposite directions — so
   * assert against a real `dist/` when one is present rather than against the
   * examples above, which were written by the same hand as the rule.
   *
   * Skipped rather than failed without a build: `bun run test` runs on a clean
   * checkout, and a gate that demands a 12-second build to say anything would
   * be turned off. The test prints its own denominator so a vacuous pass is
   * visible (quality-gates.md).
   */
  it('classifies every file a real build emits, when one is present', () => {
    const dist = resolve(import.meta.dir, '../../../web/dist');
    if (!existsSync(dist)) {
      console.log(
        'static-cache: no packages/web/dist — skipped (run `bun run --filter @nicotind/web build`)',
      );
      return;
    }
    const files = readdirSync(dist).filter((f) => /\.(js|mjs|css)$/.test(f));
    expect(files.length).toBeGreaterThan(0);

    const immutable = files.filter((f) => cacheControlForStatic(`/${f}`) === IMMUTABLE);
    const revalidate = files.filter((f) => cacheControlForStatic(`/${f}`) === REVALIDATE);
    console.log(
      `static-cache: ${files.length} built js/css — ${immutable.length} immutable, ` +
        `${revalidate.length} revalidate (${revalidate.join(', ') || 'none'})`,
    );

    // Every worker script keeps its name across deploys and must revalidate…
    expect(revalidate.sort()).toEqual(
      files.filter((f) => /^(ngsw-worker|safety-worker|worker-basic\.min)\.js$/.test(f)).sort(),
    );
    // …and everything else the build emits is fingerprinted.
    expect(immutable.length).toBe(files.length - revalidate.length);
  });
});
