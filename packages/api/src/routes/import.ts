import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/current-user.js';
import { recordAudit } from '../services/audit-log.js';
import { ArchiveError } from '../services/import-archive.js';
import {
  ImportAlreadyRunningError,
  ImportEmptySourceError,
  ImportInsufficientSpaceError,
  ImportSourceInvalidError,
  ImportTooLargeError,
  type LibraryImportService,
} from '../services/library-import.service.js';

/**
 * Admin folder-import routes (docs/import.md). Mounted under
 * /api/admin/import so the blanket /api/admin/* auth applies; every handler
 * additionally requires admin — a server-side path walk + bulk library write
 * is server-admin territory. Deliberately NOT behind the acquisition
 * kill-switch: streaming-only installs are the likeliest importers.
 */
export function importRoutes(deps: { db: Database; service: LibraryImportService }) {
  const { db, service } = deps;
  const app = new Hono<AuthEnv>();

  app.post('/preview', async (c) => {
    requireAdmin(c);
    const body = await c.req.json<{ path?: string }>().catch(() => ({}) as { path?: string });
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      return c.json({ error: 'path is required', code: 'VALIDATION_ERROR' }, 400);
    }
    try {
      return c.json(service.preview(body.path));
    } catch (err) {
      return importErrorResponse(c, err);
    }
  });

  app.post('/', async (c) => {
    const user = requireAdmin(c);
    const body = await c.req
      .json<{ path?: string; removeOriginals?: boolean }>()
      .catch(() => ({}) as { path?: string; removeOriginals?: boolean });
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      return c.json({ error: 'path is required', code: 'VALIDATION_ERROR' }, 400);
    }
    try {
      const jobId = service.submit(body.path, {
        removeOriginals: body.removeOriginals === true,
        startedBy: user.sub,
      });
      recordAudit(db, user, 'library.import.start', {
        targetKind: 'path',
        targetId: body.path,
        detail: body.removeOriginals === true ? 'move' : 'copy',
      });
      return c.json({ jobId }, 202);
    } catch (err) {
      return importErrorResponse(c, err);
    }
  });

  app.get('/jobs', (c) => {
    requireAdmin(c);
    return c.json({ jobs: service.listJobs() });
  });

  app.get('/jobs/:id', (c) => {
    requireAdmin(c);
    const job = service.getJob(c.req.param('id'));
    if (!job) return c.json({ error: 'Import job not found', code: 'NOT_FOUND' }, 404);
    return c.json({ job, dirs: service.getJobDirs(job.id) });
  });

  app.post('/jobs/:id/cancel', (c) => {
    const user = requireAdmin(c);
    const id = c.req.param('id');
    if (!service.getJob(id)) {
      return c.json({ error: 'Import job not found', code: 'NOT_FOUND' }, 404);
    }
    const ok = service.cancel(id);
    if (ok) {
      recordAudit(db, user, 'library.import.cancel', { targetKind: 'importJob', targetId: id });
    }
    return c.json({ ok });
  });

  app.post('/jobs/:id/retry', (c) => {
    requireAdmin(c);
    try {
      const jobId = service.retry(c.req.param('id'));
      if (!jobId) return c.json({ error: 'Import job not found', code: 'NOT_FOUND' }, 404);
      return c.json({ jobId }, 202);
    } catch (err) {
      return importErrorResponse(c, err);
    }
  });

  app.delete('/jobs/:id', (c) => {
    requireAdmin(c);
    const ok = service.delete(c.req.param('id'));
    if (!ok) {
      return c.json({ error: 'Import job not found or still running', code: 'NOT_FOUND' }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}

/** Map the service's typed errors onto HTTP; unknown errors rethrow to the global handler.
 *  Exported so the upload lane (`import-upload.ts`) reuses one mapping table. */
export function importErrorResponse(c: Context<AuthEnv>, err: unknown) {
  if (err instanceof ImportSourceInvalidError) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
  // An archive is only opened during the scan, so its four typed rejections
  // (unreadable / encrypted / unsupported / too large) surface as `ArchiveError`
  // rather than through `validateImportSource` — which is extension-only and
  // cannot know. Without this arm every one of them fell through as an unknown
  // error: a 500 "Internal server error" plus a Sentry event, for a password
  // -protected zip the operator simply needs to be told about.
  if (err instanceof ArchiveError) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
  if (err instanceof ImportEmptySourceError) {
    return c.json({ error: err.message, code: 'EMPTY_SOURCE' }, 400);
  }
  if (err instanceof ImportTooLargeError) {
    return c.json({ error: err.message, code: 'TOO_LARGE' }, 400);
  }
  if (err instanceof ImportAlreadyRunningError) {
    return c.json({ error: err.message, code: 'IMPORT_RUNNING' }, 409);
  }
  if (err instanceof ImportInsufficientSpaceError) {
    return c.json(
      {
        error: err.message,
        code: 'INSUFFICIENT_SPACE',
        requiredBytes: err.requiredBytes,
        freeBytes: err.freeBytes,
      },
      507,
    );
  }
  throw err;
}
