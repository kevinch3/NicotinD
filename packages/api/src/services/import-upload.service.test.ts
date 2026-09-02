/**
 * ImportUploadService: the browser-upload half of the import lane
 * (docs/import.md). Real fs (temp dirs), real sqlite — the whole point of the
 * service is what it does to disk, so there is no seam worth faking here.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import {
  ImportUploadService,
  UploadPathRejectedError,
  UploadTooLargeError,
  IMPORT_UPLOAD_CHUNK_BYTES,
} from './import-upload.service.js';

let db: Database;
let root: string;
let musicDir: string;
let dataDir: string;
let svc: ImportUploadService;

function makeService(freeBytes = 100 * 1024 * 1024 * 1024): ImportUploadService {
  return new ImportUploadService({
    db,
    dataDir,
    musicDir,
    statfs: () => ({ bavail: freeBytes / 4096, bsize: 4096, blocks: freeBytes / 4096 }),
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  root = mkdtempSync(join(tmpdir(), 'import-upload-'));
  musicDir = join(root, 'music');
  dataDir = join(root, 'data');
  mkdirSync(musicDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  svc = makeService();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  db.close();
});

describe('creating an upload session', () => {
  it('accepts a normal album manifest and reserves a session directory', () => {
    const res = svc.create('u1', [
      { path: 'Album/01 One.flac', size: 10 },
      { path: 'Album/02 Two.flac', size: 20 },
    ]);
    expect(res.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.skipped).toEqual([]);
    expect(existsSync(svc.sessionDir(res.uploadId))).toBe(true);
  });

  // The client sends these paths, so they are untrusted in exactly the way a
  // zip central directory is. Reuses `safeArchivePath`, which already carries
  // the traversal test suite.
  it('refuses a manifest path that escapes the session directory', () => {
    expect(() => svc.create('u1', [{ path: '../../etc/passwd', size: 1 }])).toThrow(
      UploadPathRejectedError,
    );
    expect(() => svc.create('u1', [{ path: '/abs/x.flac', size: 1 }])).toThrow(
      UploadPathRejectedError,
    );
  });

  it('drops non-audio, non-cover files rather than uploading them', () => {
    const res = svc.create('u1', [
      { path: 'Album/01.flac', size: 10 },
      { path: 'Album/cover.jpg', size: 10 },
      { path: 'Album/notes.nfo', size: 10 },
      { path: 'Album/scan.pdf', size: 10 },
    ]);
    expect(res.skipped.sort()).toEqual(['Album/notes.nfo', 'Album/scan.pdf']);
  });

  it('refuses a manifest with no uploadable file at all', () => {
    expect(() => svc.create('u1', [{ path: 'readme.txt', size: 1 }])).toThrow();
  });

  // Uploading 5 GB and only then discovering there is no room is the worst
  // possible ordering, so the preflight runs against dataDir before byte one.
  it('refuses a manifest larger than the staging filesystem can hold', () => {
    const tight = makeService(50 * 1024 * 1024);
    expect(() => tight.create('u1', [{ path: 'a/x.flac', size: 10 * 1024 * 1024 * 1024 }])).toThrow(
      UploadTooLargeError,
    );
  });
});

describe('writing chunks', () => {
  it('appends at the given offset and reports bytes received', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'Album/01.flac', size: 6 }]);
    await svc.writeChunk(uploadId, 'Album/01.flac', 0, new Uint8Array([1, 2, 3]));
    await svc.writeChunk(uploadId, 'Album/01.flac', 3, new Uint8Array([4, 5, 6]));
    const file = join(svc.sessionDir(uploadId), 'Album', '01.flac');
    expect([...readFileSync(file)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // Resume re-sends the last chunk when it can't know whether it landed.
  // Writing at an absolute offset makes that a no-op instead of a corruption.
  it('is idempotent — a re-sent chunk rewrites the same bytes, never appends twice', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: 4 }]);
    await svc.writeChunk(uploadId, 'a/x.flac', 0, new Uint8Array([1, 2]));
    await svc.writeChunk(uploadId, 'a/x.flac', 2, new Uint8Array([3, 4]));
    await svc.writeChunk(uploadId, 'a/x.flac', 2, new Uint8Array([3, 4]));
    expect([...readFileSync(join(svc.sessionDir(uploadId), 'a', 'x.flac'))]).toEqual([1, 2, 3, 4]);
  });

  it('refuses a chunk for a path that was never in the manifest', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: 4 }]);
    await expect(svc.writeChunk(uploadId, 'a/other.flac', 0, new Uint8Array([1]))).rejects.toThrow(
      UploadPathRejectedError,
    );
  });

  it('refuses a chunk larger than the cap', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: 4 }]);
    await expect(
      svc.writeChunk(uploadId, 'a/x.flac', 0, new Uint8Array(IMPORT_UPLOAD_CHUNK_BYTES + 1)),
    ).rejects.toThrow(UploadTooLargeError);
  });
});

describe('resume', () => {
  // Disk is the source of truth, so a resume survives a server restart that
  // lost every bit of in-memory progress.
  it('reports per-file bytes received, reading them back off disk', async () => {
    const { uploadId } = svc.create('u1', [
      { path: 'a/x.flac', size: 4 },
      { path: 'a/y.flac', size: 8 },
    ]);
    await svc.writeChunk(uploadId, 'a/x.flac', 0, new Uint8Array([1, 2, 3]));

    const fresh = makeService();
    const state = fresh.state(uploadId);
    expect(state?.files).toEqual([
      { path: 'a/x.flac', size: 4, received: 3 },
      { path: 'a/y.flac', size: 8, received: 0 },
    ]);
  });

  it('reports nothing for an unknown session', () => {
    expect(svc.state('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('abort', () => {
  it('removes the staged bytes and the row', () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: 4 }]);
    const dir = svc.sessionDir(uploadId);
    expect(svc.abort(uploadId)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(svc.state(uploadId)).toBeNull();
  });
});
