import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AuthEnv } from '../middleware/auth.js';
import {
  libraryEvents,
  type LibraryEvents,
  type StampedEvent,
} from '../services/library-events.js';

/** Keep-alive cadence: under nginx's default 60 s `proxy_read_timeout` on the edge. */
export const PING_MS = 25_000;

/**
 * `GET /api/library/events` — server-sent events for library mutations, so an
 * open client learns about landed, deleted and changed songs, albums, artwork
 * and jobs without polling. See docs/cache-invalidation.md "Live invalidation".
 *
 * Reconnects replay: the client sends `Last-Event-ID` (or `?since=`) and gets
 * everything after that seq. A seq older than the buffer is a gap; the stream
 * then sends one `resync` event and the client drops its caches wholesale.
 */
export function libraryEventRoutes(bus: LibraryEvents = libraryEvents, pingMs = PING_MS) {
  const app = new Hono<AuthEnv>();

  app.get('/', (c) => {
    const raw = c.req.header('last-event-id') ?? c.req.query('since');
    const since = raw !== undefined && raw !== '' ? Number(raw) : null;
    c.header('Cache-Control', 'no-cache');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const send = (e: StampedEvent) =>
        void stream
          .writeSSE({ id: String(e.seq), event: 'library', data: JSON.stringify(e) })
          .catch(() => {});
      await stream
        .writeSSE({ retry: 3000, event: 'hello', data: JSON.stringify({ seq: bus.lastSeq() }) })
        .catch(() => {});
      if (since !== null && Number.isFinite(since)) {
        const missed = bus.since(since);
        if (missed === null) {
          await stream.writeSSE({ event: 'resync', data: '{}' }).catch(() => {});
        } else {
          for (const e of missed) send(e);
        }
      }
      const off = bus.on(send);
      const ping = setInterval(() => void stream.write(': ping\n\n').catch(() => {}), pingMs);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          off();
          clearInterval(ping);
          resolve();
        });
      });
    });
  });

  return app;
}
