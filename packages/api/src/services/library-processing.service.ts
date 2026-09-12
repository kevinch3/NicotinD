import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import type {
  ProcessingSettings,
  ProcessingStatus,
  ProcessingTaskId,
  ArtistInfoResult,
  GenreQuery,
  GenreResult,
} from '@nicotind/core';
import { maybeRunDailyHistoryRetention } from './privacy.js';
import { getProcessingSettings } from './processing-settings.js';
import { maybeRefreshAutoPlaylists } from './auto-playlists.service.js';
import { reapIdleItems } from './acquisition-job-store.js';
import { maybeRunDailyBackup } from './backup.js';
import { maybeRunDailyOrphanPrune } from './orphan-prune.js';
import { maybeRunDailyGenreCentroids } from './genre-centroids.js';
import {
  ENRICHMENT_TASKS,
  createEnrichmentContext,
  type EnrichmentContext,
  type EnrichmentTask,
} from './enrichment/tasks.js';
import type { AudioFeaturesClient } from './audio-features-client.js';
import { captureProcessingFailure, type ProcessingFailureReport } from '../observability/sentry.js';
import { countSkippedFiles } from './enrichment/analysis-failures.js';
import { maybeRunDailyCoverCachePrune } from './cover-cache-prune.js';
import { optimizeAlbum } from './metadata-optimize.js';

/**
 * How many songs one task claims per batch, and the worker-pool size for the
 * parallelisable tasks (BPM ffmpeg decodes and friends). Constants rather than
 * admin settings: they were exposed as a "compute regulator" alongside a
 * shared-GPU yield, and measurement (issue #224) found the trio moved neither
 * throughput nor GPU memory, so the panel bought complexity and nothing else.
 * Standing down for another tenant on the card is the `paused` flag's job now.
 */
const PROCESSING_BATCH_SIZE = 25;
const PROCESSING_CONCURRENCY = 3;

const log = createLogger('library-processing');

const STATUS_KEY = 'processing_status';
const MAX_SNIPPETS = 12;

/** Per-task failure tally accumulated over a run (task → count + one sample). */
type RunFailures = Map<ProcessingTaskId, { failed: number; sample: string | null }>;

/** Outcome of one bounded batch: items applied + per-task failures within it. */
interface BatchOutcome {
  applied: number;
  byTask: RunFailures;
}

/** Fold `src` into `dst`, summing counts and keeping the first sample per task. */
function mergeFailures(dst: RunFailures, src: RunFailures): void {
  for (const [task, agg] of src) {
    const prev = dst.get(task);
    if (prev) {
      prev.failed += agg.failed;
      if (prev.sample === null) prev.sample = agg.sample;
    } else {
      dst.set(task, { failed: agg.failed, sample: agg.sample });
    }
  }
}

export interface LibraryProcessingDeps {
  db: Database;
  lidarr: Lidarr | null;
  musicDir: string;
  dataDir: string;
  /** Spotify portrait lookup for the artist-image task, or null when unconfigured. */
  lookupArtistImageSpotify?: ((name: string) => Promise<string | null>) | null;
  lookupArtistImageDiscogs?:
    ((artist: { id: string; name: string }) => Promise<string | null>) | null;
  /** Discogs (or future) artist-info lookup for the artist-info task, or null when unconfigured. */
  lookupArtistInfo?: ((mbid: string) => Promise<ArtistInfoResult | null>) | null;
  /** Discogs (or future) release-genre lookup for the genre-discogs task (#194), or null. */
  lookupGenreForRelease?: ((query: GenreQuery) => Promise<GenreResult | null>) | null;
  /** Analysis-sidecar client for the audio-features task, or null when unconfigured. */
  audioFeaturesClient?: AudioFeaturesClient | null;
  /** Poll interval. Defaults to 60s. */
  intervalMs?: number;
  /** Injectable clock (daily-backup, orphan-prune and history guards). */
  now?: () => Date;
  /**
   * Songs one task claims per batch. A test seam, not a setting: it defaults to
   * PROCESSING_BATCH_SIZE and is exposed on no route, config file or UI. Tests
   * that assert "exactly one batch ran" need a batch smaller than the fixture,
   * and seeding 26 songs to observe a boundary would test the fixture, not the
   * batching.
   */
  batchSize?: number;
  /** Injectable context factory for unit tests (fakes ffmpeg/Lidarr primitives). */
  contextFactory?: (settings: ProcessingSettings) => EnrichmentContext;
  /** Disable file logging (tests). Default true. */
  logToFile?: boolean;
  /** Failure sink for a run's aggregated errors. Defaults to the Sentry reporter
   *  (a no-op when Sentry is unconfigured); injectable so tests can assert on it. */
  reportFailure?: (report: ProcessingFailureReport) => void;
}

/**
 * Library-processing scheduler. Runs enabled enrichment tasks (ENRICHMENT_TASKS)
 * over songs that still need them, continuously while enabled. Resume is
 * inherent: each task selects by its NULL predicate and writes incrementally, so
 * a restart continues exactly where it stopped. Modeled on WatchlistService
 * (start/stop interval + a busy guard).
 *
 * - `tick()` (periodic): one bounded batch per task when enabled and not paused.
 *   The 60s interval + busy guard make the work effectively continuous.
 * - `runNow()` (admin override): drains batches, overriding `paused`.
 * - `stop()`: halts the interval and any in-progress drain between tasks.
 */
export class LibraryProcessingService extends EventEmitter {
  private readonly db: Database;
  private readonly lidarr: Lidarr | null;
  private readonly musicDir: string;
  private readonly dataDir: string;
  private readonly lookupArtistImageSpotify: ((name: string) => Promise<string | null>) | null;
  private readonly lookupArtistImageDiscogs:
    ((artist: { id: string; name: string }) => Promise<string | null>) | null;
  private readonly lookupArtistInfo: ((mbid: string) => Promise<ArtistInfoResult | null>) | null;
  private readonly lookupGenreForRelease:
    ((query: GenreQuery) => Promise<GenreResult | null>) | null;
  private readonly audioFeaturesClient: AudioFeaturesClient | null;
  private readonly logPath: string;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly contextFactory: (settings: ProcessingSettings) => EnrichmentContext;
  private readonly logToFile: boolean;
  private readonly reportFailure: (report: ProcessingFailureReport) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopRequested = false;
  private status: ProcessingStatus;
  /** True until the first batch after construction: a restart is a session
   *  boundary. why: the restored tally belongs to the *previous* process (a
   *  deploy once carried 2300 pre-fix failures into a healthy run's display). */
  private freshProcess = true;
  /**
   * True while the work queue is known-empty, i.e. the last batch found nothing
   * pending. It is the session boundary for the failure tally: a "run" spans one
   * continuous drain, so the next batch that finds work again starts a fresh
   * tally. why: the tally is persisted and reloaded, so it needs *some* boundary
   * or a long-resolved failure ("38 failed — ffmpeg…") sticks on the panel
   * forever. This replaces the old window-session boundary, which disappeared
   * with the processing window; `phase === 'idle'` cannot stand in for it,
   * because finishRun() sets idle after *every* batch.
   */
  private drained = true;

  constructor(deps: LibraryProcessingDeps) {
    super();
    this.db = deps.db;
    this.lidarr = deps.lidarr;
    this.musicDir = deps.musicDir;
    this.dataDir = deps.dataDir;
    this.lookupArtistImageSpotify = deps.lookupArtistImageSpotify ?? null;
    this.lookupArtistImageDiscogs = deps.lookupArtistImageDiscogs ?? null;
    this.lookupArtistInfo = deps.lookupArtistInfo ?? null;
    this.lookupGenreForRelease = deps.lookupGenreForRelease ?? null;
    this.audioFeaturesClient = deps.audioFeaturesClient ?? null;
    this.logPath = join(deps.dataDir, 'library-processing.log');
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.now = deps.now ?? (() => new Date());
    this.batchSize = deps.batchSize ?? PROCESSING_BATCH_SIZE;
    this.contextFactory =
      deps.contextFactory ??
      (() =>
        createEnrichmentContext({
          musicDir: this.musicDir,
          coverCacheDir: join(this.dataDir, 'cover-cache'),
          lidarr: this.lidarr,
          concurrency: PROCESSING_CONCURRENCY,
          lookupArtistImageSpotify: this.lookupArtistImageSpotify,
          lookupArtistImageDiscogs: this.lookupArtistImageDiscogs,
          lookupArtistInfo: this.lookupArtistInfo,
          lookupGenreForRelease: this.lookupGenreForRelease,
          audioFeaturesClient: this.audioFeaturesClient,
          dataDir: this.dataDir,
        }));
    this.logToFile = deps.logToFile ?? true;
    this.reportFailure = deps.reportFailure ?? captureProcessingFailure;
    this.status = this.loadStatus();
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs }, 'Starting library-processing scheduler');
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Full shutdown: halt the interval and abort any in-progress run. */
  stop(): void {
    this.stopRequested = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Abort the current run (admin "Stop") without disabling the scheduler. */
  cancelRun(): void {
    this.stopRequested = true;
  }

  /** Settings + a freshly-computed status snapshot (pending counts, availability). */
  getState(): { settings: ProcessingSettings; status: ProcessingStatus } {
    const settings = getProcessingSettings(this.db);
    return { settings, status: this.snapshot(settings) };
  }

  /** Periodic tick: one batch when enabled and inside the window. */
  async tick(): Promise<void> {
    if (this.busy) return;
    // Daily data backup (marker-guarded, ≥04:00 local). Deliberately BEFORE the
    // enabled/window checks: backups must not depend on enrichment being on.
    maybeRunDailyBackup(this.db, { dataDir: this.dataDir, now: this.now().getTime() });
    // Daily orphan side-table prune (issue #259). Same placement rationale as
    // the backup: housekeeping must not depend on enrichment being enabled, and
    // it runs before the backup's next snapshot picks the freed bytes up.
    maybeRunDailyOrphanPrune(this.db, { now: this.now().getTime() });
    // Daily genre-centroid rebuild (docs/genre-affinity.md): one pass over the
    // stored embeddings, so the learned genre affinity tracks the library as
    // tags and analyses land. Same placement + marker-guard as the sweeps
    // above — a derived table must not depend on enrichment being enabled.
    if (maybeRunDailyGenreCentroids(this.db, { now: this.now().getTime() })) {
      log.info('genre centroids rebuilt');
    }
    // Daily cover-cache sweep (issue #311): the cache had no eviction at all —
    // prod measured 3.6 GB, 1.6 GB of it belonging to rows that are gone. Same
    // placement + marker-guard as the two above.
    const swept = maybeRunDailyCoverCachePrune(this.db, join(this.dataDir, 'cover-cache'), {
      now: this.now().getTime(),
    });
    if (swept?.deleted) log.info(swept, 'cover-cache prune');
    // Daily listening-history retention sweep (issue #454). Same placement and
    // marker-guard: a storage-limitation policy must not depend on enrichment
    // being enabled. No-op unless an operator set a cap (default: keep forever).
    const expired = maybeRunDailyHistoryRetention(this.db, { now: this.now().getTime() });
    if (expired) log.info({ deleted: expired }, 'history retention prune');
    // Acquisition idle valve (issue #710). Deliberately NOT marker-guarded like
    // the daily sweeps above: it used to run only at boot, which made a stable
    // host the worst case — an item crossing the 24 h threshold while the
    // server was up was never reaped, so a job with one stalled item read
    // "Organizing…" until the next restart. Same placement rationale: a
    // stranded download must not depend on enrichment being enabled.
    reapIdleItems(this.db, this.now().getTime());
    const settings = getProcessingSettings(this.db);
    if (!settings.enabled) {
      this.publish(settings, 'disabled');
      return;
    }
    // Paused (issue #224): a runtime throttle distinct from `enabled: false`.
    // Skip all background enrichment; an explicit `runNow()` overrides pause.
    if (settings.paused) {
      this.publish(settings, 'paused');
      return;
    }
    await this.guarded(async () => {
      // Once per ISO week, refresh the automated recipe-driven shelves
      // (idempotent; guarded by a library_sync_state marker).
      maybeRefreshAutoPlaylists(this.db, this.now().getTime());
      const batch = await this.processOneBatch(settings);
      this.flushFailures(batch.byTask);
      await this.fillNewAlbumMetadata(settings);
      this.finishRun(settings);
    });
  }

  /** Admin override: drain all pending work now, ignoring the time window. */
  async runNow(): Promise<void> {
    await this.guarded(async () => {
      const runFailures: RunFailures = new Map();
      let first = true;
      for (;;) {
        if (this.stopRequested) break;
        const settings = getProcessingSettings(this.db);
        const tasks = this.runnableTasks(settings);
        const pending = tasks.reduce((sum, t) => sum + t.countPending(this.db), 0);
        if (pending === 0) break;
        const batch = await this.processOneBatch(settings, first);
        mergeFailures(runFailures, batch.byTask);
        first = false;
        // No progress (e.g. every remaining file missing / unresolvable) → stop
        // rather than spin forever.
        if (batch.applied === 0) break;
      }
      // One aggregated Sentry event per failing task for the whole drain, so a
      // broken decoder reports once (grouped) rather than per file or per batch.
      this.flushFailures(runFailures);
      this.finishRun(getProcessingSettings(this.db));
    });
  }

  /**
   * Post-scan enrichment nudge, fired fire-and-forget from the scan seam. A
   * scanned song is library-visible at once (landing is instant), so nothing
   * here gates visibility; it exists so a fresh download gets its first batch
   * of enrichment — and its album a cover (issue #694) — now rather than at the
   * next tick. Honours `enabled`/`paused` for the enrichment batch (the tick's
   * policy), but always runs the cover fill: that is what a new album needs to
   * look right, and it is bounded per run. Guarded by the same `busy` lock as
   * tick/runNow — a no-op if a run is already underway. Never throws upward.
   */
  async enrichNewSongsNow(): Promise<void> {
    if (this.busy) return;
    await this.guarded(async () => {
      const settings = getProcessingSettings(this.db);
      if (settings.enabled && !settings.paused) {
        const batch = await this.processOneBatch(settings);
        this.flushFailures(batch.byTask);
      }
      await this.fillNewAlbumMetadata(getProcessingSettings(this.db));
      this.finishRun(getProcessingSettings(this.db));
    });
  }

  // --- internals -----------------------------------------------------------

  private async guarded(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // Each run starts with a clear cancellation token; cancelRun()/stop() set it
    // mid-run to abort between tasks/batches.
    this.stopRequested = false;
    try {
      await fn();
    } catch (err) {
      log.error({ err }, 'library-processing run failed');
    } finally {
      this.busy = false;
    }
  }

  /** Runnable = per-task enabled AND available right now. */
  private runnableTasks(settings: ProcessingSettings): EnrichmentTask[] {
    const ctx = this.contextFactory(settings);
    return ENRICHMENT_TASKS.filter((t) => settings.tasks[t.id] && t.available(ctx) === true);
  }

  /**
   * Albums given a canonical cover per run. Deliberately tiny: this is one
   * `album.lookup` each against Lidarr's shared upstream metadata proxy, on the
   * download path — the same rate-limit reasoning that keeps `optimizeAllAlbums`
   * serial (#622).
   */
  private static readonly NEW_ALBUM_METADATA_PER_RUN = 3;

  private static readonly ALBUM_METADATA_WATERMARK = 'album_metadata_watermark_v1';

  /**
   * Give a freshly-landed album its cover art (and, via the same match, any
   * missing track numbers) without waiting for an operator (issue #694).
   *
   * Album artwork had no automatic path at all: `library_artwork(kind='album')`
   * was written only by the admin-triggered optimizer or the metadata fixer, so a
   * fresh YT download — which carries no embedded art — showed a placeholder
   * indefinitely. On prod that was 2,561 of 4,923 albums.
   *
   * Bounded three ways, because this runs on the download path: at most
   * {@link NEW_ALBUM_METADATA_PER_RUN} albums per run, only albums with no
   * artwork row, and only those landed *after* the stored watermark — which
   * advances past each album as it is attempted. So every album is tried **once**
   * and a miss never becomes a per-tick Lidarr call forever. The Admin "Backfill
   * album & artist artwork" pass is the deliberate retry path for misses and for
   * anything that landed while Lidarr was down.
   *
   * Best-effort throughout: a Lidarr failure must never disturb landing.
   */
  private async fillNewAlbumMetadata(settings: ProcessingSettings): Promise<void> {
    if (!this.lidarr) return;
    const key = LibraryProcessingService.ALBUM_METADATA_WATERMARK;
    const since = Number(
      this.db
        .query<{ value: string }, [string]>('SELECT value FROM library_sync_state WHERE key = ?')
        .get(key)?.value ?? 0,
    );
    const rows = this.db
      .query<{ id: string; landed: number }, [number, number]>(
        `SELECT a.id AS id, MAX(s.landed_at) AS landed
           FROM library_albums a
           JOIN library_songs s ON s.album_id = a.id
          WHERE s.landed_at IS NOT NULL AND s.landed_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM library_artwork w WHERE w.id = a.id AND w.kind = 'album'
            )
          GROUP BY a.id
          ORDER BY landed ASC
          LIMIT ?`,
      )
      .all(since, LibraryProcessingService.NEW_ALBUM_METADATA_PER_RUN);
    if (rows.length === 0) return;

    const coverCacheDir = this.contextFactory(settings).coverCacheDir;
    for (const row of rows) {
      try {
        await optimizeAlbum(this.db, this.lidarr, row.id, { apply: true, coverCacheDir });
      } catch (err) {
        log.warn({ err, albumId: row.id }, 'new-album metadata fill failed');
      }
      // Advance per album, not once at the end: a crash mid-loop must not replay
      // the whole batch, and a miss must not be retried.
      this.db.run(
        `INSERT INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, String(row.landed), this.now().getTime()],
      );
    }
  }

  /** One bounded batch across each runnable task. */
  private async processOneBatch(
    settings: ProcessingSettings,
    fresh = false,
  ): Promise<BatchOutcome> {
    const ctx = this.contextFactory(settings);
    const tasks = this.runnableTasks(settings);
    const total = tasks.reduce((sum, t) => sum + t.countPending(this.db), 0);

    // A "run" spans one continuous drain: consecutive batches with work pending
    // continue the tally; the first batch after the queue ran dry (or after
    // re-enabling, a restart, or an explicit runNow) starts a fresh one. why:
    // the tally is persisted + reloaded, so without a session boundary a
    // long-resolved failure ("38 failed — ffmpeg…") stayed on the panel forever.
    // Only work *re-appearing* opens a new run. A batch that finds nothing must
    // NOT reset, or the "Processing complete — N enriched" summary would be
    // wiped by the very next tick, 60 s after finishing.
    const wasDrained = this.drained;
    this.drained = total === 0;
    const newRun =
      fresh || this.freshProcess || (wasDrained && total > 0) || this.status.phase === 'disabled';
    this.freshProcess = false;
    this.status = {
      ...this.status,
      phase: 'running',
      startedAt:
        newRun || this.status.startedAt === null ? this.now().toISOString() : this.status.startedAt,
      processed: newRun ? 0 : this.status.processed,
      failed: newRun ? 0 : this.status.failed,
      lastError: newRun ? null : this.status.lastError,
      total,
    };
    this.emitStatus(settings);

    let appliedTotal = 0;
    const byTask: RunFailures = new Map();
    for (const task of tasks) {
      if (this.stopRequested) break;
      this.status = { ...this.status, currentTask: task.id };
      const result = await task.run(this.db, ctx, this.batchSize);
      appliedTotal += result.applied;
      if (result.failed > 0) {
        mergeFailures(
          byTask,
          new Map([[task.id, { failed: result.failed, sample: result.errorSample }]]),
        );
      }
      this.status = {
        ...this.status,
        processed: this.status.processed + result.applied,
        failed: this.status.failed + result.failed,
        lastError: result.errorSample ?? this.status.lastError,
        lastItems: [...this.status.lastItems, ...result.labels].slice(-MAX_SNIPPETS),
      };
      for (const label of result.labels) this.writeLog(task.id, label);
      this.emitStatus(settings);
    }

    // Leave phase 'running' between batches; the run's terminal state is set once
    // by finishRun() so SSE clients see a single running→idle completion (not one
    // per batch during a multi-batch drain).
    this.status = { ...this.status, currentTask: null };
    this.emitStatus(settings);
    return { applied: appliedTotal, byTask };
  }

  /** Settle a finished run to idle and emit once, so clients get one completion. */
  private finishRun(settings: ProcessingSettings): void {
    this.status = { ...this.status, phase: 'idle', currentTask: null };
    this.emitStatus(settings);
  }

  /** Emit one aggregated failure report per task that failed during a run. */
  private flushFailures(byTask: RunFailures): void {
    for (const [task, agg] of byTask) {
      if (agg.failed <= 0) continue;
      log.warn(
        { task, failed: agg.failed, sample: agg.sample },
        'library-processing task failures',
      );
      this.reportFailure({ task, failed: agg.failed, applied: 0, sample: agg.sample });
    }
  }

  private snapshot(settings: ProcessingSettings): ProcessingStatus {
    const ctx = this.contextFactory(settings);
    const taskPending = {} as Record<ProcessingTaskId, number>;
    const availability = {} as Record<ProcessingTaskId, true | string>;
    for (const t of ENRICHMENT_TASKS) {
      taskPending[t.id] = t.countPending(this.db);
      availability[t.id] = t.available(ctx);
    }
    let phase = this.status.phase;
    if (!this.busy) {
      if (!settings.enabled) phase = 'disabled';
      else if (settings.paused) phase = 'paused';
      else phase = 'idle';
    }
    return {
      ...this.status,
      phase,
      taskPending,
      availability,
      skipped: countSkippedFiles(this.db),
      updatedAt: this.status.updatedAt,
    };
  }

  /** Persist + emit a snapshot for SSE subscribers. */
  private emitStatus(settings: ProcessingSettings): void {
    this.status = { ...this.status, updatedAt: this.now().toISOString() };
    this.persistStatus();
    this.emit('status', this.snapshot(settings));
  }

  /** Idle/disabled/paused publish without a batch. */
  private publish(settings: ProcessingSettings, phase: ProcessingStatus['phase']): void {
    this.status = { ...this.status, phase, currentTask: null };
    this.emitStatus(settings);
  }

  private writeLog(task: ProcessingTaskId, label: string): void {
    if (!this.logToFile) return;
    try {
      appendFileSync(this.logPath, `${this.now().toISOString()}\t${task}\t${label}\n`);
    } catch {
      /* best-effort logging */
    }
  }

  private persistStatus(): void {
    const persisted = {
      phase: this.status.phase,
      currentTask: this.status.currentTask,
      processed: this.status.processed,
      failed: this.status.failed,
      lastError: this.status.lastError,
      total: this.status.total,
      lastItems: this.status.lastItems,
      startedAt: this.status.startedAt,
      updatedAt: this.status.updatedAt,
    };
    this.db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [STATUS_KEY, JSON.stringify(persisted)],
    );
  }

  private loadStatus(): ProcessingStatus {
    const base: ProcessingStatus = {
      phase: 'idle',
      currentTask: null,
      processed: 0,
      failed: 0,
      lastError: null,
      total: 0,
      lastItems: [],
      startedAt: null,
      updatedAt: null,
      taskPending: {
        bpm: 0,
        genre: 0,
        key: 0,
        'artist-image': 0,
        'artist-info': 0,
        energy: 0,
        'audio-features': 0,
        descriptors: 0,
        'artist-identity': 0,
        'genre-audio': 0,
        'genre-discogs': 0,
        popularity: 0,
        'artist-origin': 0,
      },
      availability: {
        bpm: 'unknown',
        genre: 'unknown',
        key: 'unknown',
        'artist-image': 'unknown',
        'artist-info': 'unknown',
        energy: 'unknown',
        'audio-features': 'unknown',
        descriptors: 'unknown',
        'artist-identity': 'unknown',
        'genre-audio': 'unknown',
        'genre-discogs': 'unknown',
        popularity: 'unknown',
        'artist-origin': 'unknown',
      },
      skipped: 0,
    };
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get(STATUS_KEY);
    if (!row) return base;
    try {
      return { ...base, ...(JSON.parse(row.value) as Partial<ProcessingStatus>) };
    } catch {
      return base;
    }
  }
}
