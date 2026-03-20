import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';

export function downloadRoutes(slskdRef: SlskdRef) {
  const app = new Hono<AuthEnv>();

  // Guard: if slskd is not configured, all download routes return 503
  app.use('*', async (c, next) => {
    if (!slskdRef.current) {
      return c.json({ error: 'Soulseek is not configured — downloads unavailable' }, 503);
    }
    await next();
  });

  // Enqueue downloads
  app.post('/', async (c) => {
    const { username, files } = await c.req.json<{
      username: string;
      files: Array<{ filename: string; size: number }>;
    }>();

    if (!username || !files?.length) {
      return c.json({ error: 'username and files are required' }, 400);
    }

    await slskdRef.current!.transfers.enqueue(username, files);
    return c.json({ ok: true, queued: files.length }, 201);
  });

  // List all downloads
  app.get('/', async (c) => {
    const downloads = await slskdRef.current!.transfers.getDownloads();
    return c.json(downloads);
  });

  // Cancel a download
  app.delete('/:username/:id', async (c) => {
    const username = c.req.param('username');
    const id = c.req.param('id');
    await slskdRef.current!.transfers.cancel(username, id);
    return c.json({ ok: true });
  });

  // Cancel all downloads
  app.delete('/', async (c) => {
    await slskdRef.current!.transfers.cancelAll();
    return c.json({ ok: true });
  });

  return app;
}
