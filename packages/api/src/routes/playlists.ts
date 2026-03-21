import { Hono } from 'hono';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';

export function playlistRoutes(navidrome: Navidrome) {
  const app = new Hono<AuthEnv>();

  // List all playlists
  app.get('/', async (c) => {
    const playlists = await navidrome.playlists.list();
    return c.json(playlists);
  });

  // Get playlist with tracks
  app.get('/:id', async (c) => {
    const playlist = await navidrome.playlists.get(c.req.param('id'));
    return c.json(playlist);
  });

  // Create a playlist
  app.post('/', async (c) => {
    const { name, songIds } = await c.req.json<{
      name: string;
      songIds?: string[];
    }>();

    if (!name) {
      return c.json({ error: 'name is required' }, 400);
    }

    const playlist = await navidrome.playlists.create(name, songIds);
    return c.json(playlist, 201);
  });

  // Update a playlist
  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    const updates = await c.req.json<{
      name?: string;
      songIdsToAdd?: string[];
      songIndexesToRemove?: number[];
    }>();

    await navidrome.playlists.update(id, updates);
    return c.json({ ok: true });
  });

  // Delete a playlist
  app.delete('/:id', async (c) => {
    await navidrome.playlists.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}
