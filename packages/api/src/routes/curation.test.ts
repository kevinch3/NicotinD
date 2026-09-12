import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { Role } from '@nicotind/core';
import { applySchema } from '../db.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { AuthEnv } from '../middleware/auth.js';
import {
  createCurationFlag,
  listOpenCurationFlags,
  type FlagTargetKind,
} from '../services/curation-flags.js';
import type { ApplyEffectDeps } from '../services/curation/apply.js';

const sharedDb = new Database(':memory:');
applySchema(sharedDb);

mock.module('../db.js', () => ({
  getDatabase: () => sharedDb,
  applySchema,
}));

const { curationRoutes, describeTarget } = await import('./curation.js');
const { libraryRoutes } = await import('./library.js');

const applyDeps: ApplyEffectDeps = {
  mutateSongMetadata: async () => ({ ok: true }),
  mutateArtistIdentity: () => ({ ok: true }),
  songMetadataDeps: {},
  artistIdentityDeps: {},
};

function makeApp(role: Role = 'admin') {
  const app = new Hono<AuthEnv>();
  app.onError(errorHandler);
  app.use('*', (c, next) => {
    c.set('user', { sub: 'user1', username: 'curator', role, iat: 0, exp: 9999999999 });
    return next();
  });
  app.route(
    '/',
    curationRoutes({
      applyDeps,
      describeTarget: (kind, id) => describeTarget(sharedDb, kind, id),
    }),
  );
  return app;
}

function seedFlag(
  targetId: string,
  reason = 'who is this really?',
  targetKind: FlagTargetKind = 'song',
): number {
  return createCurationFlag(sharedDb, {
    targetKind,
    targetId,
    reason,
    createdBy: 'agent:test',
  }).flag.id;
}

function seedSong(id: string, title: string, artist: string, albumId = 'alb-1'): void {
  sharedDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
     VALUES (?, ?, ?, ?, 'art-1', 0, ?, 1)`,
    [id, albumId, title, artist, `/music/${id}.mp3`],
  );
}

beforeEach(() => {
  sharedDb.run('DELETE FROM curation_flags');
  sharedDb.run('DELETE FROM audit_log');
  sharedDb.run('DELETE FROM library_songs');
  sharedDb.run('DELETE FROM library_albums');
  sharedDb.run('DELETE FROM library_artists');
});

describe('GET /round', () => {
  it('returns at most five cases built from open flags', async () => {
    for (let i = 0; i < 7; i++) seedFlag(`song-${i}`);

    const res = await makeApp().request('/round');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cases: Array<{ id: string }> };
    expect(body.cases).toHaveLength(5);
    expect(new Set(body.cases.map((c) => c.id)).size).toBe(5);
  });

  it('returns an empty round when nothing is open', async () => {
    const res = await makeApp().request('/round');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cases: [] });
  });

  it('names the target instead of leaking its raw id hash', async () => {
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, synced_at) VALUES ('alb-1','Clandestino','Manu Chao','art-1',1)`,
    );
    seedSong('9f3ab7c1deadbeef', 'Desaparecido', 'Manu Chao');
    seedFlag('9f3ab7c1deadbeef');

    const res = await makeApp().request('/round');
    const body = (await res.json()) as {
      cases: Array<{ target: { title: string; subtitle: string } }>;
    };
    expect(body.cases[0]!.target.title).toBe('Desaparecido');
    expect(body.cases[0]!.target.subtitle).toBe('Manu Chao — Clandestino');
    expect(JSON.stringify(body.cases[0]!.target.title)).not.toContain('9f3ab7c1');
  });

  it('stays resolvable when the flag outlived its target', async () => {
    seedFlag('gone-song');

    const res = await makeApp().request('/round');
    const body = (await res.json()) as {
      cases: Array<{ target: { title: string; subtitle: string }; options: Array<{ id: string }> }>;
    };
    expect(body.cases[0]!.target.title).toBe('Missing song');
    expect(body.cases[0]!.target.subtitle).toContain('No longer in the library');
    expect(body.cases[0]!.options.map((o) => o.id)).toEqual(['resolve']);
  });

  it('describes an album and an artist target too', () => {
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, synced_at) VALUES ('alb-2','Kind of Blue','Miles Davis','art-2',1)`,
    );
    sharedDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art-2','Miles Davis',1,1)`,
    );

    expect(describeTarget(sharedDb, 'album', 'alb-2')).toMatchObject({
      title: 'Kind of Blue',
      subtitle: 'Miles Davis',
    });
    expect(describeTarget(sharedDb, 'artist', 'art-2')).toMatchObject({
      title: 'Miles Davis',
      subtitle: '1 album',
    });
  });
});

describe('GET /count', () => {
  it('reports the number of open flags', async () => {
    seedFlag('song-a');
    seedFlag('song-b');
    seedFlag('song-c');

    const res = await makeApp().request('/count');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ open: 3 });
  });
});

describe('POST /cases/:id/apply', () => {
  it('resolves the flag and reports what it did', async () => {
    const id = seedFlag('song-apply');

    const res = await makeApp().request(`/cases/flag:${id}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'resolve' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, detail: 'reviewed, no data change' });
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(0);
  });

  it('audit-logs the applied case', async () => {
    const id = seedFlag('song-audit');

    await makeApp().request(`/cases/flag:${id}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'resolve' }),
    });

    const rows = sharedDb
      .query<{ action: string; target_kind: string; target_id: string; detail: string }, []>(
        'SELECT action, target_kind, target_id, detail FROM audit_log',
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'curation.case',
      target_kind: 'song',
      target_id: 'song-audit',
    });
  });

  it('409s a second apply of the same case and dispatches exactly once', async () => {
    let dispatches = 0;
    const app = new Hono<AuthEnv>();
    app.onError(errorHandler);
    app.use('*', (c, next) => {
      c.set('user', { sub: 'user1', username: 'curator', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route(
      '/',
      curationRoutes({
        applyDeps: {
          ...applyDeps,
          mutateSongMetadata: async () => {
            dispatches++;
            return { ok: true };
          },
        },
        describeTarget: (kind, id) => describeTarget(sharedDb, kind, id),
      }),
    );

    const id = createCurationFlag(sharedDb, {
      targetKind: 'song',
      targetId: 'song-race',
      reason: 'who?',
      createdBy: 'agent:test',
      caseKind: 'placement',
      optionsJson: JSON.stringify([
        {
          id: 'retag',
          label: 'Retag',
          rationale: 'the tag is wrong',
          effect: { type: 'song-metadata', songId: 'song-race', fields: { artist: 'Pharrell' } },
        },
      ]),
    }).flag.id;

    const send = () =>
      app.request(`/cases/flag:${id}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'retag' }),
      });

    expect((await send()).status).toBe(200);
    const second = await send();
    expect(second.status).toBe(409);
    expect(dispatches).toBe(1);
    expect(sharedDb.query('SELECT id FROM audit_log').all()).toHaveLength(1);
  });

  it('404s an unknown case id', async () => {
    const res = await makeApp().request('/cases/flag:9999/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'resolve' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s an option id the case does not offer', async () => {
    const id = seedFlag('song-badopt');
    const res = await makeApp().request(`/cases/flag:${id}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'merge-into-something' }),
    });
    expect(res.status).toBe(400);
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(1);
  });

  it('400s a request with no optionId', async () => {
    const id = seedFlag('song-noopt');
    const res = await makeApp().request(`/cases/flag:${id}/apply`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(1);
  });

  it('requires a curator', async () => {
    const id = seedFlag('song-listener');
    const listener = makeApp('listener');

    expect((await listener.request('/round')).status).toBe(403);
    expect((await listener.request('/count')).status).toBe(403);
    const apply = await listener.request(`/cases/flag:${id}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'resolve' }),
    });
    expect(apply.status).toBe(403);
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(1);
  });
});

describe('mount order', () => {
  // Mounted in the SAME order index.ts uses — curation first — for the reason
  // `/api/library/events` already is: a parameterised library path would
  // otherwise answer these with someone else's 404. Measured: today `library.ts`
  // has no top-level `/:param` route, so reversing the order still passes; this
  // asserts the request reaches the handler through the real mount, and will
  // catch the day such a route is added.
  it('reaches the handler under /api/library and is not shadowed', async () => {
    seedFlag('song-mounted');

    const app = new Hono<AuthEnv>();
    app.onError(errorHandler);
    app.use('*', (c, next) => {
      c.set('user', { sub: 'user1', username: 'curator', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route(
      '/api/library/curation',
      curationRoutes({
        applyDeps,
        describeTarget: (kind, id) => describeTarget(sharedDb, kind, id),
      }),
    );
    app.route('/api/library', libraryRoutes('/music'));

    const res = await app.request('/api/library/curation/round');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cases: unknown[] };
    expect(body.cases).toHaveLength(1);
  });
});
