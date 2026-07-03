import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import { setProcessingSettings } from './processing-settings.js';
import { LibraryProcessingService } from './library-processing.service.js';
import type { EnrichmentContext } from './enrichment/tasks.js';

let db: Database;
let dataDir: string;

function seedSong(id: string, artist = 'Artist'): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'alb', ?, ?, 'art', 0, ?, 10, 320, 'opus', 'audio/opus', '2024-01-01', 1)`,
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
    analyzeKey: async () => 'C major',
    analyzeLoudness: async () => ({ loudness: -9.5, energy: 0.7 }),
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
