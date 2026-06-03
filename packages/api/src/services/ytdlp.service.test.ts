import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { YtdlpService, _resetBinaryCache, type YtdlpServiceOptions } from './ytdlp.service.js';
import type { CompletedDownloadFile } from './path-inference.js';

// ─── Minimal spawn fake ──────────────────────────────────────────────────────
// Injected per-service (NOT via mock.module): bun module mocks are process-global
// and would leak `node:child_process`/`node:fs` into other concurrently-running
// test files. We pass a fake spawn and use a real temp staging dir instead.

class FakeStream extends EventEmitter {
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

class FakeProc extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();

  emitData(chunk: string): void {
    this.stdout.emit('data', Buffer.from(chunk));
    this.stderr.emit('data', Buffer.from(chunk));
  }

  finish(code: number): void {
    this.emit('close', code);
  }
}

let fakeProc: FakeProc;
const spawnMock = mock((..._args: unknown[]) => {
  fakeProc = new FakeProc();
  return fakeProc;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

let stagingBase: string;

function makeService(
  db: Database,
  onComplete: (id: string, files: CompletedDownloadFile[]) => Promise<void>,
  onFailed: (id: string, error: string) => void = () => {},
): YtdlpService {
  return new YtdlpService({
    stagingBase,
    db,
    ytdlp: { enabled: true, binaryPath: 'yt-dlp', format: 'bestaudio', extraArgs: [] },
    spotdl: { enabled: true, binaryPath: 'spotdl' },
    onComplete,
    onFailed,
    spawn: spawnMock as unknown as YtdlpServiceOptions['spawn'],
  });
}

/** Create a real audio file under the staging dir (replaces the old virtual fs). */
function seedAudio(relPath: string): void {
  const dest = join(stagingBase, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, new Uint8Array([0]));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('YtdlpService', () => {
  beforeEach(() => {
    _resetBinaryCache();
    spawnMock.mockClear();
    // Some sandboxes export a TMPDIR that doesn't exist yet; mkdtempSync ENOENTs.
    mkdirSync(tmpdir(), { recursive: true });
    stagingBase = mkdtempSync(join(tmpdir(), 'nd-ytdlp-'));
  });

  afterEach(() => {
    rmSync(stagingBase, { recursive: true, force: true });
  });

  it('spawns yt-dlp with correct arguments', async () => {
    const db = makeDb();
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j1', 'ytdlp', 'https://example.com/video')`);
    const svc = makeService(db, async () => {});

    const runPromise = svc.run('j1', 'ytdlp', 'https://example.com/video');
    // Finish the process synchronously
    fakeProc.finish(0);
    await runPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('yt-dlp');
    expect(args).toContain('https://example.com/video');
    expect(args).toContain('--extract-audio');
    expect(args).toContain('--newline');
  });

  it('transitions state to running then done on exit 0', async () => {
    const db = makeDb();
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j2', 'ytdlp', 'https://yt.com/x')`);
    const svc = makeService(db, async () => {});

    const run = svc.run('j2', 'ytdlp', 'https://yt.com/x');
    // After spawning, state should be 'running'
    const mid = db.query<{ state: string }, [string]>('SELECT state FROM acquire_jobs WHERE id = ?').get('j2');
    expect(mid?.state).toBe('running');

    fakeProc.finish(0);
    await run;

    const end = db.query<{ state: string }, [string]>('SELECT state FROM acquire_jobs WHERE id = ?').get('j2');
    expect(end?.state).toBe('done');
  });

  it('transitions state to failed on non-zero exit', async () => {
    const db = makeDb();
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j3', 'ytdlp', 'https://yt.com/x')`);
    const failures: string[] = [];
    const svc = makeService(db, async () => {}, (id) => failures.push(id));

    const run = svc.run('j3', 'ytdlp', 'https://yt.com/x');
    fakeProc.emitData('ERROR: Something went wrong\n');
    fakeProc.finish(1);
    await run;

    const row = db.query<{ state: string }, [string]>('SELECT state FROM acquire_jobs WHERE id = ?').get('j3');
    expect(row?.state).toBe('failed');
    expect(failures).toContain('j3');
  });

  it('parses yt-dlp percentage progress and updates DB', async () => {
    const db = makeDb();
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j4', 'ytdlp', 'https://yt.com/x')`);
    const svc = makeService(db, async () => {});

    svc.run('j4', 'ytdlp', 'https://yt.com/x');
    fakeProc.emitData('[download]  67.3% of 5.00MiB\n');

    const row = db.query<{ progress: string | null }, [string]>(
      'SELECT progress FROM acquire_jobs WHERE id = ?',
    ).get('j4');
    const progress = row?.progress ? JSON.parse(row.progress) : null;
    expect(progress?.done).toBe(67);

    fakeProc.finish(0);
  });

  it('parses playlist item counter progress', async () => {
    const db = makeDb();
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j5', 'ytdlp', 'https://yt.com/pl')`);
    const svc = makeService(db, async () => {});

    svc.run('j5', 'ytdlp', 'https://yt.com/pl');
    fakeProc.emitData('[download] Downloading item 3 of 12\n');

    const row = db.query<{ progress: string | null }, [string]>(
      'SELECT progress FROM acquire_jobs WHERE id = ?',
    ).get('j5');
    const progress = row?.progress ? JSON.parse(row.progress) : null;
    expect(progress).toEqual({ done: 3, total: 12 });

    fakeProc.finish(0);
  });

  it('calls onComplete with discovered audio files', async () => {
    const db = makeDb();
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j6', 'ytdlp', 'https://yt.com/x')`);

    const completed: CompletedDownloadFile[] = [];
    const svc = makeService(db, async (_, files) => { completed.push(...files); });

    const run = svc.run('j6', 'ytdlp', 'https://yt.com/x');
    // A real mp3 in the staging dir tree (run() created <stagingBase>/j6 already).
    seedAudio('j6/Artist/Album/Track.mp3');
    fakeProc.finish(0);
    await run;

    expect(completed.length).toBeGreaterThan(0);
    expect(completed[0]!.username).toContain('j6');
  });

  it('spawns spotdl with download subcommand', async () => {
    const db = makeDb();
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j7', 'spotdl', 'https://open.spotify.com/playlist/abc')`);
    const svc = makeService(db, async () => {});

    const run = svc.run('j7', 'spotdl', 'https://open.spotify.com/playlist/abc');
    fakeProc.finish(0);
    await run;

    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('spotdl');
    expect(args[0]).toBe('download');
  });

  it('cancel sends SIGTERM and returns true for running job', async () => {
    const db = makeDb();
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j8', 'ytdlp', 'https://yt.com/x')`);
    const svc = makeService(db, async () => {});

    svc.run('j8', 'ytdlp', 'https://yt.com/x');
    const killMock = mock(() => true);
    (fakeProc as unknown as { kill: typeof killMock }).kill = killMock;

    const result = svc.cancel('j8');
    expect(result).toBe(true);
    expect(killMock).toHaveBeenCalledWith('SIGTERM');
  });

  it('cancel returns false for unknown job id', () => {
    const db = makeDb();
    const svc = makeService(db, async () => {});
    expect(svc.cancel('nonexistent')).toBe(false);
  });
});
