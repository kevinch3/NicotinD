import { Hono } from 'hono';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';

export function streamingRoutes(navidrome: Navidrome) {
  const app = new Hono<AuthEnv>();

  app.get('/stream/:id', async (c) => {
    const id = c.req.param('id');
    const maxBitRate = c.req.query('maxBitRate') ? Number(c.req.query('maxBitRate')) : undefined;
    const format = c.req.query('format') ?? undefined;
    const requestHeaders = new Headers();
    let hasForwardedHeaders = false;
    const range = c.req.header('range');
    const ifRange = c.req.header('if-range');

    if (range) {
      requestHeaders.set('range', range);
      hasForwardedHeaders = true;
    }
    if (ifRange) {
      requestHeaders.set('if-range', ifRange);
      hasForwardedHeaders = true;
    }

    const response = await navidrome.media.stream(
      id,
      { maxBitRate, format },
      hasForwardedHeaders ? { headers: requestHeaders } : undefined,
    );

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });

  app.get('/cover/:id', async (c) => {
    const id = c.req.param('id');
    const size = c.req.query('size') ? Number(c.req.query('size')) : undefined;

    let response: Response;
    try {
      response = await navidrome.media.getCoverArt(id, size);
    } catch {
      return c.body(null, 404);
    }

    // Subsonic returns HTTP 200 with XML body on errors (e.g. art not found).
    // Forwarding XML where the browser expects an image causes NS_ERROR_INVALID_CONTENT.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      await response.body?.cancel();
      return c.body(null, 404);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });

  return app;
}
