import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { nativeAppCors, NATIVE_APP_ORIGINS } from './cors.js';

function makeApp(): Hono {
  const app = new Hono();
  app.use('/api/*', nativeAppCors());
  // A streaming-like 206 handler to assert Range headers survive cross-origin.
  app.get('/api/stream/:id', (c) => {
    c.header('Content-Range', 'bytes 0-1/2');
    c.header('Accept-Ranges', 'bytes');
    return c.body('ab', 206);
  });
  return app;
}

describe('nativeAppCors', () => {
  const origin = NATIVE_APP_ORIGINS[0]; // https://localhost (Capacitor default)

  it('reflects an allowed native origin on a cross-origin GET', async () => {
    const res = await makeApp().request('/api/stream/1', { headers: { Origin: origin } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  });

  it('exposes the Range/length headers so cross-origin 206 seeking works', async () => {
    const res = await makeApp().request('/api/stream/1', { headers: { Origin: origin } });
    const exposed = res.headers.get('Access-Control-Expose-Headers') ?? '';
    expect(exposed).toContain('Content-Range');
    expect(exposed).toContain('Accept-Ranges');
    expect(exposed).toContain('Content-Length');
  });

  it('answers a preflight OPTIONS allowing Authorization + Range and the right methods', async () => {
    const res = await makeApp().request('/api/stream/1', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,range',
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    const allowHeaders = res.headers.get('Access-Control-Allow-Headers') ?? '';
    expect(allowHeaders).toContain('Authorization');
    expect(allowHeaders).toContain('Range');
    const allowMethods = res.headers.get('Access-Control-Allow-Methods') ?? '';
    expect(allowMethods).toContain('GET');
    expect(allowMethods).toContain('OPTIONS');
  });

  it("reflects the iOS WKWebView origin (capacitor://localhost) so iOS is covered", async () => {
    const iosOrigin = 'capacitor://localhost';
    expect(NATIVE_APP_ORIGINS).toContain(iosOrigin);
    const res = await makeApp().request('/api/stream/1', { headers: { Origin: iosOrigin } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(iosOrigin);
  });

  it('does not reflect a disallowed origin', async () => {
    const res = await makeApp().request('/api/stream/1', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example');
  });

  // Regression: the real /api/stream route returns `new Response(Bun.file(...), ...)`,
  // not a string body like the mock handler above. hono/cors's built-in Vary-append
  // (via c.header() after the route already returned a Response) rebuilds the
  // Response from res.body, turning a Blob body into a generic ReadableStream — Bun
  // then writes it chunked over the wire and drops Content-Length. Firefox's <audio>
  // can't complete a chunked, length-less 206 range read and gets stuck
  // stalling/re-buffering forever; Chrome tolerates it, which is why this only
  // showed up on Firefox. Hono's in-process `app.request()` doesn't reproduce this —
  // the header-dropping happens in Bun's real HTTP writer, so this test spins up an
  // actual server and fetches it over the wire.
  it('preserves Content-Length on a Blob-bodied 206 response (Firefox streaming regression)', async () => {
    const app = new Hono();
    app.use('/api/*', nativeAppCors());
    const bytes = new Uint8Array(2048);
    app.get('/api/stream/:id', () => {
      const blob = new Blob([bytes]);
      return new Response(blob.slice(0, 1024), {
        status: 206,
        headers: {
          'content-length': '1024',
          'content-range': 'bytes 0-1023/2048',
          'accept-ranges': 'bytes',
        },
      });
    });

    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const res = await fetch(`http://localhost:${server.port}/api/stream/1`, {
        headers: { Origin: origin },
      });
      await res.arrayBuffer();
      expect(res.headers.get('content-length')).toBe('1024');
      expect(res.headers.get('transfer-encoding')).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
