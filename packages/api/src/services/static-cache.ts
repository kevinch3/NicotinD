/**
 * `Cache-Control` for the static web build.
 *
 * Hono's `serveStatic` sets `Content-Type` and nothing else — no
 * `Cache-Control`, no `ETag`, no `Last-Modified`. A response with no freshness
 * information is eligible for *heuristic* caching, and the three files that
 * must never be served stale are exactly the ones the catch-all answers with:
 * `index.html`, `ngsw.json` and `ngsw-worker.js`. A browser holding a
 * heuristically-cached shell keeps a PWA on an old build with no way to notice,
 * which is what "the PWA never updates on Safari" looked like from the couch
 * (#1126).
 *
 * Two answers. A filename carrying a content hash names exactly one byte
 * sequence forever, so it is `immutable`; everything else is `no-cache`, which
 * does not mean "don't cache" — it means "revalidate before reuse", so a 304
 * still costs nothing when nothing changed.
 */

/**
 * Files whose *name* is stable across deploys while their content is not.
 * These may never be reused without asking, whatever a heuristic would allow.
 */
const ALWAYS_REVALIDATE = new Set([
  '/',
  '/index.html',
  '/ngsw.json',
  '/ngsw-worker.js',
  '/safety-worker.js',
  '/worker-basic.min.js',
  '/manifest.webmanifest',
]);

/**
 * A content-hashed file, matched by **the emitter's own naming** rather than by
 * "looks hashy".
 *
 * The two halves of the build do not share a hash alphabet — `main-TUDTPOOO.js`
 * and `styles-OKZLROGE.css` are upper-case base32, while esbuild's chunks are
 * mixed case (`chunk-9yGxcBWO.js`) — so a single character-class pattern either
 * misses the chunks or widens far enough to swallow an ordinary hyphenated
 * name. Anchoring on the prefixes the build actually emits avoids guessing.
 *
 * Its failure mode is deliberately one-sided: an emitter this list does not
 * know costs one revalidation round-trip, while a wrong `immutable` pins a
 * stale asset for a year with no way to bust it — the exact class of bug this
 * module exists to stop.
 */
const HASHED_ASSET = /^(?:main|styles|polyfills|scripts|chunk)-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css)$/;

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';

/**
 * The `Cache-Control` value for a static path, or `null` when the request is
 * not ours to answer for (the API, the docs) and must keep whatever its own
 * handler set.
 */
export function cacheControlForStatic(path: string): string | null {
  if (path.startsWith('/api/') || path === '/doc' || path === '/openapi.json') return null;
  if (ALWAYS_REVALIDATE.has(path)) return REVALIDATE;
  if (HASHED_ASSET.test(path.slice(path.lastIndexOf('/') + 1))) return IMMUTABLE;
  // Everything else — an un-hashed asset, a runtime-fetched JSON catalog, or a
  // deep link that will be answered with the shell — revalidates. Correctness
  // over a round trip: the service worker is what makes repeat visits cheap,
  // and it caches by manifest hash rather than by HTTP freshness.
  return REVALIDATE;
}
