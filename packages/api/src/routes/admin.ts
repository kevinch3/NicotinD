import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { hashPassword, ROLES } from '@nicotind/core';
import type { ProcessingSettings, ProcessingStatus, Role } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import { listAudit, recordAudit } from '../services/audit-log.js';
import type { AcquisitionToggle } from '../services/acquisition-toggle.js';
import {
  getInstanceHistoryEnabled,
  getRetentionDays,
  setInstanceHistoryEnabled,
  setRetentionDays,
} from '../services/privacy.js';
import { playEventCount } from '../services/play-history.js';
import { listBackups, runBackup } from '../services/backup.js';
import {
  exportConfig,
  importConfig,
  previewImport,
  validateBundle,
  type ConfigBundle,
} from '../services/config-export.js';
import {
  getAutoPlaylistStatus,
  runAutoPlaylistsNow,
  setAutoPlaylistCadence,
} from '../services/auto-playlists.service.js';
import {
  checkForUpdateNow,
  compareVersions,
  getStoredUpdateCheck,
  listVersionHistory,
} from '../services/update-check.js';
import { setProcessingSettings } from '../services/processing-settings.js';
import { loadQuarantineQueue } from '../services/song-steps.js';
import { presenceService } from '../services/presence.js';
import type { LibraryProcessingService } from '../services/library-processing.service.js';
import type { MaintenanceService } from '../services/maintenance/maintenance.service.js';
import type { MaintenanceTaskId } from '../services/maintenance/tasks.js';

export interface AdminRoutesDeps {
  musicDir: string;
  /** Expanded data dir (backups live under `<dataDir>/backups`); backup routes 503 without it. */
  dataDir?: string;
  /** Windowed library-processing scheduler; null when not wired (503s). */
  processing?: LibraryProcessingService | null;
  /** Operator-triggered whole-library passes (issue #622); null → those routes 503. */
  maintenance?: MaintenanceService | null;
  /** Running server version (package.json), for the update-check route. */
  version?: string;
  /** Runtime acquisition kill-switch (issue #235); absent → the routes 503. */
  acquisition?: AcquisitionToggle | null;
  /** Env-level listening-history floor (issue #454); absent → treated as on. */
  historyEnabled?: () => boolean;
}

/** The subset of an admin user row the activity ordering reads. */
export interface UserActivityOrderable {
  isConnected: boolean;
  last_seen_at: number | null;
  created_at: string;
}

/**
 * Order the admin user list by usefulness rather than signup date: currently
 * connected first, then most-recently-seen, then oldest account. A user who has
 * never connected (`last_seen_at` NULL) sorts last within the offline group
 * rather than first — NULL is "unknown", not "infinitely long ago".
 *
 * Pure and exported so the ordering is unit-testable without an HTTP round-trip.
 */
export function compareUsersByActivity(a: UserActivityOrderable, b: UserActivityOrderable): number {
  if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
  if (a.last_seen_at !== b.last_seen_at) {
    if (a.last_seen_at === null) return 1;
    if (b.last_seen_at === null) return -1;
    return b.last_seen_at - a.last_seen_at;
  }
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
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
    recordAudit(db, c.get('user'), 'user.create', {
      targetKind: 'user',
      targetId: id,
      detail: username,
    });

    // Read created_at back rather than minting an ISO string: the column default is
    // SQLite's datetime('now') ("YYYY-MM-DD HH:MM:SS", no T/Z) and the web's
    // formatDate() appends a "Z" to it. An ISO string here produced "…ZZ", i.e. an
    // Invalid Date in the Joined line of a freshly created row.
    const created = db
      .query<{ created_at: string }, [string]>('SELECT created_at FROM users WHERE id = ?')
      .get(id);

    return c.json(
      {
        id,
        username,
        role: 'user',
        status: 'active',
        created_at: created!.created_at,
        // A just-created user has never connected and has no active sessions yet.
        last_seen_at: null,
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
        {
          id: string;
          username: string;
          role: string;
          status: string;
          created_at: string;
          last_seen_at: number | null;
        },
        []
      >(
        "SELECT id, username, role, COALESCE(status, 'active') as status, created_at, last_seen_at FROM users ORDER BY created_at ASC",
      )
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
    // Sort after the merge, not in SQL: `isConnected` lives in the in-memory
    // presence map, which SQL cannot see. The SELECT's created_at ASC is the
    // stable base the comparator falls through to.
    enriched.sort(compareUsersByActivity);
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
    recordAudit(db, currentUser, 'user.role', { targetKind: 'user', targetId: id, detail: role });
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
    recordAudit(db, currentUser, 'user.status', {
      targetKind: 'user',
      targetId: id,
      detail: status,
    });
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
    recordAudit(db, c.get('user'), 'user.password-reset', { targetKind: 'user', targetId: id });
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
    recordAudit(db, currentUser, 'user.delete', { targetKind: 'user', targetId: id });
    return c.json({ ok: true });
  });

  // Standardize the existing library's lossless files on Opus (storage + uniform
  // codec). A background pass since issue #622 — 202 here, progress on
  // /api/admin/review. `?dryRun=1` reports candidates without writing.
  app.post('/transcode-library', (c) => startMaintenance(c, 'transcode-library'));

  // Library-wide metadata optimization: re-fetch better cover/year/release-type
  // from Lidarr. `?all=1` re-verifies every album; default targets albums with
  // missing artwork or year. `?dryRun=1` reports without writing. Backgrounded
  // (issue #622): this was albums x a 20s lookup, awaited inside the handler.
  app.post('/metadata-optimize', (c) => startMaintenance(c, 'metadata-optimize'));

  // --- Audit log (services/audit-log.ts) ------------------------------------

  // Recent destructive/curation actions, newest first. ?limit=&offset= paginate.
  app.get('/audit', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const offset = Number(c.req.query('offset') ?? 0);
    return c.json(
      listAudit(getDatabase(), {
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      }),
    );
  });

  // --- Update check + version history (services/update-check.ts) -----------

  // Cached update-check result vs the running version, plus every version this
  // server has ever booted. `?refresh=1` forces a GitHub poll (the "Check now"
  // button); the plain GET never phones home.
  app.get('/update-check', async (c) => {
    const db = getDatabase();
    if (c.req.query('refresh') === '1') await checkForUpdateNow(db);
    const stored = getStoredUpdateCheck(db);
    const current = deps.version ?? 'unknown';
    const latest = stored?.latestVersion ?? null;
    return c.json({
      currentVersion: current,
      latestVersion: latest,
      updateAvailable:
        latest !== null && current !== 'unknown' && compareVersions(latest, current) > 0,
      checkedAt: stored?.checkedAt ?? null,
      releaseUrl: stored?.releaseUrl ?? null,
      versionHistory: listVersionHistory(db),
    });
  });

  // --- Backups (see services/backup.ts + docs/backup-restore.md) -----------

  // List existing backups, newest first.
  app.get('/backups', (c) => {
    if (!deps.dataDir) return c.json({ error: 'Backups not available' }, 503);
    return c.json(listBackups(deps.dataDir));
  });

  // Take a backup now (also prunes to the keep count).
  app.post('/backups', (c) => {
    if (!deps.dataDir) return c.json({ error: 'Backups not available' }, 503);
    try {
      const info = runBackup(getDatabase(), { dataDir: deps.dataDir });
      return c.json(info, 201);
    } catch (err) {
      return c.json({ error: `Backup failed: ${err instanceof Error ? err.message : err}` }, 500);
    }
  });

  // --- Configuration export / import (see services/config-export.ts) --------

  // Portable config artifact. Credentials are redacted unless `?secrets=1`, so
  // the default download is safe to hand around; migrating a host needs the
  // opt-in. Served as an attachment so a browser saves rather than renders it.
  app.get('/config/export', (c) => {
    const includeSecrets = c.req.query('secrets') === '1';
    const bundle = exportConfig(getDatabase(), { includeSecrets, appVersion: deps.version });
    recordAudit(getDatabase(), c.get('user'), 'config.export', {
      detail: includeSecrets ? 'including secrets' : 'secrets redacted',
    });
    const stamp = new Date().toISOString().slice(0, 10);
    c.header('Content-Disposition', `attachment; filename="nicotind-config-${stamp}.json"`);
    return c.json(bundle);
  });

  // Apply a bundle, or (dryRun) report what it would change. The preview runs
  // the same reconciliation as the apply, so the two can't disagree.
  app.post('/config/import', async (c) => {
    let body: { bundle?: unknown; dryRun?: boolean };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }

    const invalid = validateBundle(body.bundle);
    if (invalid) return c.json({ error: invalid }, 400);
    const bundle = body.bundle as ConfigBundle;
    const db = getDatabase();

    if (body.dryRun) return c.json({ dryRun: true, plan: previewImport(db, bundle) });

    try {
      const plan = importConfig(db, bundle);
      const total = plan.sections.reduce((n, s) => n + s.create + s.update, 0);
      recordAudit(db, c.get('user'), 'config.import', {
        detail: `${total} row(s) across ${plan.sections.length} section(s)`,
      });
      return c.json({ dryRun: false, plan });
    } catch (err) {
      return c.json({ error: `Import failed: ${err instanceof Error ? err.message : err}` }, 500);
    }
  });

  // --- Automated playlists (see services/auto-playlists.service.ts) ---------

  // Current cadence + last-refresh timestamp for the Admin control.
  // ─── Acquisition kill-switch (issue #235) ────────────────────────────────
  // `enabled` is the effective value; `configurable` is false when the
  // ENVIRONMENT disabled acquisition, in which case the toggle is a hard floor
  // an admin cannot lift and the UI should render it read-only rather than
  // offering a control that silently does nothing.
  app.get('/acquisition', (c) => {
    const t = deps.acquisition;
    if (!t) return c.json({ error: 'Acquisition toggle not wired' }, 503);
    return c.json({ enabled: t.enabled(), configurable: t.configurable() });
  });

  app.put('/acquisition', async (c) => {
    const t = deps.acquisition;
    if (!t) return c.json({ error: 'Acquisition toggle not wired' }, 503);
    const body = await c.req
      .json<{ enabled?: unknown }>()
      .catch(() => ({}) as { enabled?: unknown });
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    const effective = t.set(body.enabled);
    recordAudit(getDatabase(), c.get('user'), 'acquisition.toggle', {
      detail: `requested=${body.enabled} effective=${effective}`,
    });
    return c.json({ enabled: effective, configurable: t.configurable() });
  });

  // ─── Listening-history privacy controls (issue #454) ─────────────────────
  // `configurable` is false when the ENVIRONMENT disabled history, mirroring
  // the acquisition switch: a hard floor an admin cannot lift, rendered
  // read-only rather than as a control that silently does nothing.
  app.get('/history-privacy', (c) => {
    const db = getDatabase();
    const envEnabled = deps.historyEnabled?.() ?? true;
    return c.json({
      enabled: envEnabled && getInstanceHistoryEnabled(db) !== false,
      configurable: envEnabled,
      retentionDays: getRetentionDays(db),
      totalEvents: playEventCount(db),
    });
  });

  app.put('/history-privacy', async (c) => {
    const db = getDatabase();
    const envEnabled = deps.historyEnabled?.() ?? true;
    const body = await c.req
      .json<{ enabled?: unknown; retentionDays?: unknown }>()
      .catch(() => ({}) as { enabled?: unknown; retentionDays?: unknown });

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json({ error: 'enabled must be a boolean', code: 'VALIDATION_ERROR' }, 400);
      }
      if (!envEnabled && body.enabled) {
        return c.json({ error: 'History is disabled for this deployment', code: 'FORBIDDEN' }, 403);
      }
      setInstanceHistoryEnabled(db, body.enabled);
    }

    if (body.retentionDays !== undefined) {
      const days = Number(body.retentionDays);
      if (!Number.isFinite(days) || days < 0) {
        return c.json({ error: 'retentionDays must be >= 0', code: 'VALIDATION_ERROR' }, 400);
      }
      setRetentionDays(db, days);
    }

    recordAudit(db, c.get('user'), 'privacy.instance.update', {
      detail: `enabled=${String(body.enabled)} retentionDays=${String(body.retentionDays)}`,
    });
    return c.json({
      enabled: envEnabled && getInstanceHistoryEnabled(db) !== false,
      configurable: envEnabled,
      retentionDays: getRetentionDays(db),
      totalEvents: playEventCount(db),
    });
  });

  app.get('/playlists/auto', (c) => c.json(getAutoPlaylistStatus(getDatabase())));

  // Change the refresh cadence (off / daily / weekly). Persisted; read by the
  // in-process guard on the next processor tick.
  app.put('/playlists/auto', async (c) => {
    const body = await c.req.json<{ cadence?: string }>().catch(() => ({}) as { cadence?: string });
    const db = getDatabase();
    if (!setAutoPlaylistCadence(db, String(body.cadence))) {
      return c.json({ error: 'cadence must be off | daily | weekly' }, 400);
    }
    recordAudit(db, c.get('user'), 'auto_playlists.cadence', { detail: String(body.cadence) });
    return c.json(getAutoPlaylistStatus(db));
  });

  // Force an immediate regeneration now, bypassing the period guard.
  app.post('/playlists/auto/refresh', (c) => {
    const db = getDatabase();
    try {
      const results = runAutoPlaylistsNow(db, Date.now());
      recordAudit(db, c.get('user'), 'auto_playlists.refresh', {
        detail: `${results.length} shelves`,
      });
      return c.json({ shelves: results, ...getAutoPlaylistStatus(db) });
    } catch (err) {
      return c.json({ error: `Refresh failed: ${err instanceof Error ? err.message : err}` }, 503);
    }
  });

  // --- Windowed library processing (BPM / genre enrichment) ----------------

  const requireProcessing = (): LibraryProcessingService | null => deps.processing ?? null;

  // Current settings + a fresh status snapshot (pending counts, availability).
  app.get('/processing', (c) => {
    const svc = requireProcessing();
    if (!svc) return c.json({ error: 'Library processing not available' }, 503);
    return c.json(svc.getState());
  });

  // Update settings (enable, pause, per-task flags, landing gates, hold-for-review).
  app.put('/processing', async (c) => {
    const svc = requireProcessing();
    if (!svc) return c.json({ error: 'Library processing not available' }, 503);
    const body = await c.req.json<Partial<ProcessingSettings>>();
    if (body.paused !== undefined && typeof body.paused !== 'boolean') {
      return c.json({ error: 'paused must be a boolean' }, 400);
    }
    if (body.holdForReview !== undefined && typeof body.holdForReview !== 'boolean') {
      return c.json({ error: 'holdForReview must be a boolean' }, 400);
    }
    // Issue #416: with acquisition off the Downloads page (and the review inbox
    // on it) is hidden, but a manual file drop still scans — enabling the hold
    // would strand those files quarantined with no reachable inbox. The landing
    // gate also ignores the flag while acquisition is off (belt), but denying
    // the enable (braces) tells the admin *why* instead of silently no-opping.
    if (body.holdForReview === true && deps.acquisition && !deps.acquisition.enabled()) {
      return c.json(
        {
          error:
            'Hold for review requires acquisition to be enabled — with acquisition off the ' +
            'Downloads page (and its review inbox) is hidden, so held files would be unreachable',
        },
        400,
      );
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

  // --- Maintenance passes (issue #622) --------------------------------------
  // Whole-library operator actions used to run to completion inside the request
  // handler; metadata-optimize was albums x 20s of Lidarr lookups, unbounded.
  // They are background jobs now: 202 here, progress on GET /api/admin/review.
  function startMaintenance(c: Context<AuthEnv>, task: MaintenanceTaskId) {
    const svc = deps.maintenance;
    if (!svc) return c.json({ error: 'Maintenance is not available' }, 503);
    const q = new URL(c.req.url).searchParams;
    const outcome = svc.start(task, q, c.get('user').username);
    if (outcome === 'unknown-task') return c.json({ error: `Unknown task ${task}` }, 404);
    if (outcome === 'unavailable') {
      const why = svc.availability()[task];
      return c.json({ error: typeof why === 'string' ? why : 'Task unavailable' }, 503);
    }
    if (outcome === 'busy') {
      return c.json(
        { error: 'A maintenance pass is already running', code: 'MAINTENANCE_RUNNING' },
        409,
      );
    }
    const status = svc.getStatus();
    // One row per pass, never per item: audit-log.ts rules out blanket
    // per-mutation logging, and a 20k-album pass would drown the ledger.
    recordAudit(getDatabase(), c.get('user'), 'maintenance.start', {
      targetKind: 'library',
      targetId: task,
      detail: status.params ?? undefined,
    });
    return c.json({ ok: true, started: true, status }, 202);
  }

  app.post('/maintenance/cancel', (c) => {
    const svc = deps.maintenance;
    if (!svc) return c.json({ error: 'Maintenance is not available' }, 503);
    const ok = svc.cancel();
    // Audit only a cancel that actually stopped something.
    if (ok) {
      recordAudit(getDatabase(), c.get('user'), 'maintenance.cancel', {
        targetKind: 'library',
        targetId: svc.getStatus().taskId ?? undefined,
      });
    }
    return c.json({ ok });
  });

  // A cheap dedicated poll target, unlike the many-sub-fetch /admin/review.
  app.get('/maintenance/status', (c) => {
    const svc = deps.maintenance;
    if (!svc) return c.json({ error: 'Maintenance is not available' }, 503);
    return c.json(svc.getStatus());
  });

  // Registered last on purpose: `:task` is a wildcard, so it would otherwise
  // shadow /maintenance/cancel and /maintenance/status above it.
  app.post('/maintenance/:task', (c) =>
    startMaintenance(c, c.req.param('task') as MaintenanceTaskId),
  );

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
