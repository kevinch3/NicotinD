/**
 * `idleTimeout` against a real `Bun.serve` (issue #644): the library-events SSE
 * must outlive it on pings alone, and `idleBudget` must lift it per request.
 * Scaled down (8 s / 4 s) because Bun's idle timer ticks every 4 s.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import {
  IDLE_TIMER_GRANULARITY_S,
  LONG_REQUEST_IDLE_S,
  SERVER_IDLE_TIMEOUT_S,
  applyIdleBudgets,
  idleBudget,
} from './idle-budget.js';
import { PING_MS, libraryEventRoutes } from '../routes/library-events.js';
import { createLibraryEvents } from '../services/library-events.js';

/** Read the stream for `holdMs`; resolves with how long it stayed open. */
async function holdOpen(url: string, holdMs: number): Promise<{ openMs: number; chunks: number }> {
  const t0 = Date.now();
  let chunks = 0;
  try {
    const res = await fetch(url, { keepalive: false });
    const reader = res.body!.getReader();
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), holdMs);
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      chunks++;
    }
    clearTimeout(timer);
  } catch {
    /* socket closed by the server */
  }
  return { openMs: Date.now() - t0, chunks };
}

async function status(url: string): Promise<number | 'closed'> {
  try {
    return (await fetch(url, { keepalive: false })).status;
  } catch {
    return 'closed';
  }
}

describe('server idle timeout', () => {
  it('leaves the SSE ping more than one idle-timer tick of headroom', () => {
    expect(PING_MS / 1000 + IDLE_TIMER_GRANULARITY_S).toBeLessThanOrEqual(SERVER_IDLE_TIMEOUT_S);
  });

  it('keeps a pinged SSE stream open past idleTimeout, closes an unpinged one, and idleBudget lifts a slow handler', async () => {
    const bus = createLibraryEvents();
    const app = new Hono<AuthEnv>();
    app.route('/pinged', libraryEventRoutes(bus, 2_000));
    app.route('/quiet', libraryEventRoutes(bus, 60_000));
    const slow = async () => {
      await Bun.sleep(7_000);
      return new Response('ok');
    };
    app.get('/slow', slow);
    app.get('/slow-budgeted', idleBudget(16), slow);

    const server = Bun.serve({ port: 0, idleTimeout: 8, fetch: app.fetch });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const [pinged, quiet, plain, budgeted] = await Promise.all([
        holdOpen(`${base}/pinged`, 10_000),
        holdOpen(`${base}/quiet`, 10_000),
        (async () => {
          const s2 = Bun.serve({ port: 0, idleTimeout: 4, fetch: app.fetch });
          try {
            return await status(`http://127.0.0.1:${s2.port}/slow`);
          } finally {
            s2.stop(true);
          }
        })(),
        (async () => {
          const s3 = Bun.serve({ port: 0, idleTimeout: 4, fetch: app.fetch });
          try {
            return await status(`http://127.0.0.1:${s3.port}/slow-budgeted`);
          } finally {
            s3.stop(true);
          }
        })(),
      ]);
      expect(pinged.openMs).toBeGreaterThanOrEqual(9_900);
      expect(pinged.chunks).toBeGreaterThanOrEqual(4);
      expect(quiet.openMs).toBeLessThan(9_900);
      expect(plain).toBe('closed');
      expect(budgeted).toBe(200);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});

describe('applyIdleBudgets', () => {
  async function budgetFor(method: string, path: string): Promise<number | null> {
    const app = new Hono();
    applyIdleBudgets(app);
    app.all('*', (c) => c.text('ok'));
    let seconds: number | null = null;
    const env = { timeout: (_req: Request, s: number) => (seconds = s) };
    await app.request(path, { method }, env);
    return seconds;
  }

  it('gives the long-running groups the old 60 s', async () => {
    expect(await budgetFor('POST', '/api/discography/albums/1/hunt')).toBe(LONG_REQUEST_IDLE_S);
    expect(await budgetFor('POST', '/api/mcp')).toBe(LONG_REQUEST_IDLE_S);
    expect(await budgetFor('GET', '/api/stream/abc')).toBe(LONG_REQUEST_IDLE_S);
    expect(await budgetFor('POST', '/api/library/albums/1/complete')).toBe(LONG_REQUEST_IDLE_S);
  });

  it('leaves library GETs (the pinged events SSE) and other groups on the global', async () => {
    expect(await budgetFor('GET', '/api/library/events')).toBeNull();
    expect(await budgetFor('POST', '/api/catalog/resolve')).toBeNull();
    expect(await budgetFor('GET', '/api/search')).toBeNull();
  });
});
