/**
 * ServiceReview — the Admin page's single read-only snapshot of the running
 * server. Replaces the page's N independent fetchers (`systemStatus`,
 * `scanStatus`, `updateCheck`, `backups`, `audit`, `processing` summary,
 * `incompleteJobs`, `untracked`, hardware metrics) with one resource that one
 * poll keeps fresh. Every sub-fetch has a `try`/`catch` so a single broken
 * integration degrades that one field instead of dropping the whole response;
 * sub-fetches themselves are injected so the unit tests can drive every
 * degraded path without spawning processes or querying SQLite.
 *
 * Mounted at `GET /api/admin/review` (admin-only). Live updates that aren't
 * snapshot-shaped (logs SSE, processing SSE) stay on their own existing
 * endpoints — ServiceReview is the snapshot companion.
 */
import { Hono } from 'hono';
import type { ProcessingStatus } from '@nicotind/core';
import type { SlskdRef } from '../index.js';
import type { AuthEnv } from '../middleware/auth.js';
import {
  collectMetrics,
  type MetricsSnapshot,
  type GpuProbe,
  type OsShim,
} from '../services/system-metrics.js';
import { getDatabase } from '../db.js';
import { listAudit } from '../services/audit-log.js';
import { listBackups, type BackupInfo } from '../services/backup.js';
import {
  getStoredUpdateCheck,
  listVersionHistory,
  compareVersions,
} from '../services/update-check.js';
import { artistImageCoverage, type ArtistImageCoverage } from '../services/artist-image-fill.js';
import { countOrphanRows, type OrphanCount } from '../services/orphan-prune.js';
import { playEventCount } from '../services/play-history.js';
import { getProcessingSettings } from '../services/processing-settings.js';
import { pendingReviewStats, type PendingReviewStats } from '../services/download-review-store.js';

export type UpdateCheckSnapshot = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  releaseUrl: string | null;
  versionHistory: { version: string; firstSeenAt: number }[];
};

export type ProcessingSummary = Pick<
  ProcessingStatus,
  | 'phase'
  | 'currentTask'
  | 'processed'
  | 'failed'
  | 'total'
  | 'skipped'
  | 'quarantined'
  | 'taskPending'
  | 'availability'
  | 'startedAt'
  | 'updatedAt'
>;

export interface BackupsSummary {
  total: number;
  totalBytes: number;
  newestAt: number | null;
  lastBackupName: string | null;
}

export interface AuditEntry {
  id: number;
  at: number;
  userId: string;
  username: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  detail: string | null;
}

/** Compact album-job row for the Admin Incomplete-Albums panel. */
export interface IncompleteAlbumJob {
  id: number;
  lidarrAlbumId: number | null;
  artistName: string | null;
  albumTitle: string | null;
  username: string;
  directory: string;
  state: string;
  fallbackAttempts: number;
  createdAt: number;
}

/** Compact untracked-download row for the Admin Untracked panel. */
export interface UntrackedDownload {
  transferKey: string;
  username: string;
  directory: string;
  filename: string;
  basename: string;
  completedAt: number;
}

export interface ServiceReview {
  collectedAt: number;
  version: string;
  uptimeMs: number;
  hardware: MetricsSnapshot['hardware'];
  load: Pick<MetricsSnapshot, 'cpu' | 'memory' | 'gpu'>;
  services: {
    slskd: {
      configured: boolean;
      healthy: boolean;
      connected: boolean;
      username?: string;
      version?: string;
      uptime?: number;
    };
    /** Essentia analysis sidecar — the largest compute consumer (issue #224). */
    analysis: {
      /** NICOTIND_ANALYSIS_URL is set (the sidecar is part of this deployment). */
      configured: boolean;
      /** Reachable and reporting models loaded. */
      healthy: boolean;
    };
  };
  library: { scanning: boolean; indexedSongCount: number };
  updateCheck: UpdateCheckSnapshot | null;
  /** Full list of backups on disk (newest first) — drives the Admin's table. */
  backups: BackupInfo[];
  /** Compact summary for the header chip when the panel is collapsed. */
  backupsSummary: BackupsSummary;
  processing: ProcessingSummary | null;
  incompleteJobsCount: number;
  untrackedCount: number;
  /**
   * Per-song side-table rows whose owning song is gone (issue #259). Reported
   * rather than merely swept so an admin can see whether the daily prune is
   * keeping up — same spirit as `untracked`/`incompleteJobs`.
   */
  orphanRows: OrphanCount[];
  /**
   * Total listening-history rows. The history design deliberately keeps raw
   * events forever and revisits only if a measurement says otherwise — this is
   * that measurement. See docs/listening-history.md.
   */
  playEvents: number;
  /** Artist-portrait coverage for the Admin overview (issue #250). */
  artistImages: ArtistImageCoverage;
  /**
   * Pending hold-for-review count + oldest-waiting timestamp (issue #417) —
   * gated internally on `reviewHoldActive`, so this number always equals what
   * the Downloads inbox itself shows (off/unarmed → zeros).
   */
  downloadReviews: PendingReviewStats;
  auditTail: AuditEntry[];
  /** Snapshot of incomplete album hunts (active + exhausted) for the Admin panel. */
  incompleteJobs: IncompleteAlbumJob[];
  /** Snapshot of completed downloads with no recorded library path. */
  untracked: UntrackedDownload[];
  errors: string[];
}

export interface ReviewSubFns {
  collectMetrics: () => Promise<MetricsSnapshot>;
  systemStatus: () => Promise<{
    healthy: boolean;
    connected: boolean;
    username?: string;
    version?: string;
    uptime?: number;
  }>;
  scanStatus: () => Promise<{ scanning: boolean; count: number }>;
  /** Analysis-sidecar reachability. Default reads `deps.analysisClient`. */
  analysisStatus: () => Promise<{ configured: boolean; healthy: boolean }>;
  indexSongCount: () => number | Promise<number>;
  updateCheck: () => Promise<UpdateCheckSnapshot | null>;
  backupsList: () => BackupInfo[] | Promise<BackupInfo[]>;
  processingSummary: () => ProcessingSummary | null;
  incompleteJobCount: () => number;
  untrackedCount: () => number;
  orphanRows: () => OrphanCount[];
  playEvents: () => number;
  artistImages: () => ArtistImageCoverage;
  downloadReviews: () => PendingReviewStats;
  auditTail: (limit: number) => AuditEntry[];
  incompleteJobs: () => IncompleteAlbumJob[];
  untracked: () => UntrackedDownload[];
}

/** Carried-out (per-ride) dependencies for the route: the dataDir + processing
 *  service so the inline defaults can read them. `deps.subFns` overrides any
 *  single default — every key is optional, missing keys fall back. */
export interface ReviewRoutesDeps {
  version?: string;
  /** Where the backup directory lives (`<dataDir>/backups`). Required when the
   *  default `backupsList` runs; ignored entirely when `subFns.backupsList`
   *  is supplied. */
  dataDir?: string;
  /** Windowed processing service for the inline default. Required for the
   *  default `processingSummary` to return a non-null value; ignored entirely
   *  when `subFns.processingSummary` is supplied. */
  processing?: { getState: () => { status: ProcessingStatus } } | null;
  /** Essentia sidecar client; null/absent when NICOTIND_ANALYSIS_URL is unset. */
  analysisClient?: { healthy: () => Promise<boolean> } | null;
  /** Collects the metrics slice. Default = `collectMetrics()`. */
  collectMetrics?: () => Promise<MetricsSnapshot>;
  /** Injected OS shim — defaults to live `node:os`. */
  os?: OsShim;
  /** Injected GPU probe — defaults to `nvidia-smi`/`rocm-smi`/`system_profiler`. */
  gpuProbe?: GpuProbe;
  /** Sub-fetch overrides: every key is optional, missing keys fall back to
   *  the inline default (slskd-ref / SQLite / FS) implementations. */
  subFns?: Partial<ReviewSubFns>;
  /** Override for `uptimeMs` — exposed for tests. */
  now?: () => number;
}

/** Sidecar reachability. An unconfigured sidecar is not an error — it's the
 *  default deployment, so `configured: false` must never land in `errors[]`. */
async function defaultAnalysisStatus(
  client?: { healthy: () => Promise<boolean> } | null,
): Promise<{ configured: boolean; healthy: boolean }> {
  if (!client) return { configured: false, healthy: false };
  return { configured: true, healthy: await client.healthy() };
}

const DEFAULT_AUDIT_TAIL_LIMIT = 20;
const startTime = Date.now();

/**
 * Run a sub-fetch, swallow throws, and surface a one-line error tag. Keeps the
 * route robust against the inevitable "Lidarr 503 / slskd down / disk full"
 * case without losing the rest of the snapshot.
 */
async function safe<T>(
  errors: string[],
  label: string,
  fn: () => T | Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

// ─── default implementations of every sub-fetch ───────────────────────────────

async function defaultSystemStatus(slskdRef: SlskdRef) {
  let healthy = false;
  let connected = false;
  let username: string | undefined;
  let version: string | undefined;
  let uptime: number | undefined;
  if (slskdRef.current) {
    try {
      const state = await slskdRef.current.server.getState();
      healthy = true;
      connected = Boolean(state.isConnected);
      username = state.username ?? undefined;
    } catch {
      healthy = false;
    }
    if (healthy) {
      try {
        const info = await slskdRef.current.application.getInfo();
        version = info.version;
        uptime = info.uptime;
      } catch {
        /* /application optional */
      }
    }
  }
  return { healthy, connected, username, version, uptime };
}

function defaultScanStatus(): { scanning: boolean; count: number } {
  try {
    const db = getDatabase();
    const row = db
      .query<{ scanning: number | null; value: string | null; cnt: number }, []>(
        `SELECT (SELECT 1 FROM library_sync_state WHERE key = 'scanning' AND value = '1') AS scanning,
                (SELECT COUNT(*) FROM library_songs) AS cnt`,
      )
      .get();
    return { scanning: row?.scanning === 1, count: row?.cnt ?? 0 };
  } catch {
    return { scanning: false, count: 0 };
  }
}

function defaultIndexSongCount(): number {
  try {
    const db = getDatabase();
    const row = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM library_songs').get();
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function defaultUpdateCheck(version: string): UpdateCheckSnapshot {
  try {
    const db = getDatabase();
    const stored = getStoredUpdateCheck(db);
    const history = listVersionHistory(db);
    if (!stored) {
      return {
        currentVersion: version,
        latestVersion: null,
        updateAvailable: false,
        checkedAt: null,
        releaseUrl: null,
        versionHistory: history,
      };
    }
    const latest = stored.latestVersion;
    return {
      currentVersion: version,
      latestVersion: latest,
      updateAvailable:
        latest !== null && version !== 'unknown' && compareVersions(latest, version) > 0,
      checkedAt: stored.checkedAt,
      releaseUrl: stored.releaseUrl,
      versionHistory: history,
    };
  } catch {
    return {
      currentVersion: version,
      latestVersion: null,
      updateAvailable: false,
      checkedAt: null,
      releaseUrl: null,
      versionHistory: [],
    };
  }
}

function defaultBackups(dataDir?: string): BackupInfo[] {
  if (!dataDir) return [];
  try {
    return listBackups(dataDir);
  } catch {
    return [];
  }
}

/** Compact summary derived from the full backup list — used by the header chip. */
function summarizeBackups(list: BackupInfo[]): BackupsSummary {
  return {
    total: list.length,
    totalBytes: list.reduce((a, b) => a + b.sizeBytes, 0),
    newestAt: list[0]?.createdAt ?? null,
    lastBackupName: list[0]?.name ?? null,
  };
}

function defaultProcessing(
  proc?: { getState: () => { status: ProcessingStatus } } | null,
): ProcessingSummary | null {
  if (!proc) return null;
  try {
    const s = proc.getState().status;
    return {
      phase: s.phase,
      currentTask: s.currentTask,
      processed: s.processed,
      failed: s.failed,
      total: s.total,
      skipped: s.skipped,
      quarantined: s.quarantined,
      taskPending: s.taskPending,
      availability: s.availability,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
    };
  } catch {
    return null;
  }
}

function defaultAuditTail(limit: number): AuditEntry[] {
  try {
    return listAudit(getDatabase(), { limit, offset: 0 });
  } catch {
    return [];
  }
}

const INCOMPLETE_JOBS_LIMIT = 50;
const UNTRACKED_LIMIT = 50;

function defaultIncompleteJobs(): IncompleteAlbumJob[] {
  try {
    const db = getDatabase();
    return db
      .query<
        {
          id: number;
          lidarrAlbumId: number | null;
          artistName: string | null;
          albumTitle: string | null;
          username: string;
          directory: string;
          state: string;
          fallbackAttempts: number;
          createdAt: number;
        },
        []
      >(
        `SELECT id, lidarr_album_id AS lidarrAlbumId, artist_name AS artistName,
                album_title AS albumTitle, username, directory, state,
                fallback_attempts AS fallbackAttempts, created_at AS createdAt
         FROM album_jobs
         WHERE state IN ('exhausted', 'active')
         ORDER BY created_at DESC
         LIMIT ${INCOMPLETE_JOBS_LIMIT}`,
      )
      .all() as IncompleteAlbumJob[];
  } catch {
    return [];
  }
}

function defaultUntracked(): UntrackedDownload[] {
  try {
    const db = getDatabase();
    return db
      .query<
        {
          transferKey: string;
          username: string;
          directory: string;
          filename: string;
          basename: string;
          completedAt: number;
        },
        []
      >(
        `SELECT transfer_key AS transferKey, username, directory, filename, basename,
                completed_at AS completedAt
         FROM completed_downloads
         WHERE relative_path IS NULL
         ORDER BY completed_at DESC
         LIMIT ${UNTRACKED_LIMIT}`,
      )
      .all() as UntrackedDownload[];
  } catch {
    return [];
  }
}

/**
 * `Promise.all` over an object rather than an array, so slices are addressed by
 * **name** instead of by position.
 *
 * why: the gather used to destructure 13 names positionally out of one
 * `Promise.all([...])`, so adding a slice meant editing the name list and the
 * array in exact lockstep — and a mismatch was invisible to the type-checker
 * wherever two slices share a type (`incompleteJobsCount`/`untrackedCount` are
 * both `number`; `incompleteJobs`/`untracked` are both object arrays). A swap
 * type-checked cleanly and produced a wrong Admin panel. Keyed, a mismatch is a
 * compile error instead.
 *
 * Parallelism is unchanged: every `safe(...)` call runs while the object
 * literal is built, i.e. before the first await. Keeping them inside one
 * expression also means a later edit can't accidentally serialise them by
 * slipping an `await` between declarations.
 */
async function allNamed<T extends Record<string, Promise<unknown>>>(
  gatherers: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(gatherers) as Array<keyof T>;
  const values = await Promise.all(keys.map((k) => gatherers[k]));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as {
    [K in keyof T]: Awaited<T[K]>;
  };
}

// ─── route factory + handler ─────────────────────────────────────────────────

export function reviewRoutes(slskdRef: SlskdRef, deps: ReviewRoutesDeps = {}) {
  const sub = deps.subFns ?? {};
  const version = deps.version ?? 'unknown';
  const fallbackMetrics: MetricsSnapshot = {
    hardware: {
      cpuModel: 'unknown',
      cores: 0,
      arch: 'x64',
      platform: 'linux',
      totalMemoryBytes: 0,
      gpuDetected: null,
    },
    cpu: { percent: 0, cores: 0, model: 'unknown' },
    memory: { totalBytes: 0, usedBytes: 0, freeBytes: 0, processRssBytes: 0, processHeapBytes: 0 },
    gpu: null,
  };

  // Resolve the metrics call once: tests override either layer; the third
  // layer is the live module export. Each layer's contract is `Promise<MetricsSnapshot>`.
  const collectMetricsFn: (opts?: { os?: OsShim; probe?: GpuProbe }) => Promise<MetricsSnapshot> =
    sub.collectMetrics ?? deps.collectMetrics ?? collectMetrics;

  const app = new Hono<AuthEnv>();
  app.get('/', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    const errors: string[] = [];

    // Run every sub-fetch in parallel; defer the index count to after slskd /
    // scan so the cheaper DB queries overlap the network call.
    const {
      metrics,
      status,
      scan,
      analysis,
      updateCheck,
      backups,
      processing,
      incompleteCount,
      untracked,
      orphanRows,
      playEvents,
      artistImages,
      downloadReviews,
      audit,
      incompleteList,
      untrackedList,
    } = await allNamed({
      metrics: safe(
        errors,
        'metrics',
        () => collectMetricsFn({ os: deps.os, probe: deps.gpuProbe }),
        fallbackMetrics,
      ),
      status: safe(
        errors,
        'systemStatus',
        () => sub.systemStatus?.() ?? defaultSystemStatus(slskdRef),
        { healthy: false, connected: false } as Awaited<ReturnType<typeof defaultSystemStatus>>,
      ),
      scan: safe(
        errors,
        'scanStatus',
        () => sub.scanStatus?.() ?? Promise.resolve(defaultScanStatus()),
        { scanning: false, count: 0 },
      ),
      analysis: safe(
        errors,
        'analysisStatus',
        () => sub.analysisStatus?.() ?? defaultAnalysisStatus(deps.analysisClient),
        { configured: false, healthy: false },
      ),
      updateCheck: safe(
        errors,
        'updateCheck',
        () => sub.updateCheck?.() ?? Promise.resolve(defaultUpdateCheck(version)),
        null as UpdateCheckSnapshot | null,
      ),
      backups: safe(
        errors,
        'backups',
        () => sub.backupsList?.() ?? Promise.resolve(defaultBackups(deps.dataDir)),
        [] as BackupInfo[],
      ),
      processing: safe(
        errors,
        'processing',
        () => sub.processingSummary?.() ?? defaultProcessing(deps.processing),
        null as ProcessingSummary | null,
      ),
      incompleteCount: safe(
        errors,
        'incompleteJobsCount',
        () => sub.incompleteJobCount?.() ?? defaultIncompleteJobs().length,
        0,
      ),
      untracked: safe(
        errors,
        'untrackedCount',
        () => sub.untrackedCount?.() ?? defaultUntracked().length,
        0,
      ),
      orphanRows: safe(
        errors,
        'orphanRows',
        () => sub.orphanRows?.() ?? countOrphanRows(getDatabase()),
        [] as OrphanCount[],
      ),
      playEvents: safe(
        errors,
        'playEvents',
        () => sub.playEvents?.() ?? playEventCount(getDatabase()),
        0,
      ),
      artistImages: safe(
        errors,
        'artistImages',
        () => sub.artistImages?.() ?? artistImageCoverage(getDatabase()),
        { visible: 0, withPortrait: 0, missing: 0, manualOverride: 0 } as ArtistImageCoverage,
      ),
      downloadReviews: safe(
        errors,
        'downloadReviews',
        () =>
          sub.downloadReviews?.() ??
          pendingReviewStats(getDatabase(), getProcessingSettings(getDatabase()).holdForReview),
        { pending: 0, oldestCreated: null } as PendingReviewStats,
      ),
      audit: safe(
        errors,
        'auditTail',
        () =>
          sub.auditTail?.(DEFAULT_AUDIT_TAIL_LIMIT) ?? defaultAuditTail(DEFAULT_AUDIT_TAIL_LIMIT),
        [] as AuditEntry[],
      ),
      incompleteList: safe(
        errors,
        'incompleteJobsList',
        () => sub.incompleteJobs?.() ?? defaultIncompleteJobs(),
        [] as IncompleteAlbumJob[],
      ),
      untrackedList: safe(
        errors,
        'untrackedList',
        () => sub.untracked?.() ?? defaultUntracked(),
        [] as UntrackedDownload[],
      ),
    });

    const indexedSongCount = await safe(
      errors,
      'indexSongCount',
      () => sub.indexSongCount?.() ?? defaultIndexSongCount(),
      0,
    );

    const review: ServiceReview = {
      collectedAt: Date.now(),
      version,
      uptimeMs: (deps.now ?? (() => Date.now() - startTime))(),
      hardware: metrics.hardware,
      load: { cpu: metrics.cpu, memory: metrics.memory, gpu: metrics.gpu },
      services: {
        slskd: {
          configured: Boolean(slskdRef.current),
          healthy: status.healthy,
          connected: status.connected,
          username: status.username,
          version: status.version,
          uptime: status.uptime,
        },
        analysis,
      },
      library: { scanning: scan.scanning, indexedSongCount },
      updateCheck,
      backups,
      backupsSummary: summarizeBackups(backups),
      processing,
      incompleteJobsCount: incompleteCount,
      untrackedCount: untracked,
      orphanRows,
      playEvents,
      artistImages,
      downloadReviews,
      auditTail: audit,
      incompleteJobs: incompleteList,
      untracked: untrackedList,
      errors,
    };
    return c.json(review);
  });

  return app;
}
