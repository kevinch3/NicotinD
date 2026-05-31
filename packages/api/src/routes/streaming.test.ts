import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { streamingRoutes } from './streaming.js';

function makeNavidromeMock(overrides?: Partial<{ stream: ReturnType<typeof mock>; getCoverArt: ReturnType<typeof mock> }>) {
  return {
    media: {
      stream: overrides?.stream ?? mock(() => Promise.resolve(new Response('ok'))),
      getCoverArt: overrides?.getCoverArt ?? mock(() => Promise.resolve(new Response(new Uint8Array([0xff, 0xd8]), { headers: { 'content-type': 'image/jpeg' } }))),
    },
  } as unknown as Parameters<typeof streamingRoutes>[0];
}

describe('streaming routes', () => {
  it('forwards range headers and preserves partial-content response', async () => {
    const stream = mock((_id: string, _options: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('range')).toBe('bytes=0-1023');
      expect(headers.get('if-range')).toBe('"track-etag"');

      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: {
            'content-type': 'audio/mpeg',
            'content-range': 'bytes 0-2/3',
          },
        }),
      );
    });

    const app = new Hono();
    app.route('/', streamingRoutes(makeNavidromeMock({ stream })));

    const res = await app.request('/stream/song-1', {
      headers: {
        range: 'bytes=0-1023',
        'if-range': '"track-etag"',
      },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-2/3');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('proxies cover art when navidrome returns an image', async () => {
    const imgBytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const getCoverArt = mock(() =>
      Promise.resolve(new Response(imgBytes, { headers: { 'content-type': 'image/jpeg' } })),
    );

    const app = new Hono();
    app.route('/', streamingRoutes(makeNavidromeMock({ getCoverArt })));

    const res = await app.request('/cover/al-123?size=300');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(getCoverArt).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when navidrome returns XML (Subsonic error) instead of image', async () => {
    const getCoverArt = mock(() =>
      Promise.resolve(new Response('<error/>', { headers: { 'content-type': 'application/xml' } })),
    );

    const app = new Hono();
    app.route('/', streamingRoutes(makeNavidromeMock({ getCoverArt })));

    const res = await app.request('/cover/al-missing');

    expect(res.status).toBe(404);
  });

  it('returns 404 when navidrome getCoverArt throws', async () => {
    const getCoverArt = mock(() => Promise.reject(new Error('navidrome unreachable')));

    const app = new Hono();
    app.route('/', streamingRoutes(makeNavidromeMock({ getCoverArt })));

    const res = await app.request('/cover/al-broken');

    expect(res.status).toBe(404);
  });
});
