/**
 * Browser-upload import lane, mounted at `/api/import` (docs/import.md).
 *
 * Deliberately separate from `/api/admin/import`, which keeps its server-path,
 * admin-only contract untouched. Two differences carry the whole design:
 *
 * - **`requireAcquirer`, not `requireAdmin`.** Anyone who can add music can add
 *   it from their own machine.
 * - **Mounted outside `requireAcquisitionEnabledMiddleware`.** A streaming-only
 *   install (`NICOTIND_ACQUISITION=off`) has no acquisition stack and is exactly
 *   the deployment most likely to need to fill its library from a folder.
 */
import { Hono, type Context } from 'hono';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAcquirer } from '../middleware/current-user.js';
import { recordAudit } from '../services/audit-log.js';
import {
  IMPORT_UPLOAD_CHUNK_BYTES,
  UploadEmptyManifestError,
  UploadPathRejectedError,
  UploadTooLargeError,
  type ImportUploadService,
  type UploadManifestFile,
} from '../services/import-upload.service.js';
import type { LibraryImportService } from '../services/library-import.service.js';
import { importErrorResponse } from './import.js';

interface Deps {
  db: Database;
  uploads: ImportUploadService;
  imports: LibraryImportService;
}

/** A client-supplied manifest is untrusted shape as well as untrusted content. */
function parseManifest(body: unknown): UploadManifestFile[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const out: UploadManifestFile[] = [];
  for (const f of files) {
    if (typeof f !== 'object' || f === null) return null;
    const { path, size } = f as { path?: unknown; size?: unknown };
    if (typeof path !== 'string' || !path.trim()) return null;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
    out.push({ path, size });
  }
  return out;
}

export function importUploadRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();

  app.post('/uploads', async (c) => {
    const user = requireAcquirer(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Expected a JSON body', code: 'VALIDATION_ERROR' }, 400);
    }
    const files = parseManifest(body);
    if (!files) {
      return c.json({ error: 'Expected files: [{ path, size }]', code: 'VALIDATION_ERROR' }, 400);
    }
    try {
      const res = deps.uploads.create(user.sub, files);
      return c.json(res, 201);
    } catch (err) {
      return uploadErrorResponse(c, err);
    }
  });

  // Raw body, streamed to disk. `path` and `offset` ride the query string so the
  // body stays exactly the bytes — no multipart framing to buffer or parse.
  app.put('/uploads/:id/chunk', async (c) => {
    requireAcquirer(c);
    const path = c.req.query('path');
    const rawOffset = c.req.query('offset');
    const offset = Number(rawOffset);
    if (!path || rawOffset === undefined || !Number.isInteger(offset) || offset < 0) {
      return c.json(
        { error: 'Expected ?path= and a non-negative ?offset=', code: 'VALIDATION_ERROR' },
        400,
      );
    }
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'Expected a body', code: 'VALIDATION_ERROR' }, 400);
    try {
      const received = await deps.uploads.writeChunk(c.req.param('id'), path, offset, body);
      return c.json({ received }, 200);
    } catch (err) {
      return uploadErrorResponse(c, err);
    }
  });

  app.get('/uploads/:id', (c) => {
    requireAcquirer(c);
    const state = deps.uploads.state(c.req.param('id'));
    if (!state) return c.json({ error: 'Upload session not found', code: 'NOT_FOUND' }, 404);
    return c.json({ ...state, chunkBytes: IMPORT_UPLOAD_CHUNK_BYTES }, 200);
  });

  app.post('/uploads/:id/commit', (c) => {
    const user = requireAcquirer(c);
    const id = c.req.param('id');
    if (!deps.uploads.state(id)) {
      return c.json({ error: 'Upload session not found', code: 'NOT_FOUND' }, 404);
    }
    try {
      const jobId = deps.imports.submitStaged(deps.uploads.sessionDir(id), { startedBy: user.sub });
      deps.uploads.markCommitted(id, jobId);
      recordAudit(deps.db, user, 'library.import.upload', {
        targetKind: 'upload',
        targetId: id,
        detail: jobId,
      });
      return c.json({ jobId }, 202);
    } catch (err) {
      return uploadErrorResponse(c, err);
    }
  });

  app.delete('/uploads/:id', (c) => {
    requireAcquirer(c);
    const ok = deps.uploads.abort(c.req.param('id'));
    if (!ok) return c.json({ error: 'Upload session not found', code: 'NOT_FOUND' }, 404);
    return c.json({ ok: true }, 200);
  });

  return app;
}

/** Upload-specific arms first, then the shared import mapping table. */
function uploadErrorResponse(c: Context<AuthEnv>, err: unknown) {
  if (err instanceof UploadPathRejectedError || err instanceof UploadEmptyManifestError) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
  if (err instanceof UploadTooLargeError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        requiredBytes: err.requiredBytes,
        freeBytes: err.freeBytes,
      },
      507,
    );
  }
  return importErrorResponse(c, err);
}
