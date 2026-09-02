import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import type { StemStatus } from '../services/vocal-separation.js';

/**
 * Karaoke prepare/status endpoint (issue #603), mounted at `/api/stream` so the
 * existing `app.use('/api/stream/*', auth)` covers it:
 *
 *   POST /api/stream/:id/stem   idempotent "ensure": enqueue if needed → StemStatus
 *   GET  /api/stream/:id/stem   status only, never enqueues            → StemStatus
 *
 * Always 200 with a `state`; a 202 for "queued" would only add a branch the
 * client does not need. 404 for anything that is not a song file inside the
 * library. Any authenticated user may call it — karaoke already is a listener
 * feature; the GPU cost is bounded by the service's serialisation, its queue
 * cap, the session-only trigger in the web, and the admin opt-in.
 */
export interface VocalSeparationRoutesDeps {
  db: Database;
  musicDir: string;
  service: {
    ensure(abs: string, relPath: string, durationSec: number): Promise<StemStatus>;
    status(abs: string, durationSec: number): StemStatus;
  };
}

export function vocalSeparationRoutes(deps: VocalSeparationRoutesDeps) {
  const app = new Hono<AuthEnv>();
  const musicRoot = resolve(deps.musicDir);

  function resolveSong(id: string): { abs: string; relPath: string; durationSec: number } | null {
    const row = deps.db
      .query<{ path: string; duration: number }, [string]>(
        'SELECT path, duration FROM library_songs WHERE id = ?',
      )
      .get(id);
    if (!row) return null;
    const abs = resolve(join(musicRoot, row.path));
    if (abs !== musicRoot && !abs.startsWith(musicRoot + sep)) return null; // traversal guard
    if (!existsSync(abs)) return null;
    return { abs, relPath: row.path, durationSec: Number(row.duration) || 0 };
  }

  app.post('/:id/stem', async (c) => {
    const song = resolveSong(c.req.param('id'));
    if (!song) return c.json({ error: 'song not found', code: 'NOT_FOUND' }, 404);
    return c.json(await deps.service.ensure(song.abs, song.relPath, song.durationSec));
  });

  app.get('/:id/stem', (c) => {
    const song = resolveSong(c.req.param('id'));
    if (!song) return c.json({ error: 'song not found', code: 'NOT_FOUND' }, 404);
    return c.json(deps.service.status(song.abs, song.durationSec));
  });

  return app;
}
