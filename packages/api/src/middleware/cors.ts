import { createMiddleware } from 'hono/factory';

// Origins the native (Capacitor) shell can present, on both Android and iOS.
// Modern Capacitor serves the bundled web app from `https://localhost` (the
// default Android `androidScheme`); iOS WKWebView serves it from
// `capacitor://localhost`; `http://localhost` covers older/alternate scheme
// configs. The web UI is served same-origin and never needs to appear here.
export const NATIVE_APP_ORIGINS = [
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
];

const ALLOW_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const ALLOW_HEADERS = ['Authorization', 'Content-Type', 'Range', 'Accept'];
const EXPOSE_HEADERS = ['Content-Range', 'Accept-Ranges', 'Content-Length'];
const MAX_AGE_SECONDS = 86400;

/**
 * CORS for the native (Capacitor) app, which runs from a localhost WebView
 * origin and calls this server cross-origin. Auth is a Bearer token (no
 * cookies), so a fixed origin allowlist suffices. `Range` is allowed and the
 * 206-streaming response headers are exposed so cross-origin seeking works; the
 * web UI is same-origin and unaffected. Mount before auth so preflight OPTIONS
 * (which carry no Authorization header) are answered.
 *
 * Hand-rolled instead of `hono/cors`: that middleware appends its post-request
 * `Vary: Origin` header via `c.header()`, which — once the route has already
 * returned a Response (i.e. after `next()`) — rebuilds the Response from
 * `res.body`. For a `Bun.file()`-backed body (every `/api/stream` response)
 * reading `.body` converts the Blob into a generic `ReadableStream`, and Bun
 * writes an unknown-length stream as `Transfer-Encoding: chunked`, silently
 * dropping the `Content-Length` header the route set. Chrome's <audio> element
 * tolerates a chunked 206 range response; Firefox's does not — it gets stuck
 * re-requesting/stalling forever, which surfaces as playback that never
 * progresses past the loading spinner. Mutating `c.res.headers` directly here
 * (never calling `c.header()` after `next()`) sidesteps that rebuild, so the
 * streaming route's Blob body — and its real Content-Length — reaches Bun
 * untouched. See docs/web-ui.md "Playback loading feedback".
 */
export function nativeAppCors() {
  return createMiddleware(async (c, next) => {
    const origin = c.req.header('origin') ?? '';
    const allowOrigin = NATIVE_APP_ORIGINS.includes(origin) ? origin : null;

    if (c.req.method === 'OPTIONS') {
      const headers = new Headers();
      if (allowOrigin) headers.set('Access-Control-Allow-Origin', allowOrigin);
      headers.append('Vary', 'Origin');
      headers.set('Access-Control-Max-Age', String(MAX_AGE_SECONDS));
      headers.set('Access-Control-Allow-Methods', ALLOW_METHODS.join(','));
      headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS.join(','));
      headers.append('Vary', 'Access-Control-Request-Headers');
      return new Response(null, { status: 204, statusText: 'No Content', headers });
    }

    await next();

    if (allowOrigin) c.res.headers.set('Access-Control-Allow-Origin', allowOrigin);
    c.res.headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS.join(','));
    c.res.headers.append('Vary', 'Origin');
  });
}
