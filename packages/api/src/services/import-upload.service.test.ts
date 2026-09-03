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
  ChunkTooLargeError,
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

  // The in-memory input shape, kept because the signature still accepts it —
  // but note this is NOT what the route passes. The streaming tests below are
  // the ones that cover production; see #921 for why that distinction cost a
  // release.
  it('refuses a chunk larger than the cap', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: 4 }]);
    await expect(
      svc.writeChunk(uploadId, 'a/x.flac', 0, new Uint8Array(IMPORT_UPLOAD_CHUNK_BYTES + 1)),
    ).rejects.toThrow(ChunkTooLargeError);
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

/**
 * #921. The cap used to be written as `body instanceof Uint8Array && …`, but the
 * route hands `writeChunk` a `ReadableStream` (`c.req.raw.body`), so the guard
 * was unreachable on every real request while its test — which passed a
 * `Uint8Array` — stayed green. These drive a stream, which is what production
 * does, so they fail if the guard becomes unreachable again.
 */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe('chunk bounds, enforced on the streaming path (#921)', () => {
  it('refuses a stream that exceeds the chunk cap', async () => {
    const { uploadId } = svc.create('u1', [
      { path: 'a/x.flac', size: IMPORT_UPLOAD_CHUNK_BYTES * 4 },
    ]);
    // Two chunks that only together exceed the cap: a guard that checks the
    // first buffer's length rather than the running total would miss this.
    const half = new Uint8Array(IMPORT_UPLOAD_CHUNK_BYTES);
    await expect(
      svc.writeChunk(uploadId, 'a/x.flac', 0, streamOf(half, new Uint8Array(1))),
    ).rejects.toThrow(ChunkTooLargeError);
  });

  it('accepts a stream at exactly the cap', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: IMPORT_UPLOAD_CHUNK_BYTES }]);
    const received = await svc.writeChunk(
      uploadId,
      'a/x.flac',
      0,
      streamOf(new Uint8Array(IMPORT_UPLOAD_CHUNK_BYTES)),
    );
    expect(received).toBe(IMPORT_UPLOAD_CHUNK_BYTES);
  });

  // The manifest is a declaration of intent that the preflight already reserved
  // disk for. Writing past it means the reservation was a lie.
  it('refuses to write past the size the manifest declared', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: 10 }]);
    await expect(
      svc.writeChunk(uploadId, 'a/x.flac', 0, streamOf(new Uint8Array(11))),
    ).rejects.toThrow(ChunkTooLargeError);
  });

  it('refuses an offset already past the declared size', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: 10 }]);
    await expect(
      svc.writeChunk(uploadId, 'a/x.flac', 10, streamOf(new Uint8Array([1]))),
    ).rejects.toThrow(ChunkTooLargeError);
  });

  // A rejected chunk must not leave its partial bytes behind, or a resume
  // reports a `received` that includes data the server refused.
  it('leaves nothing behind when it rejects mid-stream', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: 10 }]);
    await svc.writeChunk(uploadId, 'a/x.flac', 0, streamOf(new Uint8Array([1, 2, 3])));
    await expect(
      svc.writeChunk(uploadId, 'a/x.flac', 3, streamOf(new Uint8Array(50))),
    ).rejects.toThrow(ChunkTooLargeError);

    expect(svc.state(uploadId)?.files[0]).toEqual({ path: 'a/x.flac', size: 10, received: 3 });
  });

  it('still writes a well-behaved stream through unchanged', async () => {
    const { uploadId } = svc.create('u1', [{ path: 'a/x.flac', size: 6 }]);
    await svc.writeChunk(uploadId, 'a/x.flac', 0, streamOf(new Uint8Array([1, 2, 3])));
    await svc.writeChunk(uploadId, 'a/x.flac', 3, streamOf(new Uint8Array([4, 5, 6])));
    expect([...readFileSync(join(svc.sessionDir(uploadId), 'a', 'x.flac'))]).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });
});
