import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { Role } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { applySchema } from '../db.js';
import {
  UploadEmptyManifestError,
  UploadPathRejectedError,
  UploadTooLargeError,
  ChunkTooLargeError,
  type ImportUploadService,
} from '../services/import-upload.service.js';
import {
  ImportAlreadyRunningError,
  type LibraryImportService,
} from '../services/library-import.service.js';
import { importUploadRoutes } from './import-upload.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function makeUploads(overrides: Record<string, unknown> = {}) {
  return {
    created: [] as unknown[],
    chunks: [] as unknown[],
    create(userId: string | null, files: { path: string; size: number }[]) {
      if (files.some((f) => f.path.includes('..')))
        throw new UploadPathRejectedError(files[0]!.path);
      if (files.length === 0) throw new UploadEmptyManifestError();
      if (files.some((f) => f.size > 1e12)) throw new UploadTooLargeError(1e12, 10);
      this.created.push({ userId, files });
      return { uploadId: 'up-1', skipped: [] as string[] };
    },
    async writeChunk(id: string, path: string, offset: number) {
      this.chunks.push({ id, path, offset });
      return offset + 3;
    },
    state(id: string) {
      return id === 'up-1'
        ? { state: 'open', files: [{ path: 'a/x.flac', size: 6, received: 3 }] }
        : null;
    },
    sessionDir: (id: string) => `/data/staging/upload/${id}`,
    abort: (id: string) => id === 'up-1',
    markCommitted() {},
    ...overrides,
  };
}

function makeImports(overrides: Record<string, unknown> = {}) {
  return {
    submitStaged(dir: string) {
      if (dir.includes('busy')) throw new ImportAlreadyRunningError();
      return 'job-9';
    },
    ...overrides,
  };
}

type Uploads = ReturnType<typeof makeUploads>;
type Imports = ReturnType<typeof makeImports>;

function makeApp(uploads: Uploads, imports: Imports, role: Role = 'user') {
  const app = new Hono<AuthEnv>();
  app.onError(errorHandler);
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u-1', username: 'kev', role, iat: 0, exp: 9999999999 });
    return next();
  });
  app.route(
    '/',
    importUploadRoutes({
      db,
      uploads: uploads as unknown as ImportUploadService,
      imports: imports as unknown as LibraryImportService,
    }),
  );
  return app;
}

function post(app: Hono<AuthEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('import upload routes', () => {
  // A listener can't acquire, so they can't import either. Everyone above that
  // can — the lane is deliberately NOT admin-only, because a streaming-only
  // install's whole point is filling the library.
  it('rejects a listener on every endpoint', async () => {
    const app = makeApp(makeUploads(), makeImports(), 'listener');
    const res = await post(app, '/uploads', { files: [{ path: 'a/x.flac', size: 1 }] });
    expect(res.status).toBe(403);
    expect((await app.request('/uploads/up-1')).status).toBe(403);
  });

  it('creates a session for an ordinary user and echoes what it skipped', async () => {
    const uploads = makeUploads({
      create: () => ({ uploadId: 'up-1', skipped: ['Album/notes.nfo'] }),
    });
    const app = makeApp(uploads, makeImports());
    const res = await post(app, '/uploads', {
      files: [
        { path: 'Album/01.flac', size: 10 },
        { path: 'Album/notes.nfo', size: 2 },
      ],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ uploadId: 'up-1', skipped: ['Album/notes.nfo'] });
  });

  it('maps a traversing manifest path to 400 with a typed code', async () => {
    const app = makeApp(makeUploads(), makeImports());
    const res = await post(app, '/uploads', { files: [{ path: '../../etc/x.flac', size: 1 }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'UPLOAD_PATH_REJECTED' });
  });

  it('maps a too-large manifest to 507 carrying the numbers', async () => {
    const app = makeApp(makeUploads(), makeImports());
    const res = await post(app, '/uploads', { files: [{ path: 'a/x.flac', size: 1e13 }] });
    expect(res.status).toBe(507);
    expect(await res.json()).toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
  });

  it('rejects a malformed manifest body', async () => {
    const app = makeApp(makeUploads(), makeImports());
    expect((await post(app, '/uploads', { files: 'nope' })).status).toBe(400);
    expect((await post(app, '/uploads', {})).status).toBe(400);
  });

  it('writes a chunk at the requested offset', async () => {
    const uploads = makeUploads();
    const app = makeApp(uploads, makeImports());
    const res = await app.request('/uploads/up-1/chunk?path=a%2Fx.flac&offset=6', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(200);
    expect(uploads.chunks[0]).toMatchObject({ id: 'up-1', path: 'a/x.flac', offset: 6 });
  });

  it('refuses a chunk with a missing or non-numeric offset', async () => {
    const app = makeApp(makeUploads(), makeImports());
    const res = await app.request('/uploads/up-1/chunk?path=a%2Fx.flac&offset=abc', {
      method: 'PUT',
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
  });

  it('reports per-file progress so a client can resume', async () => {
    const app = makeApp(makeUploads(), makeImports());
    const res = await app.request('/uploads/up-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      files: [{ path: 'a/x.flac', size: 6, received: 3 }],
    });
    expect((await app.request('/uploads/nope')).status).toBe(404);
  });

  it('commits the session into an import job', async () => {
    const uploads = makeUploads();
    const app = makeApp(uploads, makeImports());
    const res = await post(app, '/uploads/up-1/commit', {});
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: 'job-9' });
  });

  // Import is single-flight by design; the client waits rather than the server
  // queueing, so the 409 has to survive to the browser intact.
  it('passes a single-flight collision through as 409', async () => {
    const uploads = makeUploads({ sessionDir: () => '/data/staging/upload/busy' });
    const app = makeApp(uploads, makeImports());
    const res = await post(app, '/uploads/up-1/commit', {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'IMPORT_RUNNING' });
  });

  it('aborts a session', async () => {
    const app = makeApp(makeUploads(), makeImports());
    expect((await app.request('/uploads/up-1', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/uploads/nope', { method: 'DELETE' })).status).toBe(404);
  });
});

// #921. 413 not 507: "chunk too large" is a client problem, "insufficient
// space" is a host problem, and returning the storage code for the former sends
// whoever debugs it next to check free disk.
describe('import upload routes — chunk bound (#921)', () => {
  it('maps an over-cap chunk to 413, distinct from the 507 disk case', async () => {
    const uploads = makeUploads({
      writeChunk: () => {
        throw new ChunkTooLargeError(999, 10);
      },
    });
    const app = makeApp(uploads, makeImports());
    const res = await app.request('/uploads/up-1/chunk?path=a%2Fx.flac&offset=0', {
      method: 'PUT',
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      code: 'UPLOAD_CHUNK_TOO_LARGE',
      receivedBytes: 999,
      limitBytes: 10,
    });
  });
});
