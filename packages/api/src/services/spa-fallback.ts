/**
 * Whether an unmatched request should get the SPA shell (`index.html`).
 *
 * The catch-all used to answer *every* unmatched path with `index.html` and a
 * 200 — including missing `.js` chunks (#925). A client holding a pre-deploy
 * build then asked for a chunk that no longer existed, got HTML with a success
 * status, and failed parsing it as an ES module. The error it surfaced —
 * "error loading dynamically imported module" — points at the bundler rather
 * than at the truth, which is that the asset is gone and the build is stale.
 *
 * A missing asset must 404. That is correct, diagnosable, and the only answer a
 * client can act on.
 */

/**
 * Extensions the web build emits. Matched against an explicit list rather than
 * "the last segment contains a dot", because route segments legitimately do:
 * an artist `R.E.M.`, an album `Vol. 2`. Judging those as assets would 404 real
 * deep links.
 */
const ASSET_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.map',
  '.json',
  '.wasm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.avif',
  '.ico',
  '.mp3',
  '.ogg',
  '.webmanifest',
  '.txt',
  '.xml',
]);

function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export function shouldServeSpaIndex(path: string, accept: string | undefined): boolean {
  // An asset request is never a navigation, whatever it claims to accept.
  if (ASSET_EXTENSIONS.has(extensionOf(path))) {
    // …unless the client explicitly asked for a document, which only a real
    // navigation does. Covers a router path that genuinely ends in an
    // asset-looking segment.
    return (accept ?? '').includes('text/html');
  }
  return true;
}
