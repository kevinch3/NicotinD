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
