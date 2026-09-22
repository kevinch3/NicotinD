import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { settingsRoutes } from './settings.js';
import { authMiddleware, signJwt } from '../middleware/auth.js';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';

const testDb = new Database(':memory:');
applySchema(testDb);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('admin1', 'admin', 'hash', 'admin')",
);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('user1', 'alice', 'hash', 'user')",
);

mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));

const SECRET = 'test-secret';

async function userToken() {
  return signJwt({ sub: 'user1', username: 'alice', role: 'user' }, SECRET);
}

function buildApp(
  overrides: {
    dataDir?: string;
    soulseek?: { username: string; password: string };
    downloads?: { transcodeLossless: { enabled: boolean; format: 'opus'; bitRate: number } };
  } = {},
) {
  const app = new Hono<AuthEnv>();
  const auth = authMiddleware(SECRET);
  const config = {
    soulseek: overrides.soulseek ?? { username: 'u', password: 'p' },
    dataDir: overrides.dataDir ?? '/tmp/nicotind-test',
    mode: 'external',
    downloads: overrides.downloads ?? {
      transcodeLossless: { enabled: true, format: 'opus', bitRate: 192 },
    },
  } as unknown as Parameters<typeof settingsRoutes>[0];
  const routes = settingsRoutes(config);
  app.use('*', auth);
  app.route('/', routes);
  return app;
}

describe('GET /downloads', () => {
  it('returns the lossless transcode config + ffmpeg availability for any user', async () => {
    const app = buildApp();
    const token = await userToken(); // informational — not admin-gated
    const res = await app.request('/downloads', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      transcodeLossless: { enabled: boolean; format: string; bitRate: number };
      ffmpegAvailable: boolean;
    };
    expect(data.transcodeLossless).toMatchObject({ enabled: true, format: 'opus', bitRate: 192 });
    expect(typeof data.ffmpegAvailable).toBe('boolean');
  });

  it('reflects a disabled / re-bitrated transcode setting', async () => {
    const app = buildApp({
      downloads: { transcodeLossless: { enabled: false, format: 'opus', bitRate: 256 } },
    });
    const token = await userToken();
    const res = await app.request('/downloads', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as {
      transcodeLossless: { enabled: boolean; bitRate: number };
    };
    expect(data.transcodeLossless.enabled).toBe(false);
    expect(data.transcodeLossless.bitRate).toBe(256);
  });
});

async function adminToken() {
  return signJwt({ sub: 'admin1', username: 'admin', role: 'admin' }, SECRET);
}

describe('/radio — the learned genre axis (docs/genre-affinity.md)', () => {
  it('reads ON by default with the centroid status, for any user', async () => {
    const app = buildApp();
    const res = await app.request('/radio', {
      headers: { Authorization: `Bearer ${await userToken()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      genreAffinity: true,
      queueTarget: 20,
      centroids: 0,
      computedAt: null,
    });
  });

  /** A body the route finds no boolean in must not stamp one: that spurious
   *  explicit false is exactly what would suppress the #1121 default. */
  it('an admin write with no genreAffinity key leaves the default tracked', async () => {
    const app = buildApp();
    const res = await app.request('/radio', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await adminToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ somethingElse: 1 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { genreAffinity: boolean }).genreAffinity).toBe(true);
    const stored = testDb
      .query<{ value: string }, []>(`SELECT value FROM app_settings WHERE key = 'radio'`)
      .get();
    expect(JSON.parse(stored!.value)).toEqual({});
  });

  it('refuses a non-admin write', async () => {
    const app = buildApp();
    const res = await app.request('/radio', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${await userToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ genreAffinity: true }),
    });
    expect(res.status).toBe(403);
  });

  it('an admin flips it, and enabling builds the centroids on the spot', async () => {
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES ('ra', 'Album', 'Artist', 'art', 1, 0, 1)`,
    );
    testDb.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, genre, created, synced_at)
       VALUES ('rs1', 'ra', 'T', 'Artist', 'art', 200, 'Artist/Album/rs1.opus', 1000, 'Tango', '2024-01-01', 1)`,
    );
    testDb.run(
      `INSERT INTO library_embeddings (song_id, model, dim, vec, file_size, updated_at)
       VALUES ('rs1', 'discogs-effnet-bs64-1', 2, ?, 1000, 1)`,
      [Buffer.from(new Float32Array([1, 0]).buffer)],
    );
    const app = buildApp();
    const headers = {
      Authorization: `Bearer ${await adminToken()}`,
      'Content-Type': 'application/json',
    };
    const on = await app.request('/radio', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ genreAffinity: true, ignored: 'x' }),
    });
    expect(on.status).toBe(200);
    const body = (await on.json()) as {
      genreAffinity: boolean;
      centroids: number;
      computedAt: number | null;
    };
    expect(body.genreAffinity).toBe(true);
    expect(body.centroids).toBe(1);
    expect(body.computedAt).not.toBeNull();

    const off = await app.request('/radio', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ genreAffinity: false }),
    });
    expect(((await off.json()) as { genreAffinity: boolean }).genreAffinity).toBe(false);
    // The data stays; only the switch moved.
    const get = await app.request('/radio', { headers });
    expect(((await get.json()) as { centroids: number }).centroids).toBe(1);
  });

  /** The player reads this depth on every boot, so a non-admin GET must carry it. */
  it('an admin sets the radio queue depth, and any user can read it back', async () => {
    const app = buildApp();
    const put = await app.request('/radio', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await adminToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ queueTarget: 30 }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { queueTarget: number }).queueTarget).toBe(30);
    const get = await app.request('/radio', {
      headers: { Authorization: `Bearer ${await userToken()}` },
    });
    expect(((await get.json()) as { queueTarget: number }).queueTarget).toBe(30);
  });

  it('refuses a depth outside the band, leaving the stored one untouched', async () => {
    const app = buildApp();
    const headers = {
      Authorization: `Bearer ${await adminToken()}`,
      'Content-Type': 'application/json',
    };
    const res = await app.request('/radio', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ queueTarget: 0 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { queueTarget: number }).queueTarget).toBe(30);
  });
});
