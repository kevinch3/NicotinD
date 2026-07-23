import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import { PlaylistService } from '../services/playlist.service.js';

/**
 * Native per-user playlists. Every handler scopes to the authenticated user
 * (`c.var.user.sub`) so playlists are private to their owner.
 */
export function playlistRoutes() {
  const app = new Hono<AuthEnv>();
  const svc = () => new PlaylistService(getDatabase());

  app.get('/', (c) => c.json({ playlists: svc().list(c.var.user.sub) }));

  app.get('/:id', (c) => {
    const detail = svc().get(c.var.user.sub, c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'Not found' }, 404);
  });

  // Cheap token-overlap suggestions for what to add next (see
  // PlaylistService.proposals for the empty-vs-non-empty token-source rule).
  app.get('/:id/proposals', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 20), 50);
    const proposals = svc().proposals(c.var.user.sub, c.req.param('id'), limit);
    return proposals ? c.json(proposals) : c.json({ error: 'Not found' }, 404);
  });

  app.post('/', async (c) => {
    type Body = { name?: string; description?: string; songIds?: string[] };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    if (!body.name || !body.name.trim()) {
      return c.json({ error: 'name is required' }, 400);
    }
    const playlist = svc().create(c.var.user.sub, {
      name: body.name,
      description: body.description,
      songIds: body.songIds,
    });
    return c.json({ playlist }, 201);
  });

  app.put('/:id', async (c) => {
    type Body = {
      name?: string;
      description?: string;
      add?: string[];
      remove?: string[];
      reorder?: string[];
    };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const ok = svc().update(c.var.user.sub, c.req.param('id'), body);
    return ok ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  app.delete('/:id', (c) => {
    const ok = svc().remove(c.var.user.sub, c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  return app;
}
