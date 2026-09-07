import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { recordPlayEvents } from '../services/play-history.js';
import { recommendationRoutes } from './recommendations.js';

let testDb: Database = new Database(':memory:');
mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  applySchema,
}));

function appFor(userId: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: userId } as AuthEnv['Variables']['user']);
    await next();
  });
  app.route('/recommendations', recommendationRoutes());
  return app;
}

function seedSong(id: string): void {
  testDb.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
     VALUES ('alb', 'Alb', 'A', 'a', 1, 0, '2024-01-01', 0)`,
  );
  testDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, landed_at, synced_at)
     VALUES (?, 'alb', ?, 'A', 'a', 200, ?, 1, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1, 0)`,
    [id, id, `/m/${id}.mp3`],
  );
}

const post = (app: Hono<AuthEnv>, body: unknown) =>
  app.request('/recommendations/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('recommendation feedback routes', () => {
  let app: Hono<AuthEnv>;
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    testDb.run(
      `INSERT INTO users (id, username, password_hash) VALUES ('u1', 'a', 'x'), ('u2', 'b', 'y')`,
    );
    seedSong('s1');
    app = appFor('u1');
  });

  it('exclude → listed with the song → restore → gone', async () => {
    const res = await post(app, { songId: 's1', kind: 'exclude' });
    expect(res.status).toBe(201);
    const list = (await (await app.request('/recommendations/excluded')).json()) as {
      excluded: Array<{ songId: string; reason: string; song: { title: string } | null }>;
    };
    expect(list.excluded).toHaveLength(1);
    expect(list.excluded[0]!.reason).toBe('explicit');
    expect(list.excluded[0]!.song?.title).toBe('s1');

    const del = await app.request('/recommendations/excluded/s1', { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = (await (await app.request('/recommendations/excluded')).json()) as {
      excluded: unknown[];
    };
    expect(after.excluded).toHaveLength(0);
  });

  it('validates the body and 404s an unknown song', async () => {
    expect((await post(app, { kind: 'exclude' })).status).toBe(400);
    expect((await post(app, { songId: 's1', kind: 'meh' })).status).toBe(400);
    expect((await post(app, { songId: 'nope', kind: 'exclude' })).status).toBe(404);
  });

  it('stores the variety vote context and does not exclude', async () => {
    const res = await post(app, {
      songId: 's1',
      kind: 'too_similar',
      context: { strategyFrom: 'balanced', strategyTo: 'different' },
    });
    expect(res.status).toBe(201);
    const list = (await (await app.request('/recommendations/excluded')).json()) as {
      excluded: unknown[];
    };
    expect(list.excluded).toHaveLength(0);
    const row = testDb
      .query<{ context_json: string }, []>('SELECT context_json FROM recommendation_feedback')
      .get();
    expect(JSON.parse(row!.context_json)).toEqual({
      strategyFrom: 'balanced',
      strategyTo: 'different',
    });
  });

  it('a derived exclusion lists its skip count and is undone by DELETE', async () => {
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      recordPlayEvents(testDb, 'u1', [
        {
          clientEventId: `e${i}`,
          songId: 's1',
          title: 's1',
          artist: 'A',
          album: null,
          startedAt: now - 1000 * (i + 1),
          msPlayed: 3000,
          durationMs: 200_000,
          reason: 'skipped',
          source: 'radio',
          device: 'web',
        },
      ]);
    }
    const list = (await (await app.request('/recommendations/excluded')).json()) as {
      excluded: Array<{ reason: string; skips?: number }>;
    };
    expect(list.excluded).toEqual([expect.objectContaining({ reason: 'skips', skips: 2 })]);
    await app.request('/recommendations/excluded/s1', { method: 'DELETE' });
    const after = (await (await app.request('/recommendations/excluded')).json()) as {
      excluded: unknown[];
    };
    expect(after.excluded).toHaveLength(0);
  });

  it('is scoped to the caller', async () => {
    await post(app, { songId: 's1', kind: 'exclude' });
    const other = (await (await appFor('u2').request('/recommendations/excluded')).json()) as {
      excluded: unknown[];
    };
    expect(other.excluded).toHaveLength(0);
  });
});
