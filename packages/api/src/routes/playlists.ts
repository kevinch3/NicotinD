import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';

type VisibilityRow = { playlist_id: string; owner_id: string; visibility: string };

function getRow(db: Database, playlistId: string): VisibilityRow | null {
  return db
    .query<VisibilityRow, [string]>('SELECT * FROM playlist_visibility WHERE playlist_id = ?')
    .get(playlistId);
}

function canAccess(row: VisibilityRow | null, userId: string, role?: string): boolean {
  if (!row) return true; // legacy — treat as global
  if (row.visibility === 'global') return true;
  return row.owner_id === userId || role === 'admin';
}

function isOwnerOrAdmin(row: VisibilityRow | null, userId: string, role?: string): boolean {
  if (!row) return role === 'admin'; // legacy — only admin can manage
  return row.owner_id === userId || role === 'admin';
}

export function playlistRoutes(navidrome: Navidrome, db: Database) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    const user = c.var.user;
    const playlists = await navidrome.playlists.list();
    const visible = playlists.filter((p) => canAccess(getRow(db, p.id), user.sub, user.role));
    return c.json(visible);
  });

  app.get('/:id', async (c) => {
    const user = c.var.user;
    const id = c.req.param('id');
    const playlist = await navidrome.playlists.get(id);
    if (!canAccess(getRow(db, id), user.sub, user.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return c.json(playlist);
  });

  app.post('/', async (c) => {
    const user = c.var.user;
    const { name, songIds, visibility } = await c.req.json<{
      name: string;
      songIds?: string[];
      visibility?: 'personal' | 'global';
    }>();

    if (!name) {
      return c.json({ error: 'name is required' }, 400);
    }

    const playlist = await navidrome.playlists.create(name, songIds);
    db.run(
      'INSERT INTO playlist_visibility (playlist_id, owner_id, visibility) VALUES (?, ?, ?)',
      [playlist.id, user.sub, visibility === 'global' ? 'global' : 'personal'],
    );
    return c.json(playlist, 201);
  });

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

  app.patch('/:id/visibility', async (c) => {
    const user = c.var.user;
    const id = c.req.param('id');
    const { visibility } = await c.req.json<{ visibility: string }>();

    if (visibility !== 'personal' && visibility !== 'global') {
      return c.json({ error: 'visibility must be "personal" or "global"' }, 400);
    }

    const row = getRow(db, id);
    if (!isOwnerOrAdmin(row, user.sub, user.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    db.run(
      'INSERT OR REPLACE INTO playlist_visibility (playlist_id, owner_id, visibility) VALUES (?, ?, ?)',
      [id, row?.owner_id ?? user.sub, visibility],
    );
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const user = c.var.user;
    const id = c.req.param('id');
    const row = getRow(db, id);

    if (!isOwnerOrAdmin(row, user.sub, user.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await navidrome.playlists.delete(id);
    db.run('DELETE FROM playlist_visibility WHERE playlist_id = ?', [id]);
    return c.json({ ok: true });
  });

  return app;
}
