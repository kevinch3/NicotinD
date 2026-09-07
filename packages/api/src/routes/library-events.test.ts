import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createLibraryEvents } from '../services/library-events.js';
import { libraryEventRoutes } from './library-events.js';

async function readFor(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);
    if (race.done) break;
    out += decoder.decode(race.value);
  }
  await reader.cancel().catch(() => {});
  return out;
}

function appWith(bus = createLibraryEvents({ coalesceMs: 1 })) {
  const app = new Hono();
  app.route('/library/events', libraryEventRoutes(bus, 60_000));
  return { app, bus };
}

describe('GET /library/events', () => {
  it('greets with the current seq, then streams live events with ids', async () => {
    const { app, bus } = appWith();
    const res = await app.request('/library/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    bus.emit({ type: 'album.changed', albumId: 'alb' });
    const text = await readFor(res, 150);
    expect(text).toContain('event: hello');
    expect(text).toContain('retry: 3000');
    expect(text).toContain('id: 1');
    expect(text).toContain('event: library');
    expect(text).toContain('"albumId":"alb"');
  });

  it('replays everything after Last-Event-ID', async () => {
    const { app, bus } = appWith();
    for (const id of ['a', 'b', 'c']) {
      bus.emit({ type: 'job.changed', jobId: id });
      bus.flush();
    }
    const res = await app.request('/library/events', { headers: { 'last-event-id': '1' } });
    const text = await readFor(res, 100);
    expect(text).not.toContain('"jobId":"a"');
    expect(text).toContain('"jobId":"b"');
    expect(text).toContain('"jobId":"c"');
    expect(text).not.toContain('event: resync');
  });

  it('asks the client to resync when the requested seq fell out of the buffer', async () => {
    const { app, bus } = appWith();
    for (let i = 0; i < 505; i++) {
      bus.emit({ type: 'job.changed', jobId: `j${i}` });
      bus.flush();
    }
    const res = await app.request('/library/events?since=1');
    const text = await readFor(res, 100);
    expect(text).toContain('event: resync');
  });
});
