import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';

type MetadataJoinRow = {
  playlist_id: string;
  created_by: string | null;
  created_at: string | null;
  modified_by: string | null;
  modified_at: string | null;
};

type GateRow = {
  owner_id: string;
  created_by: string | null;
};

type PlaylistAuthorFields = {
  createdBy: string | null;
  createdAt: string | null;
  modifiedBy: string | null;
  modifiedAt: string | null;
};

const JOIN_SQL = `SELECT pv.playlist_id,
                         cu.username AS created_by,
                         pv.created_at,
                         mu.username AS modified_by,
                         pv.modified_at
                  FROM playlist_visibility pv
                  LEFT JOIN users cu ON cu.id = pv.created_by
                  LEFT JOIN users mu ON mu.id = pv.modified_by`;

function joinMetadata<T extends { id: string }>(db: Database, playlists: T[]): Array<T & PlaylistAuthorFields> {
  if (playlists.length === 0) return [];
  const placeholders = playlists.map(() => '?').join(',');
  const rows = db
    .query<MetadataJoinRow, string[]>(`${JOIN_SQL} WHERE pv.playlist_id IN (${placeholders})`)
    .all(...playlists.map((p) => p.id));
  const byId = new Map(rows.map((r) => [r.playlist_id, r]));
  return playlists.map((p) => {
    const row = byId.get(p.id);
    return {
      ...p,
      createdBy: row?.created_by ?? null,
      createdAt: row?.created_at ?? null,
      modifiedBy: row?.modified_by ?? null,
      modifiedAt: row?.modified_at ?? null,
    };
  });
}

function attachMetadata<T extends { id: string }>(db: Database, playlist: T): T & PlaylistAuthorFields {
  const row = db
    .query<MetadataJoinRow, [string]>(`${JOIN_SQL} WHERE pv.playlist_id = ?`)
    .get(playlist.id);
  return {
    ...playlist,
    createdBy: row?.created_by ?? null,
    createdAt: row?.created_at ?? null,
    modifiedBy: row?.modified_by ?? null,
    modifiedAt: row?.modified_at ?? null,
  };
}

function upsertMetadata(db: Database, playlistId: string, userId: string, isCreate: boolean): void {
  if (isCreate) {
    db.run(
      `INSERT INTO playlist_visibility
         (playlist_id, owner_id, visibility, created_by, created_at, modified_by, modified_at)
       VALUES (?, ?, 'global', ?, datetime('now'), ?, datetime('now'))`,
      [playlistId, userId, userId, userId],
    );
    return;
  }
  db.run(
    `INSERT INTO playlist_visibility
       (playlist_id, owner_id, visibility, created_by, created_at, modified_by, modified_at)
     VALUES (?, ?, 'global', ?, datetime('now'), ?, datetime('now'))
     ON CONFLICT(playlist_id) DO UPDATE SET
       modified_by = excluded.modified_by,
       modified_at = excluded.modified_at`,
    [playlistId, userId, userId, userId],
  );
}

export function playlistRoutes(navidrome: Navidrome, db: Database) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    const playlists = await navidrome.playlists.list();
    return c.json(joinMetadata(db, playlists));
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const playlist = await navidrome.playlists.get(id);
    return c.json(attachMetadata(db, playlist));
  });

  app.post('/', async (c) => {
    const user = c.var.user;
    const { name, songIds } = await c.req.json<{
      name: string;
      songIds?: string[];
    }>();

    if (!name) {
      return c.json({ error: 'name is required' }, 400);
    }

    const playlist = await navidrome.playlists.create(name, songIds);
    upsertMetadata(db, playlist.id, user.sub, true);
    return c.json(attachMetadata(db, playlist), 201);
  });

  app.put('/:id', async (c) => {
    const user = c.var.user;
    const id = c.req.param('id');
    const updates = await c.req.json<{
      name?: string;
      songIdsToAdd?: string[];
      songIndexesToRemove?: number[];
    }>();
    await navidrome.playlists.update(id, updates);
    upsertMetadata(db, id, user.sub, false);
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const user = c.var.user;
    const id = c.req.param('id');
    const row = db
      .query<GateRow, [string]>(
        'SELECT owner_id, created_by FROM playlist_visibility WHERE playlist_id = ?',
      )
      .get(id);

    const creator = row?.created_by ?? row?.owner_id ?? null;
    const isAdmin = user.role === 'admin';
    const isCreator = creator !== null && creator === user.sub;
    if (!isAdmin && !isCreator) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await navidrome.playlists.delete(id);
    db.run('DELETE FROM playlist_visibility WHERE playlist_id = ?', [id]);
    return c.json({ ok: true });
  });

  return app;
}
