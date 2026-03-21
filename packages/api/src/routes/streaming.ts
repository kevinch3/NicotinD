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

    const response = await navidrome.media.getCoverArt(id, size);

    return new Response(response.body, response);
  });

  return app;
}
