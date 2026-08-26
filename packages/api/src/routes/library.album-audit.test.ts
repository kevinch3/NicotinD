/**
 * Issue #733 — the album mutation routes (metadata fix, reclassify/hide/unhide,
 * cover set) recorded no audit entry despite being identity-changing curator
 * writes. These tests assert each route now leaves an audit_log trace with the
 * action name the MCP tools share.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { LibraryCurator } from '../services/library-curator.js';
import { libraryRoutes } from './library.js';

let testDb: Database = (() => {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
})();

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  applySchema,
}));

function makeApp(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', {
      sub: 'u1',
      username: 'curator',
      role: 'refiner',
      iat: 0,
      exp: 0,
    } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes(undefined, { curator: new LibraryCurator(testDb) }));
  return app;
}

function seedAlbum(): void {
  testDb.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, year, classification, synced_at)
     VALUES ('al1', 'Drukqs', 'Aphex Twin', 'ar1', 'al1', 1, 120, 2001, 'album', 0)`,
  );
  testDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES ('s1', 'al1', 'Avril 14th', 'Aphex Twin', 'ar1', 120, 'p/s1.flac', 1, '2024', 0)`,
  );
}

function auditRows(): Array<{ action: string; target_id: string; detail: string }> {
  return testDb
    .query<{ action: string; target_id: string; detail: string }, []>(
      'SELECT action, target_id, detail FROM audit_log',
    )
    .all();
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  seedAlbum();
});
afterEach(() => testDb.close());

describe('album mutation audits (issue #733)', () => {
  it('POST /albums/:id/metadata records album.metadata with old → new detail', async () => {
    const res = await makeApp().request('/albums/al1/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album: 'Drukqs (Deluxe)' }),
    });
    expect(res.status).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('album.metadata');
    expect(rows[0]!.detail).toContain('Drukqs');
    expect(rows[0]!.detail).toContain('Drukqs (Deluxe)');
  });

  it('a failed metadata apply records nothing', async () => {
    const res = await makeApp().request('/albums/nope/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album: 'X' }),
    });
    expect(res.status).toBe(404);
    expect(auditRows()).toHaveLength(0);
  });

  it('POST /albums/:id/reclassify records album.classify', async () => {
    const res = await makeApp().request('/albums/al1/reclassify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification: 'ep' }),
    });
    expect(res.status).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'album.classify', target_id: 'al1' });
    expect(rows[0]!.detail).toContain('ep');
  });

  it('POST /albums/:id/hide and /unhide record album.classify', async () => {
    const app = makeApp();
    await app.request('/albums/al1/hide', { method: 'POST' });
    await app.request('/albums/al1/unhide', { method: 'POST' });
    const rows = auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.detail).toContain('hidden');
    expect(rows[1]!.detail).toContain('unhidden');
  });

  it('POST /albums/:id/cover (coverUrl) records album.cover', async () => {
    const res = await makeApp().request('/albums/al1/cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverUrl: 'https://img/new.jpg' }),
    });
    expect(res.status).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'album.cover', target_id: 'al1' });
  });
});
