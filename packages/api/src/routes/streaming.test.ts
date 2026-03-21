import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { streamingRoutes } from './streaming.js';

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

    const navidromeMock = {
      media: {
        stream,
        getCoverArt: mock(() => Promise.resolve(new Response('ok'))),
      },
    } as any;

    const app = new Hono();
    app.route('/', streamingRoutes(navidromeMock));

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
});
