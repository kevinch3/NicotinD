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

  it('does not reflect a disallowed origin', async () => {
    const res = await makeApp().request('/api/stream/1', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example');
  });
});
