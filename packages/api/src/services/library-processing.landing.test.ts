import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import { setProcessingSettings } from './processing-settings.js';
import { LibraryProcessingService } from './library-processing.service.js';
import { MAX_ANALYSIS_ATTEMPTS } from './enrichment/analysis-failures.js';
import type { EnrichmentContext } from './enrichment/tasks.js';
import { createJob, getJob, recomputeStage } from './acquisition-job-store.js';

let db: Database;
let dataDir: string;

const SIZE = 10;

/** Insert a quarantined (landed_at NULL) song. `created` controls the TTL valve. */
function seedSong(id: string, created = '2024-01-01'): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'alb', ?, 'Artist', 'art', 0, ?, ?, 320, 'opus', 'audio/opus', ?, 1)`,
    [id, `T-${id}`, `Artist/Album/${id}.opus`, SIZE, created],
  );
}

const landedAt = (id: string): number | null =>
  db
    .query<{ landed_at: number | null }, [string]>(
      'SELECT landed_at FROM library_songs WHERE id = ?',
    )
    .get(id)?.landed_at ?? null;

const isLanded = (id: string): boolean => landedAt(id) !== null;

/**
 * Fake context. `bpmResult` lets a test force BPM to never resolve (null, and
 * NOT ledgered) so the TTL valve / ledger paths can be exercised in isolation.
 */
function fakeCtx(opts: { bpmResult?: number | null; sidecar?: boolean } = {}) {
  const bpm = opts.bpmResult === undefined ? 120 : opts.bpmResult;
  return (): EnrichmentContext => ({
    musicDir: '/music',
    coverCacheDir: '/data/cover-cache',
    lidarr: {} as never,
    concurrency: 2,
    ffmpegAvailable: () => true,
    readTags: async () => ({}),
    writeTags: async () => true,
    analyzeBpm: async () => bpm,
    analyzeRhythm: null,
    analyzeKey: async () => 'C major',
    analyzeLoudness: async () => ({ loudness: -9.5, energy: 0.7 }),
    analyzeAudioFeatures: opts.sidecar ? async () => null : null,
    audioFeaturesAvailable: () => opts.sidecar ?? false,
    lookupGenre: async () => 'Rock',
    lookupArtistImageSpotify: async () => null,
    lookupArtistInfo: null,
    resolveArtistIdentity: null,
    lookupLicence: async () => null,
    fileExists: () => true,
  });
}

function service(now: Date, ctxOpts?: { bpmResult?: number | null; sidecar?: boolean }) {
  return new LibraryProcessingService({
    db,
    lidarr: {} as never,
    musicDir: '/music',
    dataDir,
    now: () => now,
    contextFactory: fakeCtx(ctxOpts),
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  dataDir = mkdtempSync(join(tmpdir(), 'nd-landing-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('landing gate', () => {
  it('quarantines a fresh song and lands it once its gate steps complete', async () => {
    seedSong('s1');
    expect(isLanded('s1')).toBe(false); // scanned but quarantined

    setProcessingSettings(db, { gates: { bpm: true, key: true, energy: true, genre: true } });
    await service(new Date(2024, 0, 1, 12, 0)).runNow();

    expect(isLanded('s1')).toBe(true);
  });

  it('closes a processing-stage acquisition job once its songs land', async () => {
    seedSong('s1');
    const jobId = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      username: 'peer',
      files: [{ filename: 'a\\s1.opus' }],
    });
    db.run(
      `UPDATE acquisition_job_items SET state = 'scanned', song_id = 's1', relative_path = 'Artist/Album/s1.opus'`,
    );
    recomputeStage(db, jobId);
    expect(getJob(db, jobId)?.stage).toBe('processing');

    setProcessingSettings(db, { gates: { bpm: true, key: true, energy: true, genre: true } });
    await service(new Date(2024, 0, 1, 12, 0)).runNow();

    expect(isLanded('s1')).toBe(true);
    const job = getJob(db, jobId)!;
    expect(job.stage).toBe('done');
    expect(job.state).toBe('done');
  });

  it('an unavailable gate step never blocks landing (sidecar off)', async () => {
    seedSong('s1');
    // Only audio-features is gated, and the sidecar is unavailable → required set
    // is empty → the song lands immediately rather than being stranded.
    setProcessingSettings(db, {
      gates: { bpm: false, key: false, energy: false, genre: false, 'audio-features': true },
    });
    await service(new Date(2024, 0, 1, 12, 0), { sidecar: false }).runNow();

    expect(isLanded('s1')).toBe(true);
  });

  it('lands a song whose gate step is permanently failed (ledger at cap)', async () => {
    seedSong('s1');
    // BPM will never resolve (null, un-ledgered by the run itself)…
    setProcessingSettings(db, { gates: { bpm: true, key: false, energy: false, genre: false } });
    // …but it's already at the failure cap for this exact file, so it must land.
    db.run(
      `INSERT INTO library_song_analysis_failures (song_id, task, fail_count, last_error, file_size, last_attempt)
       VALUES ('s1', 'bpm', ?, 'corrupt', ?, 1)`,
      [MAX_ANALYSIS_ATTEMPTS, SIZE],
    );
    await service(new Date(2024, 0, 1, 12, 0), { bpmResult: null }).runNow();

    expect(isLanded('s1')).toBe(true);
  });

  it('holds a song whose gate step is unmet and not yet past the safety valve', async () => {
    seedSong('s1', '2024-01-01'); // created at midnight
    setProcessingSettings(db, { gates: { bpm: true, key: false, energy: false, genre: false } });
    // 12h later — inside the 24h valve — and BPM never resolves → stays quarantined.
    await service(new Date(2024, 0, 1, 12, 0), { bpmResult: null }).runNow();

    expect(isLanded('s1')).toBe(false);
  });

  it('lands a stuck song after the safety valve elapses', async () => {
    seedSong('s1', '2024-01-01');
    setProcessingSettings(db, { gates: { bpm: true, key: false, energy: false, genre: false } });
    // >24h later, BPM still never resolves → the valve lands it anyway.
    await service(new Date(2024, 0, 3, 12, 0), { bpmResult: null }).runNow();

    expect(isLanded('s1')).toBe(true);
  });

  it('lands every quarantined song immediately when nothing is gated', async () => {
    seedSong('s1');
    seedSong('s2');
    setProcessingSettings(db, {
      gates: { bpm: false, key: false, energy: false, genre: false, 'audio-features': false },
    });
    // kickEager with an empty required set graduates outright.
    await service(new Date(2024, 0, 1, 12, 0)).kickEager();

    expect(isLanded('s1')).toBe(true);
    expect(isLanded('s2')).toBe(true);
  });

  it('kickEager lands a fresh download outside the processing window', async () => {
    seedSong('s1');
    setProcessingSettings(db, {
      window: { start: '05:00', end: '08:00' },
      gates: { bpm: true, key: true, energy: true, genre: true },
    });
    // Noon — outside the window — kickEager still runs the gate steps + lands.
    await service(new Date(2024, 0, 1, 12, 0)).kickEager();

    expect(isLanded('s1')).toBe(true);
  });

  it('reports the quarantined count in the status snapshot', async () => {
    seedSong('s1');
    seedSong('s2');
    const svc = service(new Date(2024, 0, 1, 12, 0));
    expect(svc.getState().status.quarantined).toBe(2);
  });
});
