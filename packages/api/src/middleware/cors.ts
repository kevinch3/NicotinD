import { cors } from 'hono/cors';

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

/**
 * CORS for the native (Capacitor) app, which runs from a localhost WebView
 * origin and calls this server cross-origin. Auth is a Bearer token (no
 * cookies), so a fixed origin allowlist suffices. `Range` is allowed and the
 * 206-streaming response headers are exposed so cross-origin seeking works; the
 * web UI is same-origin and unaffected. Mount before auth so preflight OPTIONS
 * (which carry no Authorization header) are answered.
 */
export function nativeAppCors() {
  return cors({
    origin: NATIVE_APP_ORIGINS,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Range', 'Accept'],
    exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
    maxAge: 86400,
  });
}
