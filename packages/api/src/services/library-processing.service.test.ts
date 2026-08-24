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
    analyzeDescriptors: null,
    descriptorsAvailable: () => false,
    lookupGenre: async () => {
      counters.genreLookups += 1;
      return 'Rock';
    },
    lookupArtistImageSpotify: async () => null,
    lookupArtistImageDiscogs: null,
    lookupArtistInfo: null,
    lookupGenreForRelease: null,
    resolveArtistIdentity: null,
    lookupPopularity: async () => new Map(),
    lookupArtistOrigin: null,
    lookupArtistReleaseGroups: null,
    fileExists: () => true,
  });
}

function service(opts: {
  now: Date;
  counters: { analyzed: number; genreLookups: number };
  batchSize?: number;
}): LibraryProcessingService {
  return new LibraryProcessingService({
    db,
    lidarr: {} as never,
    musicDir: '/music',
    dataDir,
    now: () => opts.now,
    batchSize: opts.batchSize,
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
  it('runNow drains all pending work in one call', async () => {
    for (let i = 0; i < 5; i++) seedSong(`s${i}`);
    setProcessingSettings(db, {});
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ batchSize: 2, now: new Date(2024, 0, 1, 12, 0), counters });

    await svc.runNow();

    expect(pendingBpm()).toBe(0);
    expect(counters.analyzed).toBe(5);
    const { status } = svc.getState();
    expect(status.processed).toBeGreaterThanOrEqual(5);
  });

  it('resumes without reprocessing already-enriched rows', async () => {
    for (let i = 0; i < 4; i++) seedSong(`s${i}`);
    setProcessingSettings(db, { tasks: { bpm: true, genre: false, key: false } });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ batchSize: 2, now: new Date(2024, 0, 1, 12, 0), counters });

    await svc.runNow();
    expect(counters.analyzed).toBe(4);

    // A second run finds nothing pending and does no further analysis.
    await svc.runNow();
    expect(counters.analyzed).toBe(4);
    expect(pendingBpm()).toBe(0);
  });

  // The processing window was removed: enrichment now runs at any hour, so the
  // time of day must not gate a tick. Noon used to sit outside the default
  // 05:00-08:00 window and do nothing.
  it('tick processes work regardless of the time of day', async () => {
    for (let i = 0; i < 3; i++) seedSong(`s${i}`);
    setProcessingSettings(db, { tasks: { bpm: true, genre: false, key: false } });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 12, 0), counters });

    await svc.tick();

    expect(counters.analyzed).toBe(3);
    expect(pendingBpm()).toBe(0);
  });

  it('tick processes exactly one batch', async () => {
    for (let i = 0; i < 5; i++) seedSong(`s${i}`);
    setProcessingSettings(db, {
      tasks: { bpm: true, genre: false, key: false },
    });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ batchSize: 2, now: new Date(2024, 0, 1, 6, 30), counters });

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

  it('tick skips background enrichment when paused', async () => {
    for (let i = 0; i < 3; i++) seedSong(`s${i}`);
    setProcessingSettings(db, { paused: true });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ batchSize: 2, now: new Date(2024, 0, 1, 6, 30), counters });

    await svc.tick();

    expect(counters.analyzed).toBe(0);
    expect(pendingBpm()).toBe(3);
    expect(svc.getState().status.phase).toBe('paused');
  });

  it('runNow overrides pause — pause throttles the tick, not the admin override', async () => {
    for (let i = 0; i < 3; i++) seedSong(`s${i}`);
    setProcessingSettings(db, { paused: true });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 12, 0), counters });

    await svc.runNow();

    expect(pendingBpm()).toBe(0);
  });

  it('paused still reports disabled when the master switch is also off', async () => {
    seedSong('s0');
    setProcessingSettings(db, { enabled: false, paused: true });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ now: new Date(2024, 0, 1, 6, 30), counters });

    await svc.tick();

    // `enabled: false` is the stronger, persistent statement — it wins the label.
    expect(svc.getState().status.phase).toBe('disabled');
  });

  it('guards against overlapping runs', async () => {
    for (let i = 0; i < 4; i++) seedSong(`s${i}`);
    setProcessingSettings(db, { tasks: { bpm: true, genre: false, key: false } });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ batchSize: 10, now: new Date(2024, 0, 1, 12, 0), counters });

    // Fire two concurrently; the second must see `busy` and return immediately,
    // so the 4 songs are analyzed exactly once.
    await Promise.all([svc.runNow(), svc.runNow()]);

    expect(counters.analyzed).toBe(4);
    expect(pendingBpm()).toBe(0);
  });

  it('appends a log line per enriched item', async () => {
    for (let i = 0; i < 3; i++) seedSong(`s${i}`);
    setProcessingSettings(db, {
      tasks: { bpm: true, genre: true, key: false, energy: false },
    });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ batchSize: 10, now: new Date(2024, 0, 1, 12, 0), counters });

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

  it('accumulates the failure tally across ticks within one drain', async () => {
    seedSong('s0');
    seedSong('s1');
    setProcessingSettings(db, {
      tasks: {
        bpm: true,
        genre: false,
        key: false,
        'artist-image': false,
        'artist-info': false,
        energy: false,
        'audio-features': false,
        descriptors: false,
        'artist-identity': false,
        'genre-audio': false,
        'genre-discogs': false,
        popularity: false,
        'artist-origin': false,
      },
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
      batchSize: 1, // one failing song per tick, so the tally is observable
      contextFactory: failingCtx,
      reportFailure: () => {},
    });

    await svc.tick();
    expect(svc.getState().status.failed).toBe(1);
    // A second tick with work still pending continues the same run's tally.
    await svc.tick();
    expect(svc.getState().status.failed).toBe(2);
  });

  // The window used to mark the session boundary for the failure tally; with it
  // gone, a "run" spans one continuous drain instead. Draining the queue and
  // then giving the processor new work must clear a resolved failure, or a
  // long-fixed "1 failed — ffmpeg…" would sit on the panel until a restart.
  it('resets the stale failure tally once the queue drains and new work arrives', async () => {
    seedSong('s0');
    // Every other task must be off: the drain boundary is "nothing pending
    // across the runnable tasks", so one still-enabled task would keep the
    // queue permanently non-empty and the boundary would never fire.
    setProcessingSettings(db, {
      tasks: {
        bpm: true,
        genre: false,
        key: false,
        'artist-image': false,
        'artist-info': false,
        energy: false,
        'audio-features': false,
        descriptors: false,
        'artist-identity': false,
        'genre-audio': false,
        'genre-discogs': false,
        popularity: false,
        'artist-origin': false,
      },
    });
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
      now: () => new Date(2024, 0, 1, 6, 0),
      contextFactory: ctxFactory,
      reportFailure: () => {},
    });

    // The file fails; the tally shows it.
    await svc.tick();
    expect(svc.getState().status.failed).toBe(1);
    expect(svc.getState().status.lastError).toContain('code 183');

    // It then succeeds, and a further tick finds nothing pending — the drain is
    // over. The tally is deliberately still on display at this point: a batch
    // that finds no work must not wipe the "complete" summary.
    failDecode = false;
    await svc.tick();
    await svc.tick();
    expect(svc.getState().status.failed).toBe(1);

    // New work arrives: that opens a new run, and the stale banner must be gone.
    seedSong('s1');
    await svc.tick();
    const { status } = svc.getState();
    expect(status.failed).toBe(0);
    expect(status.lastError).toBeNull();
    expect(status.processed).toBe(1);
  });

  it('resets a restored stale failure tally on the first batch after a restart', async () => {
    seedSong('s0');
    setProcessingSettings(db, {
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
    const svc = service({ batchSize: 10, now: new Date(2024, 0, 1, 6, 0), counters });
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
      tasks: { bpm: true, genre: false, key: false, energy: false },
    });
    const counters = { analyzed: 0, genreLookups: 0 };
    const svc = service({ batchSize: 10, now: new Date(2024, 0, 1, 12, 0), counters });
    await svc.runNow();

    // A new service instance (same db) reads back the persisted run progress.
    const svc2 = service({ now: new Date(2024, 0, 1, 12, 0), counters });
    expect(svc2.getState().status.processed).toBe(2);
  });
});
