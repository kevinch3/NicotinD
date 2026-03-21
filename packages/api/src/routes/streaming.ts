import { Hono } from 'hono';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';

export function streamingRoutes(navidrome: Navidrome) {
  const app = new Hono<AuthEnv>();

  app.get('/stream/:id', async (c) => {
    const id = c.req.param('id');
    const maxBitRate = c.req.query('maxBitRate') ? Number(c.req.query('maxBitRate')) : undefined;
    const format = c.req.query('format') ?? undefined;

    const response = await navidrome.media.stream(id, { maxBitRate, format });

    return new Response(response.body, response);
  });

  app.get('/cover/:id', async (c) => {
    const id = c.req.param('id');
    const size = c.req.query('size') ? Number(c.req.query('size')) : undefined;

    const response = await navidrome.media.getCoverArt(id, size);

    return new Response(response.body, response);
  });

  return app;
}
