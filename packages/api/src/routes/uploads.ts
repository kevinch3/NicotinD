import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';

export function uploadRoutes(slskdRef: SlskdRef) {
  const app = new Hono<AuthEnv>();

  app.use('*', async (c, next) => {
    if (!slskdRef.current) {
      return c.json({ error: 'Soulseek is not configured — uploads unavailable' }, 503);
    }
    await next();
  });

  app.get('/', async (c) => {
    const uploads = await slskdRef.current!.transfers.getUploads();
    return c.json(uploads);
  });

  return app;
}
