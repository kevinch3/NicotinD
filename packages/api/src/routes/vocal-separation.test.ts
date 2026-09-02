/**
 * `POST/GET /api/stream/:id/stem` — the karaoke prepare/status endpoint
 * (issue #603). Mounted under the `/api/stream/*` auth prefix; any
 * authenticated user, because karaoke already is.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import { vocalSeparationRoutes } from './vocal-separation.js';
import type { StemStatus } from '../services/vocal-separation.js';

let musicDir = '';
let db: Database;
const calls: Array<{
  kind: 'ensure' | 'status';
  abs: string;
  relPath?: string;
  durationSec: number;
}> = [];
let answer: StemStatus = { state: 'idle' };

const service = {
  async ensure(abs: string, relPath: string, durationSec: number): Promise<StemStatus> {
    calls.push({ kind: 'ensure', abs, relPath, durationSec });
    return answer;
  },
  status(abs: string, durationSec: number): StemStatus {
    calls.push({ kind: 'status', abs, durationSec });
    return answer;
  },
};

function seedSong(id: string, relPath: string, duration = 213): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'alb', 'T', 'A', 'art', ?, ?, 10, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1)`,
    [id, duration, relPath],
  );
}

let app: Hono;

beforeAll(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'nd-stem-routes-'));
  db = new Database(':memory:');
  applySchema(db);
  mkdirSync(join(musicDir, 'A', 'B'), { recursive: true });
  writeFileSync(join(musicDir, 'A', 'B', 't.mp3'), 'x'.repeat(2048));
  seedSong('song-1', 'A/B/t.mp3');
  seedSong('song-gone', 'A/B/missing.mp3');
  seedSong('song-escape', '../../etc/passwd');
  app = new Hono();
  app.route('/stream', vocalSeparationRoutes({ db, musicDir, service }));
});

afterAll(() => rmSync(musicDir, { recursive: true, force: true }));

describe('POST /stream/:id/stem', () => {
  it('ensures the stem for a known song and returns the service status', async () => {
    calls.length = 0;
    answer = { state: 'preparing', etaSec: 42 };
    const res = await app.request('/stream/song-1/stem', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'preparing', etaSec: 42 });
    expect(calls).toEqual([
      {
        kind: 'ensure',
        abs: resolve(join(musicDir, 'A/B/t.mp3')),
        relPath: 'A/B/t.mp3',
        durationSec: 213,
      },
    ]);
  });

  it('404s for an unknown id, a missing file and a path that escapes the library', async () => {
    calls.length = 0;
    for (const id of ['nope', 'song-gone', 'song-escape']) {
      expect((await app.request(`/stream/${id}/stem`, { method: 'POST' })).status).toBe(404);
    }
    expect(calls).toEqual([]);
  });
});

describe('GET /stream/:id/stem', () => {
  it('reports status without ever enqueueing', async () => {
    calls.length = 0;
    answer = { state: 'ready' };
    const res = await app.request('/stream/song-1/stem');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'ready' });
    expect(calls.map((c) => c.kind)).toEqual(['status']);
  });
});
