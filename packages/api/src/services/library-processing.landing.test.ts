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
import { armReviewHold, recordReviewDecision, reviewHoldArmed } from './download-review-store.js';

/** `seedSong` mints all songs under this album id (see `seedSong` below). */
const ALBUM_ID_OF_S1 = 'alb';

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
    analyzeDescriptors: opts.sidecar ? async () => null : null,
    descriptorsAvailable: () => opts.sidecar ?? false,
    lookupGenre: async () => 'Rock',
    lookupArtistImageSpotify: async () => null,
    lookupArtistImageDiscogs: null,
    lookupArtistInfo: null,
    lookupGenreForRelease: null,
    resolveArtistIdentity: null,
    lookupLicence: async () => null,
    lookupPopularity: async () => new Map(),
    lookupArtistOrigin: null,
    lookupArtistReleaseGroups: null,
    fileExists: () => true,
  });
}

function service(
  now: Date,
  ctxOpts?: { bpmResult?: number | null; sidecar?: boolean },
  opts?: { acquisitionEnabled?: () => boolean },
) {
  return new LibraryProcessingService({
    db,
    lidarr: {} as never,
    musicDir: '/music',
    dataDir,
    now: () => now,
    contextFactory: fakeCtx(ctxOpts),
    acquisitionEnabled: opts?.acquisitionEnabled,
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

  it('holdForReview keeps an unapproved song quarantined even past the 24h valve', async () => {
    armReviewHold(db); // established library — bootstrap exemption already cleared
    seedSong('s1', '2024-01-01');
    setProcessingSettings(db, { holdForReview: true });
    const svc = service(new Date('2024-03-01T00:00:00Z')); // far past the valve
    await svc.runNow();
    expect(isLanded('s1')).toBe(false);
  });

  it('holdForReview is inert while acquisition is off (issue #416)', async () => {
    // With acquisition off the Downloads page — and the review inbox on it —
    // is hidden, so a manual drop must land rather than strand quarantined
    // behind an unreachable approval. The setting itself may predate the
    // acquisition switch-off, which is why the gate re-checks live state.
    armReviewHold(db);
    seedSong('s1');
    setProcessingSettings(db, {
      holdForReview: true,
      gates: { bpm: false, key: false, energy: false, genre: false },
    });
    const svc = service(new Date('2024-01-01T12:00:00Z'), undefined, {
      acquisitionEnabled: () => false,
    });
    await svc.runNow();
    expect(isLanded('s1')).toBe(true);
  });

  it('holdForReview lands an approved song', async () => {
    armReviewHold(db);
    seedSong('s1', '2024-01-01');
    setProcessingSettings(db, { holdForReview: true });
    recordReviewDecision(db, ALBUM_ID_OF_S1, 'approved', 'u1', new Date('2024-01-02'));
    const svc = service(new Date('2024-03-01T00:00:00Z'));
    await svc.runNow();
    expect(isLanded('s1')).toBe(true);
  });

  it('an approval older than the song does not land it (wave-2 / re-download rule)', async () => {
    armReviewHold(db);
    seedSong('s1', '2024-02-01');
    setProcessingSettings(db, { holdForReview: true });
    recordReviewDecision(db, ALBUM_ID_OF_S1, 'approved', 'u1', new Date('2024-01-02'));
    const svc = service(new Date('2024-03-01T00:00:00Z'));
    await svc.runNow();
    expect(isLanded('s1')).toBe(false);
  });

  it('review holds even when no enrichment steps are gated (empty-gate branch)', async () => {
    armReviewHold(db);
    seedSong('s1');
    setProcessingSettings(db, {
      holdForReview: true,
      gates: { bpm: false, key: false, energy: false, genre: false },
    });
    const svc = service(new Date('2024-01-01T12:00:00Z'));
    await svc.runNow();
    expect(isLanded('s1')).toBe(false);
  });

  it('a fresh (unarmed) bootstrap lands songs unreviewed even with the toggle on', async () => {
    // No armReviewHold in setup — a brand-new database whose first-ever
    // content is a download with holdForReview already on has nothing to
    // protect yet, so it lands rather than flooding a nonexistent inbox.
    expect(reviewHoldArmed(db)).toBe(false);
    seedSong('s1');
    setProcessingSettings(db, {
      holdForReview: true,
      gates: { bpm: false, key: false, energy: false, genre: false },
    });
    const svc = service(new Date('2024-01-01T12:00:00Z'));
    await svc.runNow();
    expect(isLanded('s1')).toBe(true);
    // Landing the quarantine fully drained it, so the marker armed itself.
    expect(reviewHoldArmed(db)).toBe(true);
  });

  it('armed after a bootstrap drain, the next quarantined song is held', async () => {
    seedSong('s1');
    setProcessingSettings(db, {
      holdForReview: true,
      gates: { bpm: false, key: false, energy: false, genre: false },
    });
    const svc = service(new Date('2024-01-01T12:00:00Z'));
    await svc.runNow();
    expect(isLanded('s1')).toBe(true);
    expect(reviewHoldArmed(db)).toBe(true);

    // A genuine new download arrives after the bootstrap has armed the marker.
    seedSong('s2');
    await svc.runNow();
    expect(isLanded('s2')).toBe(false);
  });

  it('runtime arming is independent of the holdForReview toggle', async () => {
    seedSong('s1');
    // Toggle off — the drain still arms the marker (arming is unconditional).
    setProcessingSettings(db, {
      gates: { bpm: false, key: false, energy: false, genre: false },
    });
    const svc = service(new Date('2024-01-01T12:00:00Z'));
    await svc.runNow();
    expect(isLanded('s1')).toBe(true);
    expect(reviewHoldArmed(db)).toBe(true);
  });

  it('a multi-batch bootstrap stays unarmed until the whole quarantine drains', async () => {
    seedSong('s1'); // will be forced to permanently-failed → lands this batch
    seedSong('stuck', '2024-01-01'); // no such ledger row → still quarantined
    db.run(
      `INSERT INTO library_song_analysis_failures (song_id, task, fail_count, last_error, file_size, last_attempt)
       VALUES ('s1', 'bpm', ?, 'corrupt', ?, 1)`,
      [MAX_ANALYSIS_ATTEMPTS, SIZE],
    );
    setProcessingSettings(db, {
      holdForReview: true,
      gates: { bpm: true, key: false, energy: false, genre: false },
    });
    // BPM never resolves for either song this run; 's1' still lands because
    // it's already at the permanent-failure cap, 'stuck' is inside the 24h
    // valve and stays quarantined — so the marker must stay unarmed.
    const svc = service(new Date(2024, 0, 1, 12, 0), { bpmResult: null });
    await svc.runNow();
    expect(isLanded('s1')).toBe(true);
    expect(isLanded('stuck')).toBe(false);
    expect(reviewHoldArmed(db)).toBe(false);

    // Past the safety valve, 'stuck' finally lands too — quarantine fully
    // drains and the marker arms.
    const svc2 = service(new Date(2024, 0, 3, 12, 0), { bpmResult: null });
    await svc2.runNow();
    expect(isLanded('stuck')).toBe(true);
    expect(reviewHoldArmed(db)).toBe(true);
  });
});
