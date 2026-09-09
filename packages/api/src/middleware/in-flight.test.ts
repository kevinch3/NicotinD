import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { inFlightRequests, resetInFlight, trackInFlight } from './in-flight.js';

afterEach(() => resetInFlight());

function appWith(handler: (seen: string[]) => void) {
  const app = new Hono();
  app.use('*', trackInFlight());
  app.get('/api/library/artists', (c) => {
    handler(inFlightRequests());
    return c.json([]);
  });
  return app;
}

describe('trackInFlight', () => {
  it('exposes the request while its handler runs, and drops it after', async () => {
    let seen: string[] = [];
    const app = appWith((s) => (seen = s));
    await app.request('/api/library/artists?country=CL,AR&genre=Rock');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toStartWith('GET /api/library/artists?country&genre');
    expect(inFlightRequests()).toEqual([]);
  });

  it('records param NAMES only — a filter value is library content, not a log line', async () => {
    let seen: string[] = [];
    const app = appWith((s) => (seen = s));
    await app.request('/api/library/artists?q=Some%20Private%20Artist');
    expect(seen[0]).toContain('?q');
    expect(seen[0]).not.toContain('Private');
  });

  it('drops the entry even when the handler throws', async () => {
    const app = new Hono();
    app.use('*', trackInFlight());
    app.get('/boom', () => {
      throw new Error('nope');
    });
    app.onError((_e, c) => c.json({ error: 'x' }, 500));
    await app.request('/boom');
    expect(inFlightRequests()).toEqual([]);
  });

  it('orders concurrent requests longest-running first', async () => {
    const app = new Hono();
    app.use('*', trackInFlight());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let seen: string[] = [];
    app.get('/slow', async (c) => {
      await gate;
      return c.json({});
    });
    app.get('/fast', (c) => {
      seen = inFlightRequests();
      return c.json({});
    });
    const slow = app.request('/slow');
    await app.request('/fast');
    release();
    await slow;
    expect(seen.map((s) => s.split(' ')[1])).toEqual(['/slow', '/fast']);
  });
});
