import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { hashPassword, ROLES } from '@nicotind/core';
import type { ProcessingSettings, ProcessingStatus, Role } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import { transcodeLibraryToOpus } from '../services/library-transcode.js';
import { optimizeAllAlbums } from '../services/metadata-optimize.js';
import { setProcessingSettings } from '../services/processing-settings.js';
import { parseHhMm } from '../services/processing-window.js';
import { loadQuarantineQueue } from '../services/song-steps.js';
import { presenceService } from '../services/presence.js';
import type { LibraryProcessingService } from '../services/library-processing.service.js';

export interface AdminRoutesDeps {
  musicDir: string;
  /** Cover-cache dir for metadata-optimize (purged when a canonical URL changes). */
  coverCacheDir?: string;
  /** Lidarr client; null when unconfigured (metadata-optimize then 503s). */
  lidarr?: Lidarr | null;
  /** Windowed library-processing scheduler; null when not wired (503s). */
  processing?: LibraryProcessingService | null;
}

export function adminRoutes(deps: AdminRoutesDeps) {
  const app = new Hono<AuthEnv>();

  // Admin guard — all routes require admin role
  app.use('*', async (c, next) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }
    await next();
  });

  // Create a new user (admin-only)
  app.post('/users', async (c) => {
    const { username, password } = await c.req.json<{ username: string; password: string }>();

    if (!username || !password || password.length < 4) {
      return c.json({ error: 'Username and password (min 4 chars) are required' }, 400);
    }

    const db = getDatabase();
    const existing = db
      .query<{ id: string }, [string]>('SELECT id FROM users WHERE username = ?')
      .get(username);
    if (existing) {
      return c.json({ error: 'Username already taken' }, 409);
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);

    db.query('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
      id,
      username,
      passwordHash,
      'user',
    );
    db.query('INSERT INTO user_settings (user_id) VALUES (?)').run(id);

    return c.json(
      {
        id,
        username,
        role: 'user',
        status: 'active',
        created_at: new Date().toISOString(),
        // A just-created user has no active sessions yet.
        isConnected: false,
        amountOfDevices: 0,
        amountOfSessions: 0,
      },
      201,
    );
  });

  // List all users
  app.get('/users', async (c) => {
    const db = getDatabase();
    const users = db
      .query<
        { id: string; username: string; role: string; status: string; created_at: string },
        []
      >("SELECT id, username, role, COALESCE(status, 'active') as status, created_at FROM users ORDER BY created_at ASC")
      .all();

    // Merge ephemeral presence (in-memory) into each row; absent users read as offline.
    const active = presenceService.getActiveUsers();
    const enriched = users.map((u) => {
      const p = active.get(u.id) ?? {
        isConnected: false,
        amountOfDevices: 0,
        amountOfSessions: 0,
      };
      return { ...u, ...p };
    });
    return c.json(enriched);
  });

  // Toggle user role
  app.put('/users/:id/role', async (c) => {
    const { id } = c.req.param();
    const { role } = await c.req.json<{ role: Role }>();
    const currentUser = c.get('user');

    if (id === currentUser.sub) {
      return c.json({ error: 'Cannot change your own role' }, 400);
    }

    if (!ROLES.includes(role)) {
      return c.json({ error: `Role must be one of: ${ROLES.join(', ')}` }, 400);
    }

    const db = getDatabase();
    const result = db.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
    if (result.changes === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Enable/disable user
  app.put('/users/:id/status', async (c) => {
    const { id } = c.req.param();
    const { status } = await c.req.json<{ status: 'active' | 'disabled' }>();
    const currentUser = c.get('user');

    if (id === currentUser.sub) {
      return c.json({ error: 'Cannot disable your own account' }, 400);
    }

    if (status !== 'active' && status !== 'disabled') {
      return c.json({ error: 'Status must be "active" or "disabled"' }, 400);
    }

    const db = getDatabase();
    const result = db.run('UPDATE users SET status = ? WHERE id = ?', [status, id]);
    if (result.changes === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Reset user password
  app.put('/users/:id/password', async (c) => {
    const { id } = c.req.param();
    const { password } = await c.req.json<{ password: string }>();

    if (!password || password.length < 4) {
      return c.json({ error: 'Password must be at least 4 characters' }, 400);
    }

    const db = getDatabase();
    const passwordHash = await hashPassword(password);
    const result = db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
    if (result.changes === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Delete user
  app.delete('/users/:id', async (c) => {
    const { id } = c.req.param();
    const currentUser = c.get('user');

    if (id === currentUser.sub) {
      return c.json({ error: 'Cannot delete your own account' }, 400);
    }

    const db = getDatabase();
    const result = db.run('DELETE FROM users WHERE id = ?', [id]);
    if (result.changes === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Standardize the existing library's lossless files on Opus (storage + uniform
  // codec). Long-running; runs to completion and returns the summary. `?dryRun=1`
  // reports candidates without writing.
  app.post('/transcode-library', async (c) => {
    const dryRun = c.req.query('dryRun') === '1' || c.req.query('dryRun') === 'true';
    try {
      const result = await transcodeLibraryToOpus(getDatabase(), deps.musicDir, { apply: !dryRun });
      return c.json({ ok: true, dryRun, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Transcode failed' }, 503);
    }
  });

  // Library-wide metadata optimization: re-fetch better cover/year/release-type
  // from Lidarr. `?all=1` re-verifies every album; default targets albums with
  // missing artwork or year. `?dryRun=1` reports without writing.
  app.post('/metadata-optimize', async (c) => {
    if (!deps.lidarr) return c.json({ error: 'Lidarr not configured' }, 503);
    const dryRun = c.req.query('dryRun') === '1' || c.req.query('dryRun') === 'true';
    const onlyMissingOrPoor = !(c.req.query('all') === '1' || c.req.query('all') === 'true');
    const result = await optimizeAllAlbums(getDatabase(), deps.lidarr, {
      apply: !dryRun,
      coverCacheDir: deps.coverCacheDir,
      onlyMissingOrPoor,
    });
    return c.json({ ok: true, dryRun, ...result });
  });

  // --- Windowed library processing (BPM / genre enrichment) ----------------

  const requireProcessing = (): LibraryProcessingService | null => deps.processing ?? null;

  // Current settings + a fresh status snapshot (pending counts, availability).
  app.get('/processing', (c) => {
    const svc = requireProcessing();
    if (!svc) return c.json({ error: 'Library processing not available' }, 503);
    return c.json(svc.getState());
  });

  // Update settings (window, enable, per-task flags, batch/concurrency).
  app.put('/processing', async (c) => {
    const svc = requireProcessing();
    if (!svc) return c.json({ error: 'Library processing not available' }, 503);
    const body = await c.req.json<Partial<ProcessingSettings>>();
    if (body.window) {
      const { start, end } = body.window;
      if (
        (start !== undefined && parseHhMm(start) === null) ||
        (end !== undefined && parseHhMm(end) === null)
      ) {
        return c.json({ error: 'window.start/end must be HH:MM' }, 400);
      }
    }
    if (body.batchSize !== undefined && (!Number.isInteger(body.batchSize) || body.batchSize < 1)) {
      return c.json({ error: 'batchSize must be a positive integer' }, 400);
    }
    if (
      body.concurrency !== undefined &&
      (!Number.isInteger(body.concurrency) || body.concurrency < 1)
    ) {
      return c.json({ error: 'concurrency must be a positive integer' }, 400);
    }
    // gates is a sparse per-task boolean map ("require before landing"); reject a
    // malformed value so a bad client can't poison the persisted JSON blob.
    if (body.gates !== undefined) {
      const ok =
        body.gates !== null &&
        typeof body.gates === 'object' &&
        !Array.isArray(body.gates) &&
        Object.values(body.gates).every((v) => typeof v === 'boolean');
      if (!ok) return c.json({ error: 'gates must be a map of task→boolean' }, 400);
    }
    const settings = setProcessingSettings(getDatabase(), body);
    return c.json({ settings, status: svc.getState().status });
  });

  // Quarantine queue: songs scanned but not yet added to the library (their
  // required processing steps haven't finished), grouped by album with per-step
  // badges — the "control which steps a download has been through" surface.
  app.get('/processing/queue', (c) => {
    const svc = requireProcessing();
    if (!svc) return c.json({ error: 'Library processing not available' }, 503);
    return c.json({ albums: loadQuarantineQueue(getDatabase()) });
  });

  // Drain pending work now, ignoring the time window (fire-and-forget).
  app.post('/processing/run', (c) => {
    const svc = requireProcessing();
    if (!svc) return c.json({ error: 'Library processing not available' }, 503);
    void svc.runNow();
    return c.json({ ok: true });
  });

  // Abort the current run without disabling the scheduler.
  app.post('/processing/stop', (c) => {
    const svc = requireProcessing();
    if (!svc) return c.json({ error: 'Library processing not available' }, 503);
    svc.cancelRun();
    return c.json({ ok: true });
  });

  // SSE: push a status snapshot on every change (progress bar + live snippets).
  app.get('/processing/stream', (c) => {
    const svc = requireProcessing();
    if (!svc) return c.json({ error: 'Library processing not available' }, 503);
    return streamSSE(c, async (stream) => {
      const send = (status: ProcessingStatus) =>
        void stream.writeSSE({ data: JSON.stringify(status) }).catch(() => {});
      // Prime with the current snapshot, then stream updates.
      send(svc.getState().status);
      const onStatus = (status: ProcessingStatus) => send(status);
      svc.on('status', onStatus);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          svc.off('status', onStatus);
          resolve();
        });
      });
    });
  });

  return app;
}
