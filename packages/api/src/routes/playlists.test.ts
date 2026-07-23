import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';

const db = new Database(':memory:');
applySchema(db);
mock.module('../db.js', () => ({ getDatabase: () => db, applySchema }));

const { playlistRoutes } = await import('./playlists.js');

function appAs(sub: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub, role: 'user', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route('/', playlistRoutes());
  return app;
}

describe('playlist routes', () => {
  beforeEach(() => {
    db.run('DELETE FROM playlists');
    db.run('DELETE FROM playlist_songs');
  });

  it('rejects a create with no name', async () => {
    const res = await appAs('u1').request('/', { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it('creates and lists a playlist for the owning user only', async () => {
    const create = await appAs('u1').request('/', {
      method: 'POST',
      body: JSON.stringify({ name: 'Mine' }),
    });
    expect(create.status).toBe(201);

    const mine = (await (await appAs('u1').request('/')).json()) as { playlists: unknown[] };
    expect(mine.playlists).toHaveLength(1);

    const others = (await (await appAs('u2').request('/')).json()) as { playlists: unknown[] };
    expect(others.playlists).toHaveLength(0);
  });

  it("returns 404 fetching another user's playlist", async () => {
    const create = await appAs('u1').request('/', {
      method: 'POST',
      body: JSON.stringify({ name: 'Mine' }),
    });
    const { playlist } = (await create.json()) as { playlist: { id: string } };
    const res = await appAs('u2').request(`/${playlist.id}`);
    expect(res.status).toBe(404);
  });

  // ─── Curated (system, global, read-only) playlists ─────────────────
  function seedCurated(id: string, name: string): void {
    db.run(
      `INSERT INTO playlists (id, user_id, name, description, cover_art, kind, created_at, modified_at)
       VALUES (?, 'admin', ?, 'desc', '/playlist-covers/x.svg', 'curated', 0, 0)`,
      [id, name],
    );
  }

  it('shows curated playlists to every user with kind + coverArt', async () => {
    seedCurated('c1', 'Latin Beats');
    for (const user of ['u1', 'u2']) {
      const body = (await (await appAs(user).request('/')).json()) as {
        playlists: Array<{ kind: string; coverArt: string | null }>;
      };
      expect(body.playlists).toHaveLength(1);
      expect(body.playlists[0].kind).toBe('curated');
      expect(body.playlists[0].coverArt).toBe('/playlist-covers/x.svg');
    }
  });

  it('lets any user fetch a curated playlist detail', async () => {
    seedCurated('c1', 'Latin Beats');
    const res = await appAs('u2').request('/c1');
    expect(res.status).toBe(200);
  });

  it('blocks updating a curated playlist (read-only)', async () => {
    seedCurated('c1', 'Latin Beats');
    const res = await appAs('u1').request('/c1', {
      method: 'PUT',
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(res.status).toBe(404);
  });

  it('blocks deleting a curated playlist (read-only)', async () => {
    seedCurated('c1', 'Latin Beats');
    const res = await appAs('u1').request('/c1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
