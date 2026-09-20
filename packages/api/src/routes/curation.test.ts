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
import { artistIdFor } from '../services/library-scanner.js';
import type { ApplyEffectDeps } from '../services/curation/apply.js';

const sharedDb = new Database(':memory:');
applySchema(sharedDb);

mock.module('../db.js', () => ({
  getDatabase: () => sharedDb,
  applySchema,
}));

const { curationRoutes, describeTarget, SKIP_SNOOZE_MS } = await import('./curation.js');
const { libraryRoutes } = await import('./library.js');

const applyDeps: ApplyEffectDeps = {
  mutateSongMetadata: async () => ({ ok: true }),
  mutateArtistIdentity: () => ({ ok: true }),
  deleteSong: async () => ({ ok: true }),
  songMetadataDeps: {},
  artistIdentityDeps: {},
  deletionDeps: {} as never,
};

function makeApp(role: Role = 'admin', deps: Partial<ApplyEffectDeps> = {}) {
  const app = new Hono<AuthEnv>();
  app.onError(errorHandler);
  app.use('*', (c, next) => {
    c.set('user', { sub: 'user1', username: 'curator', role, iat: 0, exp: 9999999999 });
    return next();
  });
  app.route(
    '/',
    curationRoutes({
      applyDeps: { ...applyDeps, ...deps },
      describeTarget: (kind, id) => describeTarget(sharedDb, kind, id),
    }),
  );
  return app;
}

const retag = (songId: string) => ({
  id: 'retag',
  label: 'Retag',
  rationale: 'the tag is wrong',
  effect: { type: 'song-metadata', songId, fields: { artist: 'Pharrell' } },
});

/** A prose flag: open, but never a card. */
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

/** A typed flag with one actionable option: the shape the round serves. */
function seedCase(
  targetId: string,
  targetKind: FlagTargetKind = 'song',
  options: unknown[] = [retag(targetId)],
): number {
  return createCurationFlag(sharedDb, {
    targetKind,
    targetId,
    reason: 'long research',
    createdBy: 'agent:test',
    caseKind: 'placement',
    question: 'Whose recording is this?',
    optionsJson: JSON.stringify(options),
  }).flag.id;
}

function seedSong(id: string, title: string, artist: string, albumId = 'alb-1'): void {
  sharedDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
     VALUES (?, ?, ?, ?, 'art-1', 0, ?, 1)`,
    [id, albumId, title, artist, `/music/${id}.mp3`],
  );
}

const post = (app: Hono<AuthEnv>, path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  sharedDb.run('DELETE FROM curation_flags');
  sharedDb.run('DELETE FROM audit_log');
  sharedDb.run('DELETE FROM library_songs');
  sharedDb.run('DELETE FROM library_albums');
  sharedDb.run('DELETE FROM library_artists');
});

describe('GET /round', () => {
  // Every song target below is seeded: a case whose target is gone is not served.
  it('returns at most five cases built from open typed flags', async () => {
    for (let i = 0; i < 7; i++) {
      seedSong(`song-${i}`, `T${i}`, 'A');
      seedCase(`song-${i}`);
    }

    const res = await makeApp().request('/round');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cases: Array<{ id: string }>; awaitingAgent: number };
    expect(body.cases).toHaveLength(5);
    expect(new Set(body.cases.map((c) => c.id)).size).toBe(5);
    expect(body.awaitingAgent).toBe(0);
  });

  it('returns an empty round when nothing is open', async () => {
    const res = await makeApp().request('/round');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cases: [], awaitingAgent: 0 });
  });

  // The contract with the human: a card is a question plus closed options that
  // each do something. A prose flag is the agent's unfinished work.
  it('never serves a prose flag, and counts it as awaiting the agent', async () => {
    seedSong('s-prose', 'T', 'A');
    seedFlag('s-prose');

    const body = (await (await makeApp().request('/round')).json()) as {
      cases: unknown[];
      awaitingAgent: number;
    };
    expect(body.cases).toEqual([]);
    expect(body.awaitingAgent).toBe(1);
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(1);
  });

  it('names the target instead of leaking its raw id hash', async () => {
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, synced_at) VALUES ('alb-1','Clandestino','Manu Chao','art-1',1)`,
    );
    seedSong('9f3ab7c1deadbeef', 'Desaparecido', 'Manu Chao');
    seedCase('9f3ab7c1deadbeef');

    const res = await makeApp().request('/round');
    const body = (await res.json()) as {
      cases: Array<{ target: { title: string; subtitle: string } }>;
    };
    expect(body.cases[0]!.target.title).toBe('Desaparecido');
    expect(body.cases[0]!.target.subtitle).toBe('Manu Chao — Clandestino');
    expect(JSON.stringify(body.cases[0]!.target.title)).not.toContain('9f3ab7c1');
  });

  it('serves the question, folds the research, and appends Leave as is', async () => {
    seedSong('s-q', 'T', 'A');
    seedCase('s-q');

    const body = (await (await makeApp().request('/round')).json()) as {
      cases: Array<{ question: string; details: string; options: Array<{ id: string }> }>;
    };
    expect(body.cases[0]!.question).toBe('Whose recording is this?');
    expect(body.cases[0]!.details).toBe('long research');
    expect(body.cases[0]!.options.map((o) => o.id)).toEqual(['retag', 'resolve']);
  });

  // A flag outlives its target when a song is deleted or re-keyed by a move.
  // A human can do nothing about a subject that is gone, so the card is not
  // served; the agent list carries `targetMissing` instead.
  it('never serves a case whose target is gone, and counts it as awaiting the agent', async () => {
    seedCase('gone-song');

    const body = (await (await makeApp().request('/round')).json()) as {
      cases: unknown[];
      awaitingAgent: number;
    };
    expect(body.cases).toEqual([]);
    expect(body.awaitingAgent).toBe(1);
  });

  // The prod bug this rework started from: flag #19 stored the artist's RAW
  // NAME (as `flag_for_review` invites) and rendered as "Missing artist — no
  // longer in the library" while the artist sat in the library.
  it('serves an artist flagged by raw name, resolved to its library row', async () => {
    const name = 'Secret CInema B2B Egbert playing "Enrico Sangiuliano';
    sharedDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, 1, 1)`,
      [artistIdFor(name), name],
    );
    seedCase(name, 'artist', [
      {
        id: 'merge',
        label: 'Credit Secret Cinema',
        effect: { type: 'artist-merge', rawName: name, mergeInto: 'Secret Cinema' },
      },
    ]);

    const body = (await (await makeApp().request('/round')).json()) as {
      cases: Array<{ target: { id: string; title: string; subtitle: string } }>;
    };
    expect(body.cases).toHaveLength(1);
    expect(body.cases[0]!.target).toMatchObject({
      id: artistIdFor(name),
      title: name,
      subtitle: '1 album',
    });
  });

  it('describes an album and an artist target too, and a missing one as null', () => {
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
    expect(describeTarget(sharedDb, 'artist', 'miles davis')).toMatchObject({ id: 'art-2' });
    expect(describeTarget(sharedDb, 'artist', 'nobody')).toBeNull();
    expect(describeTarget(sharedDb, 'album', 'nope')).toBeNull();
    expect(describeTarget(sharedDb, 'song', 'nope')).toBeNull();
  });
});

describe('GET /count', () => {
  it('reports the served pool, not every open flag', async () => {
    seedSong('song-a', 'T', 'A');
    seedSong('song-b', 'T', 'A');
    seedCase('song-a');
    seedCase('song-b');
    seedFlag('song-c');

    const res = await makeApp().request('/count');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ open: 2, awaitingAgent: 1 });
  });
});

describe('POST /cases/:id/skip', () => {
  it('defers the case out of the round for a week, without closing it', async () => {
    seedSong('s-skip', 'T', 'A');
    const id = seedCase('s-skip');
    const before = Date.now();

    const res = await post(makeApp(), `/cases/flag:${id}/skip`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; until: number };
    expect(body.until).toBeGreaterThanOrEqual(before + SKIP_SNOOZE_MS);

    expect(await (await makeApp().request('/round')).json()).toEqual({
      cases: [],
      awaitingAgent: 0,
    });
    expect(await (await makeApp().request('/count')).json()).toEqual({ open: 0, awaitingAgent: 0 });
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(1);
    expect(sharedDb.query('SELECT id FROM audit_log').all()).toHaveLength(0);
  });

  it('404s an unknown, malformed or already-resolved case', async () => {
    expect((await post(makeApp(), '/cases/flag:9999/skip')).status).toBe(404);
    expect((await post(makeApp(), '/cases/gen:x/skip')).status).toBe(404);
    seedSong('s-done', 'T', 'A');
    const id = seedCase('s-done');
    await post(makeApp(), `/cases/flag:${id}/apply`, { optionId: 'resolve' });
    expect((await post(makeApp(), `/cases/flag:${id}/skip`)).status).toBe(404);
  });

  it('requires a curator', async () => {
    seedSong('s-l', 'T', 'A');
    const id = seedCase('s-l');
    expect((await post(makeApp('listener'), `/cases/flag:${id}/skip`)).status).toBe(403);
  });
});

describe('POST /cases/:id/apply', () => {
  it('resolves the flag and reports what it did', async () => {
    seedSong('song-apply', 'T', 'A');
    const id = seedCase('song-apply');

    const res = await post(makeApp(), `/cases/flag:${id}/apply`, { optionId: 'resolve' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, detail: 'reviewed, no data change' });
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(0);
  });

  it('audit-logs the applied case', async () => {
    seedSong('song-audit', 'T', 'A');
    const id = seedCase('song-audit');

    await post(makeApp(), `/cases/flag:${id}/apply`, { optionId: 'resolve' });

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

  // A delete through a card is still a delete: it must count wherever
  // `song.delete` rows are counted (prod probes count exactly that).
  it('a song-delete apply dispatches deleteOne and writes a song.delete audit row too', async () => {
    seedSong('song-del', 'T', 'A');
    const deleted: string[] = [];
    const id = seedCase('song-del', 'song', [
      { id: 'del', label: 'Delete this copy', effect: { type: 'song-delete', songId: 'song-del' } },
    ]);

    const res = await post(
      makeApp('admin', {
        deleteSong: async (_db, songId) => {
          deleted.push(songId);
          return { ok: true };
        },
      }),
      `/cases/flag:${id}/apply`,
      { optionId: 'del' },
    );

    expect(res.status).toBe(200);
    expect(deleted).toEqual(['song-del']);
    const actions = sharedDb
      .query<{ action: string }, []>('SELECT action FROM audit_log ORDER BY id')
      .all()
      .map((r) => r.action);
    expect(actions).toEqual(['curation.case', 'song.delete']);
  });

  it('409s a second apply of the same case and dispatches exactly once', async () => {
    let dispatches = 0;
    const app = makeApp('admin', {
      mutateSongMetadata: async () => {
        dispatches++;
        return { ok: true };
      },
    });
    seedSong('song-race', 'T', 'A');
    const id = seedCase('song-race');

    const send = () => post(app, `/cases/flag:${id}/apply`, { optionId: 'retag' });

    expect((await send()).status).toBe(200);
    const second = await send();
    expect(second.status).toBe(409);
    expect(dispatches).toBe(1);
    expect(sharedDb.query('SELECT id FROM audit_log').all()).toHaveLength(1);
  });

  it('pins the resolve-first lock under real concurrency: racing two applies on one flag dispatches exactly once', async () => {
    // The sequential test above ("409s a second apply...") never overlaps the
    // two requests' processing — by the time the second is even issued, the
    // first has fully finished (its own dispatch AND resolve). That proves
    // only that a second apply after the first is done gets 409; it does not
    // exercise the lock under contention, and would pass identically against
    // the old dispatch-then-resolve ordering (see the git history on this
    // file). Firing both requests before awaiting either is the concurrent
    // shape: the second request's own case lookup runs while the first is
    // still mid-flight, so this is the one that actually distinguishes
    // "resolve is the lock" from "resolve happens eventually".
    let dispatches = 0;
    const app = makeApp('admin', {
      mutateSongMetadata: async () => {
        dispatches++;
        return { ok: true };
      },
    });
    seedSong('song-race-concurrent', 'T', 'A');
    const id = seedCase('song-race-concurrent');

    const send = () => post(app, `/cases/flag:${id}/apply`, { optionId: 'retag' });

    // Both fired before either is awaited — do not `await send()` here.
    const first = send();
    const second = send();
    const results = await Promise.all([first, second]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([200, 409]);
    expect(dispatches).toBe(1);
    expect(sharedDb.query('SELECT id FROM audit_log').all()).toHaveLength(1);
  });

  it('leaves the flag resolved (not reopened) when the dispatch fails after the lock is taken', async () => {
    const app = makeApp('admin', {
      mutateSongMetadata: async () => ({ ok: false, error: 'tag write failed' }),
    });
    seedSong('song-dispatch-fail', 'T', 'A');
    const id = seedCase('song-dispatch-fail');

    const res = await post(app, `/cases/flag:${id}/apply`, { optionId: 'retag' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'tag write failed', resolved: true });
    // Not open (resolved) and not resolvable a second time — the deliberate
    // contract: a failed dispatch after the lock leaves the flag closed with
    // no data change, recoverable only by re-flagging.
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(0);
  });

  it('404s an unknown case id, and a prose flag that is open but not a case', async () => {
    expect((await post(makeApp(), '/cases/flag:9999/apply', { optionId: 'resolve' })).status).toBe(
      404,
    );
    seedSong('s-prose', 'T', 'A');
    const id = seedFlag('s-prose');
    expect((await post(makeApp(), `/cases/flag:${id}/apply`, { optionId: 'resolve' })).status).toBe(
      404,
    );
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(1);
  });

  it('400s an option id the case does not offer', async () => {
    seedSong('song-badopt', 'T', 'A');
    const id = seedCase('song-badopt');
    const res = await post(makeApp(), `/cases/flag:${id}/apply`, {
      optionId: 'merge-into-something',
    });
    expect(res.status).toBe(400);
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(1);
  });

  it('400s a request with no optionId', async () => {
    seedSong('song-noopt', 'T', 'A');
    const id = seedCase('song-noopt');
    const res = await post(makeApp(), `/cases/flag:${id}/apply`);
    expect(res.status).toBe(400);
    expect(listOpenCurationFlags(sharedDb)).toHaveLength(1);
  });

  it('requires a curator', async () => {
    seedSong('song-listener', 'T', 'A');
    const id = seedCase('song-listener');
    const listener = makeApp('listener');

    expect((await listener.request('/round')).status).toBe(403);
    expect((await listener.request('/count')).status).toBe(403);
    const apply = await post(listener, `/cases/flag:${id}/apply`, { optionId: 'resolve' });
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
    seedSong('song-mounted', 'T', 'A');
    seedCase('song-mounted');

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
