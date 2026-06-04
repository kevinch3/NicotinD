import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { AcquireWatcher } from './acquire-watcher.js';
import type { AcquireJob } from './acquire-watcher.js';
import { _resetBinaryCache } from './ytdlp.service.js';

// `enabled` gates the feature independently of whether the binary is installed,
// and a missing binary always reports unavailable even when enabled. We use the
// `bun` binary as a known-present executable and a bogus path as known-absent so
// the test doesn't depend on yt-dlp/spotdl being installed in CI.

interface WatcherAndDb { watcher: AcquireWatcher; db: Database }

function makeWatcher(opts: {
  ytdlpEnabled: boolean;
  ytdlpBinary: string;
  spotdlEnabled: boolean;
  spotdlBinary: string;
}): AcquireWatcher {
  const db = new Database(':memory:');
  applySchema(db);
  return new AcquireWatcher({
    db,
    dataDir: '/tmp/nicotind-acquire-test',
    ytdlp: { enabled: opts.ytdlpEnabled, binaryPath: opts.ytdlpBinary, format: 'bestaudio', extraArgs: [] },
    spotdl: { enabled: opts.spotdlEnabled, binaryPath: opts.spotdlBinary },
    organizeBatch: async () => {},
    scanIncremental: async () => {},
  });
}

function makeWatcherWithDb(opts: {
  ytdlpEnabled: boolean;
  ytdlpBinary: string;
  spotdlEnabled: boolean;
  spotdlBinary: string;
}): WatcherAndDb {
  const db = new Database(':memory:');
  applySchema(db);
  const watcher = new AcquireWatcher({
    db,
    dataDir: '/tmp/nicotind-acquire-test',
    ytdlp: { enabled: opts.ytdlpEnabled, binaryPath: opts.ytdlpBinary, format: 'bestaudio', extraArgs: [] },
    spotdl: { enabled: opts.spotdlEnabled, binaryPath: opts.spotdlBinary },
    organizeBatch: async () => {},
    scanIncremental: async () => {},
  });
  return { watcher, db };
}

function insertJob(db: Database, id: string, state: AcquireJob['state'], url = 'https://example.com') {
  db.run(
    `INSERT INTO acquire_jobs (id, backend, url, label, state) VALUES (?, 'ytdlp', ?, NULL, ?)`,
    [id, url, state],
  );
}

const PRESENT = 'bun';
const ABSENT = '/nonexistent/definitely-not-a-real-binary-xyz';

describe('AcquireWatcher availability gating', () => {
  beforeEach(() => _resetBinaryCache());

  it('reports yt-dlp unavailable when disabled, even if the binary exists', () => {
    const w = makeWatcher({ ytdlpEnabled: false, ytdlpBinary: PRESENT, spotdlEnabled: true, spotdlBinary: PRESENT });
    expect(w.isYtdlpAvailable()).toBe(false);
  });

  it('reports yt-dlp unavailable when enabled but the binary is missing', () => {
    const w = makeWatcher({ ytdlpEnabled: true, ytdlpBinary: ABSENT, spotdlEnabled: true, spotdlBinary: PRESENT });
    expect(w.isYtdlpAvailable()).toBe(false);
  });

  it('reports yt-dlp available when enabled and the binary exists', () => {
    const w = makeWatcher({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: true, spotdlBinary: PRESENT });
    expect(w.isYtdlpAvailable()).toBe(true);
  });

  it('reports spotdl unavailable when disabled, even if the binary exists', () => {
    const w = makeWatcher({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: PRESENT });
    expect(w.isSpotdlAvailable()).toBe(false);
  });

  it('rejects submit when the backend is unavailable', async () => {
    const w = makeWatcher({ ytdlpEnabled: false, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: PRESENT });
    await expect(w.submit('https://example.com', 'ytdlp')).rejects.toThrow(/not enabled/);
  });
});

describe('AcquireWatcher.deleteJob', () => {
  beforeEach(() => _resetBinaryCache());

  it('deletes a done job and returns true', () => {
    const { watcher, db } = makeWatcherWithDb({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: ABSENT });
    insertJob(db, 'job-done', 'done');
    expect(watcher.deleteJob('job-done')).toBe(true);
    expect(watcher.getJob('job-done')).toBeNull();
  });

  it('deletes a failed job and returns true', () => {
    const { watcher, db } = makeWatcherWithDb({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: ABSENT });
    insertJob(db, 'job-failed', 'failed');
    expect(watcher.deleteJob('job-failed')).toBe(true);
    expect(watcher.getJob('job-failed')).toBeNull();
  });

  it('does not delete a running job (returns false)', () => {
    const { watcher, db } = makeWatcherWithDb({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: ABSENT });
    insertJob(db, 'job-running', 'running');
    expect(watcher.deleteJob('job-running')).toBe(false);
    expect(watcher.getJob('job-running')).not.toBeNull();
  });

  it('returns false for unknown id', () => {
    const { watcher } = makeWatcherWithDb({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: ABSENT });
    expect(watcher.deleteJob('nonexistent')).toBe(false);
  });
});

describe('AcquireWatcher.retryJob', () => {
  beforeEach(() => _resetBinaryCache());

  it('returns null for an unknown job id', async () => {
    const { watcher } = makeWatcherWithDb({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: ABSENT });
    const newId = await watcher.retryJob('nonexistent');
    expect(newId).toBeNull();
  });

  it('creates a new job and removes the old one', async () => {
    const { watcher, db } = makeWatcherWithDb({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: ABSENT });
    insertJob(db, 'old-job', 'failed', 'https://www.youtube.com/watch?v=test');
    const newId = await watcher.retryJob('old-job');
    expect(typeof newId).toBe('string');
    expect(newId).not.toBe('old-job');
    // Old job should be gone
    expect(watcher.getJob('old-job')).toBeNull();
    // New job should exist
    const newJob = watcher.getJob(newId!);
    expect(newJob).not.toBeNull();
    expect(newJob?.url).toBe('https://www.youtube.com/watch?v=test');
  });
});
