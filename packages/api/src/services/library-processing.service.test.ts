import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import { setProcessingSettings } from './processing-settings.js';
import { LibraryProcessingService } from './library-processing.service.js';
import { getTask, type EnrichmentContext } from './enrichment/tasks.js';

let db: Database;
let dataDir: string;

// Seeds an already-landed song (landed_at set): these tests cover windowed
// backfill of the existing library, not the fresh-download quarantine path
// (which lives in library-processing.landing.test.ts).
function seedSong(id: string, artist = 'Artist'): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, landed_at, synced_at)
     VALUES (?, 'alb', ?, ?, 'art', 0, ?, 10, 320, 'opus', 'audio/opus', '2024-01-01', 1, 1)`,
    [id, `T-${id}`, artist, `${artist}/Album/${id}.opus`],
  );
}

/** A fast, deterministic context — no real ffmpeg/Lidarr. */
function fakeCtx(counters: { analyzed: number; genreLookups: number }) {
  return (): EnrichmentContext => ({
    musicDir: '/music',
    coverCacheDir: '/data/cover-cache',
    lidarr: {} as never,
    concurrency: 2,
    ffmpegAvailable: () => true,
    readTags: async () => ({}),
    writeTags: async () => true,
    analyzeBpm: async () => {
      counters.analyzed += 1;
      return 120;
    },
    analyzeRhythm: null,
    analyzeKey: async () => 'C major',
    analyzeLoudness: async () => ({ loudness: -9.5, energy: 0.7 }),
    analyzeAudioFeatures: null,
    audioFeaturesAvailable: () => false,
    lookupGenre: async () => {
      counters.genreLookups += 1;
      return 'Rock';
    },
    lookupArtistImageSpotify: async () => null,
    fileExists: () => true,
  });
}

function service(opts: {
  now: Date;
  counters: { analyzed: number; genreLookups: number };
}): LibraryProcessingService {
  return new LibraryProcessingService({
    db,
    lidarr: {} as never,
    musicDir: '/music',
    dataDir,
    now: () => opts.now,
    contextFactory: fakeCtx(opts.counters),
  });
}

const pendingBpm = () =>
  Number(
    db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM library_songs WHERE bpm IS NULL').get()!
      .n,
  );

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  dataDir = mkdtempSync(join(tmpdir(), 'nd-proc-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('LibraryProcessingService', () => {
  it('runNow drains all pending work, ignoring the window', async () => {
    for (let i = 0; i < 5; i++) seedSong(`s${i}`);
    setProcessingSettings(db, { window: { start: '05:00', end: '08:00' }, batchSize: 2 });
    const counters = { analyzed: 0, genreLookups: 0 };
    // Noon — well outside the 05:00–08:00 window.
    const svc = service({ now: new Date(2024, 0, 1, 12, 0), counters });

    await svc.runNow();

    expect(pendingBpm()).toBe(0);
    expect(counters.analyzed).toBe(5);
    const { status } = svc.getState();
    expect(status.processed).toBeGreaterThanOrEqual(5);
  });

  it('resumes without reprocessing already-enriched rows', async () => {
    for (let i = 0; i < 4; i++) seedSong(`s${i}`);
    setProcessingSettings(db, { batchSize: 2, tasks: { bpm: true, genre: false, key: false } });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 12, 0), counters });

    await svc.runNow();
    expect(counters.analyzed).toBe(4);

    // A second run finds nothing pending and does no further analysis.
    await svc.runNow();
    expect(counters.analyzed).toBe(4);
    expect(pendingBpm()).toBe(0);
  });

  it('tick does nothing outside the window', async () => {
    for (let i = 0; i < 3; i++) seedSong(`s${i}`);
    setProcessingSettings(db, { window: { start: '05:00', end: '08:00' } });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 12, 0), counters });

    await svc.tick();

    expect(counters.analyzed).toBe(0);
    expect(pendingBpm()).toBe(3);
    expect(svc.getState().status.phase).toBe('outside-window');
  });

  it('tick processes exactly one batch inside the window', async () => {
    for (let i = 0; i < 5; i++) seedSong(`s${i}`);
    setProcessingSettings(db, {
      window: { start: '05:00', end: '08:00' },
      batchSize: 2,
      tasks: { bpm: true, genre: false, key: false },
    });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 6, 30), counters });

    await svc.tick();

    expect(counters.analyzed).toBe(2); // one batch only
    expect(pendingBpm()).toBe(3);
  });

  it('tick is a no-op when disabled', async () => {
    seedSong('s0');
    setProcessingSettings(db, { enabled: false });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 6, 30), counters });

    await svc.tick();

    expect(counters.analyzed).toBe(0);
    expect(svc.getState().status.phase).toBe('disabled');
  });

  it('guards against overlapping runs', async () => {
    for (let i = 0; i < 4; i++) seedSong(`s${i}`);
    setProcessingSettings(db, { batchSize: 10, tasks: { bpm: true, genre: false, key: false } });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 12, 0), counters });

    // Fire two concurrently; the second must see `busy` and return immediately,
    // so the 4 songs are analyzed exactly once.
    await Promise.all([svc.runNow(), svc.runNow()]);

    expect(counters.analyzed).toBe(4);
    expect(pendingBpm()).toBe(0);
  });

  it('appends a log line per enriched item', async () => {
    for (let i = 0; i < 3; i++) seedSong(`s${i}`);
    setProcessingSettings(db, {
      batchSize: 10,
      tasks: { bpm: true, genre: true, key: false, energy: false },
    });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 12, 0), counters });

    await svc.runNow();

    const logPath = join(dataDir, 'library-processing.log');
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(6); // 3 bpm + 3 genre
    expect(lines.some((l) => l.includes('\tbpm\t'))).toBe(true);
    expect(lines.some((l) => l.includes('\tgenre\t'))).toBe(true);
  });

  it('tallies failures and reports one aggregated event per failing task', async () => {
    for (let i = 0; i < 3; i++) seedSong(`s${i}`);
    setProcessingSettings(db, {
      batchSize: 10, // one batch attempts all three; runNow then stops (no progress)
      tasks: { bpm: true, genre: false, key: false, energy: false },
    });
    const reports: { task: string | null; failed: number; sample: string | null }[] = [];
    // A context whose bpm decode always fails via the onError callback.
    const failingCtx = (): EnrichmentContext => ({
      ...fakeCtx({ analyzed: 0, genreLookups: 0 })(),
      analyzeBpm: async (_abs, onError) => {
        onError?.(new Error('ffmpeg PCM decode exited with code 183: Invalid data'));
        return null;
      },
    });
    const svc = new LibraryProcessingService({
      db,
      lidarr: {} as never,
      musicDir: '/music',
      dataDir,
      now: () => new Date(2024, 0, 1, 12, 0),
      contextFactory: failingCtx,
      reportFailure: (r) => reports.push({ task: r.task, failed: r.failed, sample: r.sample }),
    });

    await svc.runNow();

    // Nothing applied, everything failed — reported exactly once (aggregated).
    expect(reports.length).toBe(1);
    expect(reports[0].task).toBe('bpm');
    expect(reports[0].failed).toBe(3);
    expect(reports[0].sample).toContain('code 183');
    const { status } = svc.getState();
    expect(status.failed).toBe(3);
    expect(status.lastError).toContain('code 183');
  });

  it('excludes a permanently-failing file after repeated runs and reports it skipped', async () => {
    seedSong('s0');
    setProcessingSettings(db, {
      batchSize: 10,
      tasks: { bpm: true, genre: false, key: false, energy: false },
    });
    const failingCtx = (): EnrichmentContext => ({
      ...fakeCtx({ analyzed: 0, genreLookups: 0 })(),
      analyzeBpm: async (_abs, onError) => {
        onError?.(new Error('ffmpeg PCM decode exited with code 183: Invalid data'));
        return null;
      },
    });
    const svc = new LibraryProcessingService({
      db,
      lidarr: {} as never,
      musicDir: '/music',
      dataDir,
      now: () => new Date(2024, 0, 1, 12, 0),
      contextFactory: failingCtx,
      reportFailure: () => {},
    });

    // Each runNow attempts the file once (then stops on no progress). After the
    // attempt cap the file is excluded and reported as skipped.
    expect(pendingBpm()).toBe(1);
    for (let i = 0; i < 3; i++) await svc.runNow();

    expect(getTask('bpm')!.countPending(db)).toBe(0);
    expect(svc.getState().status.skipped).toBe(1);
  });

  it('accumulates the failure tally across ticks within one window session', async () => {
    seedSong('s0');
    seedSong('s1');
    setProcessingSettings(db, {
      window: { start: '05:00', end: '08:00' },
      batchSize: 1, // one failing song per tick
      tasks: { bpm: true, genre: false, key: false, energy: false },
    });
    const failingCtx = (): EnrichmentContext => ({
      ...fakeCtx({ analyzed: 0, genreLookups: 0 })(),
      analyzeBpm: async (_abs, onError) => {
        onError?.(new Error('ffmpeg PCM decode exited with code 183: Invalid data'));
        return null;
      },
    });
    const svc = new LibraryProcessingService({
      db,
      lidarr: {} as never,
      musicDir: '/music',
      dataDir,
      now: () => new Date(2024, 0, 1, 6, 0),
      contextFactory: failingCtx,
      reportFailure: () => {},
    });

    await svc.tick();
    expect(svc.getState().status.failed).toBe(1);
    // Second in-window tick continues the same session's tally.
    await svc.tick();
    expect(svc.getState().status.failed).toBe(2);
  });

  it('resets the stale failure tally when a new window session starts', async () => {
    seedSong('s0');
    setProcessingSettings(db, {
      window: { start: '05:00', end: '08:00' },
      batchSize: 10,
      tasks: { bpm: true, genre: false, key: false, energy: false },
    });
    let clock = new Date(2024, 0, 1, 6, 0);
    let failDecode = true;
    const ctxFactory = (): EnrichmentContext => ({
      ...fakeCtx({ analyzed: 0, genreLookups: 0 })(),
      analyzeBpm: async (_abs, onError) => {
        if (failDecode) {
          onError?.(new Error('ffmpeg PCM decode exited with code 183: Invalid data'));
          return null;
        }
        return 120;
      },
    });
    const svc = new LibraryProcessingService({
      db,
      lidarr: {} as never,
      musicDir: '/music',
      dataDir,
      now: () => clock,
      contextFactory: ctxFactory,
      reportFailure: () => {},
    });

    // Night 1: the file fails; the tally shows it.
    await svc.tick();
    expect(svc.getState().status.failed).toBe(1);
    expect(svc.getState().status.lastError).toContain('code 183');

    // Daytime: outside the window (marks the session boundary).
    clock = new Date(2024, 0, 1, 12, 0);
    await svc.tick();
    expect(svc.getState().status.phase).toBe('outside-window');

    // Night 2: the file now succeeds — the old failure banner must be gone.
    failDecode = false;
    clock = new Date(2024, 0, 2, 6, 0);
    await svc.tick();
    const { status } = svc.getState();
    expect(status.failed).toBe(0);
    expect(status.lastError).toBeNull();
    expect(status.processed).toBe(1);
  });

  it('resets a restored stale failure tally on the first batch after a restart', async () => {
    seedSong('s0');
    setProcessingSettings(db, {
      window: { start: '05:00', end: '08:00' },
      batchSize: 10,
      tasks: { bpm: true, genre: false, key: false, energy: false },
    });
    // A previous process died mid-window having tallied failures (e.g. the
    // pre-mount-fix sidecar era): phase 'running', failed 2300, persisted.
    db.run(
      `INSERT INTO app_settings (key, value) VALUES ('processing_status', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [
        JSON.stringify({
          phase: 'running',
          processed: 0,
          failed: 2300,
          lastError: 'analysis sidecar could not analyze file (see logs)',
          total: 10900,
          lastItems: [],
          startedAt: '2024-01-01T05:45:00.000Z',
          updatedAt: '2024-01-01T05:50:00.000Z',
        }),
      ],
    );
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 6, 0), counters });
    // The restored tally is visible until the process actually runs something…
    expect(svc.getState().status.failed).toBe(2300);

    // …but the first batch of the new process starts a fresh session.
    await svc.tick();
    const { status } = svc.getState();
    expect(status.failed).toBe(0);
    expect(status.lastError).toBeNull();
    expect(status.processed).toBe(1);
  });

  it('persists status across a restart', async () => {
    for (let i = 0; i < 2; i++) seedSong(`s${i}`);
    setProcessingSettings(db, {
      batchSize: 10,
      tasks: { bpm: true, genre: false, key: false, energy: false },
    });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 12, 0), counters });
    await svc.runNow();

    // A new service instance (same db) reads back the persisted run progress.
    const svc2 = service({ now: new Date(2024, 0, 1, 12, 0), counters });
    expect(svc2.getState().status.processed).toBe(2);
  });
});
