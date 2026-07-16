import { BrowserWindow, shell } from 'electron';

/**
 * Hostnames considered "loopback" for navigation/CSP purposes. The desktop
 * shell only ever talks to the Bun sidecar it spawns itself (Task 9) on
 * 127.0.0.1, but we also allow `localhost`/`::1` since Node/Electron can
 * resolve either depending on platform DNS settings.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return LOOPBACK_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Content-Security-Policy applied to every response the window's session
 * loads. Locked to `'self'` (the loopback origin the app is served from)
 * plus explicit loopback http/ws variants for `connect-src`/`media-src`
 * (audio streaming + the playback websocket both hit the same sidecar).
 * `'unsafe-inline'` is kept for styles/scripts because the Angular
 * production build (esbuild) emits inline critical CSS and a small inline
 * bootstrap script; nothing here reaches outside the loopback origin.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:*",
  "media-src 'self' http://127.0.0.1:* http://localhost:* blob:",
].join('; ');

/**
 * Applies renderer-hardening behavior to `win`:
 *  - popups/`window.open` never open in-app; http(s) targets are handed to
 *    the OS browser via `shell.openExternal`, everything else is dropped.
 *  - in-page navigation (`will-navigate`, e.g. a link click or
 *    `location.href` in the renderer) is restricted to loopback origins so
 *    a compromised/malicious page can't drag the window to a remote host.
 *  - a strict CSP is attached to the window's session so responses loaded
 *    into it can only fetch/stream from the local sidecar.
 */
export function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isLoopbackUrl(url)) {
      event.preventDefault();
    }
  });

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });
}
