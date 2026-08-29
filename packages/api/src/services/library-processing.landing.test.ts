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
import { NoConfidentResultError } from './track-analysis.js';
import { armReviewHold, recordReviewDecision, reviewHoldArmed } from './download-review-store.js';

/** `seedSong` mints all songs under this album id (see `seedSong` below). */
const ALBUM_ID_OF_S1 = 'alb';

let db: Database;
let dataDir: string;

const SIZE = 10;

/** Insert a quarantined (landed_at NULL) song. `created` controls the TTL valve. */
function seedSong(id: string, created = '2024-01-01'): void {
  seedSongInAlbum(id, ALBUM_ID_OF_S1, created);
}

/** Same as `seedSong`, but under an explicit album id — for landAlbumNow's
 *  album-scoping tests, which need a second, unrelated album to prove the
 *  drain never touches it. */
function seedSongInAlbum(id: string, albumId: string, created = '2024-01-01'): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, ?, ?, 'Artist', 'art', 0, ?, ?, 320, 'opus', 'audio/opus', ?, 1)`,
    [id, albumId, `T-${id}`, `Artist/Album/${id}.opus`, SIZE, created],
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
 * `onAnalyzeBpm` is a landAlbumNow test hook — a call-counting or clock-advancing
 * side effect, so a test can observe/steer exactly which songs got processed.
 */
function fakeCtx(
  opts: {
    bpmResult?: number | null;
    sidecar?: boolean;
    bpmConfidentNegative?: boolean;
    onAnalyzeBpm?: () => void;
  } = {},
) {
  const bpm = opts.bpmResult === undefined ? 120 : opts.bpmResult;
  // A *confident* negative: the analyzer ran and there is no tempo to find (too
  // short / no beat), signalled on the onError callback exactly as the real
  // analyzeBpm does. Distinct from a plain null, which means "environmental".
  const analyzeBpm: EnrichmentContext['analyzeBpm'] = opts.bpmConfidentNegative
    ? async (_abs, onError) => {
        onError?.(new NoConfidentResultError('audio too short to estimate a tempo'));
        return null;
      }
    : async () => bpm;
  return (): EnrichmentContext => ({
    musicDir: '/music',
    coverCacheDir: '/data/cover-cache',
    lidarr: {} as never,
    concurrency: 2,
    ffmpegAvailable: () => true,
    readTags: async () => ({}),
    writeTags: async () => true,
    analyzeBpm: async (abs, onError) => {
      opts.onAnalyzeBpm?.();
      return analyzeBpm(abs, onError);
    },
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
    lookupPopularity: async () => new Map(),
    lookupArtistOrigin: null,
    lookupArtistReleaseGroups: null,
    fileExists: () => true,
  });
}

function service(
  now: Date | (() => Date),
  ctxOpts?: {
    bpmResult?: number | null;
    sidecar?: boolean;
    bpmConfidentNegative?: boolean;
    onAnalyzeBpm?: () => void;
  },
  opts?: {
    acquisitionEnabled?: () => boolean;
    lidarr?: unknown;
    batchSize?: number;
    landAlbumTimeoutMs?: number;
    landAlbumPollMs?: number;
  },
) {
  return new LibraryProcessingService({
    db,
    lidarr: (opts?.lidarr ?? {}) as never,
    musicDir: '/music',
    dataDir,
    now: typeof now === 'function' ? now : () => now,
    contextFactory: fakeCtx(ctxOpts),
    acquisitionEnabled: opts?.acquisitionEnabled,
    batchSize: opts?.batchSize,
    landAlbumTimeoutMs: opts?.landAlbumTimeoutMs,
    landAlbumPollMs: opts?.landAlbumPollMs,
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

  it('a task that is not gate-eligible cannot gate landing (#691)', async () => {
    seedSong('s1');
    // `popularity` reads an external source that can confidently have no data for
    // a recording — the same shape as the licence task that stranded 261 songs in
    // #687. It is not `gateable`, so switching this flag on must be inert rather
    // than able to hold a download hostage.
    setProcessingSettings(db, {
      gates: { bpm: false, key: false, energy: false, genre: false, popularity: true },
    });
    await service(new Date(2024, 0, 1, 12, 0)).runNow();

    expect(isLanded('s1')).toBe(true);
  });

  it('lands a song whose gate step reports a confident negative on the first attempt (#689)', async () => {
    seedSong('s1');
    // BPM gates landing and the analyzer confidently reports "there is no tempo
    // here" (NoConfidentResultError) — a final answer, not a failed attempt. It
    // must not have to be re-asked MAX_ANALYSIS_ATTEMPTS times before the song
    // lands: that is what stranded 261 songs behind the licence gate in #687.
    setProcessingSettings(db, {
      gates: { bpm: true, key: false, energy: false, genre: false },
    });
    await service(new Date(2024, 0, 1, 12, 0), { bpmConfidentNegative: true }).runNow();

    expect(isLanded('s1')).toBe(true);
  });

  it('still holds a song whose gate step fails for an environmental reason (#689)', async () => {
    seedSong('s1');
    // A plain null is "the analyzer could not run", not "there is no answer" — it
    // must stay quarantined (until the 24h valve), or the terminal shortcut would
    // swallow real outages.
    setProcessingSettings(db, {
      gates: { bpm: true, key: false, energy: false, genre: false },
    });
    await service(new Date(2024, 0, 1, 12, 0), { bpmResult: null }).runNow();

    expect(isLanded('s1')).toBe(false);
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
      gates: { bpm: true, key: true, energy: true, genre: true },
    });
    // kickEager runs the gate steps + lands regardless of the periodic tick.
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

describe('a disabled processor still clears quarantine on the tick (issue #807)', () => {
  it('tick lands a gateless quarantined song and closes its processing-stage job', async () => {
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

    setProcessingSettings(db, {
      enabled: false,
      gates: { bpm: false, key: false, energy: false, genre: false },
    });
    await service(new Date(2024, 0, 1, 12, 0)).tick();

    expect(isLanded('s1')).toBe(true);
    expect(getJob(db, jobId)?.stage).toBe('done');
  });

  it('tick runs the gate steps for a fresh download while disabled (same stance as kickEager)', async () => {
    seedSong('s1');
    setProcessingSettings(db, {
      enabled: false,
      gates: { bpm: true, key: true, energy: true, genre: true },
    });
    await service(new Date(2024, 0, 1, 12, 0)).tick();

    expect(isLanded('s1')).toBe(true);
  });

  it('tick lands an approved song while disabled with the review hold armed', async () => {
    armReviewHold(db);
    seedSong('s1', '2024-01-01');
    setProcessingSettings(db, { enabled: false, holdForReview: true });
    recordReviewDecision(db, ALBUM_ID_OF_S1, 'approved', 'u1', new Date('2024-01-02'));
    await service(new Date('2024-03-01T00:00:00Z')).tick();

    expect(isLanded('s1')).toBe(true);
  });

  it('an unapproved song stays held while disabled with the review hold armed', async () => {
    armReviewHold(db);
    seedSong('s1', '2024-01-01');
    setProcessingSettings(db, { enabled: false, holdForReview: true });
    await service(new Date('2024-03-01T00:00:00Z')).tick();

    expect(isLanded('s1')).toBe(false);
  });

  it('with nothing quarantined the disabled tick just publishes and returns', async () => {
    setProcessingSettings(db, { enabled: false });
    const svc = service(new Date(2024, 0, 1, 12, 0));
    await svc.tick();

    expect(svc.getState().status.phase).toBe('disabled');
  });
});

describe('a freshly-landed album gets its cover automatically (issue #694)', () => {
  function seedAlbumRow(id: string, name: string, artist: string): void {
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES (?, ?, ?, 'art', 1, 0, 0)`,
      [id, name, artist],
    );
  }

  const artworkOf = (id: string): string | null =>
    db
      .query<{ cover_url: string }, [string]>(
        `SELECT cover_url FROM library_artwork WHERE id = ? AND kind = 'album'`,
      )
      .get(id)?.cover_url ?? null;

  /** Lidarr that matches the album and carries a cover. */
  const lidarrWithCover = () => ({
    album: {
      lookup: async () => [
        {
          id: 1,
          title: 'Album',
          artist: { artistName: 'Artist' },
          images: [{ coverType: 'cover', remoteUrl: 'https://img/cover.jpg', url: 'x' }],
        },
      ],
    },
    track: { listByAlbum: async () => [] },
  });

  it('fetches the cover for an album that just landed', async () => {
    seedAlbumRow('alb', 'Album', 'Artist');
    seedSong('s1');
    setProcessingSettings(db, { gates: { bpm: false, key: false, energy: false, genre: false } });

    await service(new Date(2024, 0, 1, 12, 0), undefined, {
      lidarr: lidarrWithCover(),
    }).kickEager();

    expect(isLanded('s1')).toBe(true);
    expect(artworkOf('alb')).toBe('https://img/cover.jpg');
  });

  it('does not re-attempt an album it has already tried', async () => {
    seedAlbumRow('alb', 'Album', 'Artist');
    seedSong('s1');
    setProcessingSettings(db, { gates: { bpm: false, key: false, energy: false, genre: false } });

    let lookups = 0;
    const counting = {
      album: {
        lookup: async () => {
          lookups += 1;
          return []; // no match — the album stays coverless
        },
      },
      track: { listByAlbum: async () => [] },
    };

    await service(new Date(2024, 0, 1, 12, 0), undefined, { lidarr: counting }).kickEager();
    await service(new Date(2024, 0, 1, 12, 1), undefined, { lidarr: counting }).kickEager();

    // The watermark moved past it: a miss must not become a per-tick Lidarr call
    // forever. The Admin artwork backfill is the retry path.
    expect(lookups).toBe(1);
  });
});

describe('landAlbumNow (curator-approve instant landing, issue #708)', () => {
  it("lands fast when this album's gate tasks are already satisfied", async () => {
    seedSong('s1');
    // Simulate background enrichment having already finished by review time —
    // the common case, since gate tasks run unconditionally in the background
    // regardless of review state.
    db.run(
      `UPDATE library_songs SET bpm = 120, key = 'C major', energy = 0.5, genre = 'Rock' WHERE id = 's1'`,
    );
    setProcessingSettings(db, { gates: { bpm: true, key: true, energy: true, genre: true } });
    const svc = service(new Date(2024, 0, 1, 12, 0));

    const result = await svc.landAlbumNow(ALBUM_ID_OF_S1);

    expect(result).toEqual({
      landed: true,
      timedOut: false,
      pendingSongCount: 0,
      pendingTasks: [],
    });
    expect(isLanded('s1')).toBe(true);
  });

  it("never touches a different, unrelated album's pending rows", async () => {
    seedSong('s1'); // target album (ALBUM_ID_OF_S1 = 'alb')
    seedSongInAlbum('other', 'other-alb');
    let bpmCalls = 0;
    setProcessingSettings(db, { gates: { bpm: true, key: false, energy: false, genre: false } });
    const svc = service(new Date(2024, 0, 1, 12, 0), { onAnalyzeBpm: () => bpmCalls++ });

    const result = await svc.landAlbumNow(ALBUM_ID_OF_S1);

    expect(result.landed).toBe(true);
    expect(isLanded('s1')).toBe(true);
    expect(isLanded('other')).toBe(false); // untouched — a different album's backlog
    expect(bpmCalls).toBe(1); // only s1 was ever analyzed, not the other album's song
  });

  it('waits for an in-flight run to release the shared lock, then lands (never no-ops like kickEager)', async () => {
    seedSong('s1');
    setProcessingSettings(db, { gates: { bpm: true, key: false, energy: false, genre: false } });
    const svc = service(new Date(2024, 0, 1, 12, 0), undefined, { landAlbumPollMs: 5 });
    // Simulate a concurrent tick/runNow already holding the lock.
    (svc as unknown as { busy: boolean }).busy = true;

    const resultPromise = svc.landAlbumNow(ALBUM_ID_OF_S1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isLanded('s1')).toBe(false); // still polling — busy hasn't released yet

    (svc as unknown as { busy: boolean }).busy = false;
    const result = await resultPromise;

    expect(result.landed).toBe(true);
    expect(isLanded('s1')).toBe(true);
  });

  it('returns timedOut: true, landed: false when the deadline elapses mid-drain', async () => {
    seedSong('s1');
    seedSong('s2');
    seedSong('s3');
    setProcessingSettings(db, { gates: { bpm: true, key: false, energy: false, genre: false } });

    // A clock that jumps 20s every time a song is analyzed — with batchSize 1
    // (one song per processOneBatch) and an 10s timeout, the loop lands
    // exactly one song before the next deadline check trips.
    let clock = new Date(2024, 0, 1, 12, 0).getTime();
    const svc = service(
      () => new Date(clock),
      { onAnalyzeBpm: () => (clock += 20_000) },
      { batchSize: 1, landAlbumTimeoutMs: 10_000 },
    );

    const result = await svc.landAlbumNow(ALBUM_ID_OF_S1);

    expect(result.landed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.pendingSongCount).toBe(2);
    expect(result.pendingTasks).toEqual(['bpm']);
  });
});
