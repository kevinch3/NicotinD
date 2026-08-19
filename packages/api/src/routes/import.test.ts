import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { Role } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { applySchema } from '../db.js';
import { listAudit } from '../services/audit-log.js';
import { ArchiveError } from '../services/import-archive.js';
import {
  ImportAlreadyRunningError,
  ImportInsufficientSpaceError,
  ImportSourceInvalidError,
  type LibraryImportService,
} from '../services/library-import.service.js';
import { importRoutes } from './import.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

const sampleJob = {
  id: 'job-1',
  sourcePath: '/mnt/imports',
  removeOriginals: false,
  state: 'running',
  stage: 'organizing',
  error: null,
  filesTotal: 10,
  filesDone: 3,
  bytesTotal: 100,
  currentDir: 'A',
  summary: null,
  destinationAlbums: [],
  startedBy: 'admin-1',
  createdAt: 1,
  updatedAt: 2,
};

function makeMockService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    submitted: [] as Array<{ path: string; opts: unknown }>,
    preview(path: string) {
      if (path === '/bad') throw new ImportSourceInvalidError('NOT_FOUND');
      if (path === '/locked.zip') {
        throw new ArchiveError('ARCHIVE_ENCRYPTED', 'That archive is password-protected.');
      }
      return { sourcePath: path, files: 3 };
    },
    submit(path: string, opts: unknown) {
      if (path === '/bad') throw new ImportSourceInvalidError('INSIDE_LIBRARY');
      if (path === '/busy') throw new ImportAlreadyRunningError();
      if (path === '/full') throw new ImportInsufficientSpaceError(1000, 10);
      if (path === '/broken.zip') {
        throw new ArchiveError('ARCHIVE_UNREADABLE', 'That file is not a readable ZIP archive.');
      }
      this.submitted.push({ path, opts });
      return 'job-new';
    },
    getJob(id: string) {
      return id === 'job-1' ? sampleJob : null;
    },
    getJobDirs() {
      return [{ sourceDir: 'A', fileCount: 10, state: 'pending', error: null }];
    },
    listJobs() {
      return [sampleJob];
    },
    cancel(id: string) {
      return id === 'job-1';
    },
    retry(id: string) {
      return id === 'job-1' ? 'job-1' : null;
    },
    delete(id: string) {
      return id === 'job-1';
    },
    ...overrides,
  };
}

type MockService = ReturnType<typeof makeMockService>;

function makeApp(service: MockService, role: Role = 'admin') {
  const app = new Hono<AuthEnv>();
  app.onError(errorHandler);
  app.use('*', (c, next) => {
    c.set('user', { sub: 'admin-1', username: 'boss', role, iat: 0, exp: 9999999999 });
    return next();
  });
  app.route('/', importRoutes({ db, service: service as unknown as LibraryImportService }));
  return app;
}

function post(app: Hono<AuthEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('import routes', () => {
  it('rejects non-admins on every endpoint', async () => {
    const app = makeApp(makeMockService(), 'refiner');
    for (const [method, path, body] of [
      ['POST', '/preview', { path: '/x' }],
      ['POST', '/', { path: '/x' }],
      ['GET', '/jobs', undefined],
      ['GET', '/jobs/job-1', undefined],
      ['POST', '/jobs/job-1/cancel', {}],
      ['POST', '/jobs/job-1/retry', {}],
      ['DELETE', '/jobs/job-1', undefined],
    ] as const) {
      const res = await app.request(path, {
        method,
        ...(body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      expect(res.status).toBe(403);
    }
  });

  it('preview validates the path field and maps source errors to 400 + code', async () => {
    const app = makeApp(makeMockService());
    expect((await post(app, '/preview', {})).status).toBe(400);
    const bad = await post(app, '/preview', { path: '/bad' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('NOT_FOUND');
    const ok = await post(app, '/preview', { path: '/mnt/imports' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).files).toBe(3);
  });

  /**
   * An archive is only opened during the scan, so its rejections arrive as
   * `ArchiveError` rather than through the extension-only `validateImportSource`.
   * Without a route arm for it, a password-protected zip answered
   * 500 "Internal server error" and filed a Sentry event — and the four
   * user-facing ARCHIVE_* messages were unreachable dead code.
   */
  it('maps an archive rejection to 400 + its typed code, not a 500', async () => {
    const app = makeApp(makeMockService());
    const locked = await post(app, '/preview', { path: '/locked.zip' });
    expect(locked.status).toBe(400);
    expect(await locked.json()).toMatchObject({
      code: 'ARCHIVE_ENCRYPTED',
      error: 'That archive is password-protected.',
    });

    const broken = await post(app, '/', { path: '/broken.zip' });
    expect(broken.status).toBe(400);
    expect((await broken.json()).code).toBe('ARCHIVE_UNREADABLE');
  });

  it('submit returns 202 with the job id and records an audit row', async () => {
    const service = makeMockService();
    const app = makeApp(service);
    const res = await post(app, '/', { path: '/mnt/imports', removeOriginals: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: 'job-new' });
    expect(service.submitted[0]).toEqual({
      path: '/mnt/imports',
      opts: { removeOriginals: true, startedBy: 'admin-1' },
    });
    const audit = listAudit(db);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'library.import.start',
      targetKind: 'path',
      targetId: '/mnt/imports',
      detail: 'move',
      userId: 'admin-1',
    });
  });

  it('submit maps busy → 409 and insufficient space → 507 with byte counts', async () => {
    const app = makeApp(makeMockService());
    const busy = await post(app, '/', { path: '/busy' });
    expect(busy.status).toBe(409);
    expect((await busy.json()).code).toBe('IMPORT_RUNNING');
    const full = await post(app, '/', { path: '/full' });
    expect(full.status).toBe(507);
    expect(await full.json()).toMatchObject({
      code: 'INSUFFICIENT_SPACE',
      requiredBytes: 1000,
      freeBytes: 10,
    });
    // Failed submits never write an audit row.
    expect(listAudit(db)).toHaveLength(0);
  });

  it('jobs list + detail (with dirs) + 404s', async () => {
    const app = makeApp(makeMockService());
    const list = await app.request('/jobs');
    expect((await list.json()).jobs).toHaveLength(1);
    const detail = await app.request('/jobs/job-1');
    const body = await detail.json();
    expect(body.job.id).toBe('job-1');
    expect(body.dirs).toHaveLength(1);
    expect((await app.request('/jobs/nope')).status).toBe(404);
  });

  it('cancel audits only an accepted cancellation; retry and delete map outcomes', async () => {
    const app = makeApp(makeMockService());
    const cancel = await post(app, '/jobs/job-1/cancel', {});
    expect(await cancel.json()).toEqual({ ok: true });
    expect(listAudit(db)[0]?.action).toBe('library.import.cancel');
    expect((await post(app, '/jobs/nope/cancel', {})).status).toBe(404);

    const retry = await post(app, '/jobs/job-1/retry', {});
    expect(retry.status).toBe(202);
    expect((await post(app, '/jobs/nope/retry', {})).status).toBe(404);

    expect((await app.request('/jobs/job-1', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/jobs/nope', { method: 'DELETE' })).status).toBe(404);
  });
});
