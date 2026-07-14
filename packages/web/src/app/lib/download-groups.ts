import type {
  AcquireJob,
  AcquisitionJobView,
  AcquisitionMethod,
  PipelineStage,
  SlskdUserTransferGroup,
} from '@nicotind/core';

export interface AlbumGroup {
  key: string;
  /** Peer folder name — fallback label for direct (non-hunt) downloads. */
  name: string;
  /** Canonical hunt metadata, present when the folder was acquired via a hunt. */
  artistName?: string;
  albumTitle?: string;
  /** Canonical Lidarr track count — the "of N" the album should contain. */
  expectedTracks?: number;
  /** Deterministic destination library album id, for deep-linking once scanned. */
  albumId?: string;
  username: string;
  fileIds: string[];
  erroredFileIds: string[];
  totalFiles: number;
  completedFiles: number;
  overallPercent: number;
  /** Earliest file start time (ms), when slskd reports one. */
  startedAt?: number;
  state: 'downloading' | 'queued' | 'done' | 'error';
}

/** Last path segment of a backslash-separated peer directory. */
export function extractAlbumName(directory: string): string {
  const segments = directory.split('\\').filter(Boolean);
  return segments[segments.length - 1] ?? directory;
}

/**
 * The primary label for a download row: the canonical album title when the
 * folder came from a hunt, otherwise the peer folder name.
 */
export function albumGroupTitle(g: AlbumGroup): string {
  return g.albumTitle ?? g.name;
}

/** The number to show as the "of N" total: canonical track count if known. */
export function albumGroupTotal(g: AlbumGroup): number {
  return g.expectedTracks && g.expectedTracks > 0 ? g.expectedTracks : g.totalFiles;
}

const STATE_ORDER: Record<AlbumGroup['state'], number> = {
  downloading: 0,
  queued: 1,
  error: 2,
  done: 3,
};

/**
 * Group slskd transfers by peer folder into per-album rows, carrying through any
 * canonical hunt metadata the server attached (`albumJob`). Sorted
 * downloading → queued → error → done.
 */
export function groupByAlbum(downloads: SlskdUserTransferGroup[]): AlbumGroup[] {
  const groups: AlbumGroup[] = [];
  for (const transfer of downloads) {
    for (const dir of transfer.directories) {
      const name = extractAlbumName(dir.directory);
      const key = `${transfer.username}:${dir.directory}`;
      const files = dir.files;
      const completed = files.filter((f) => f.state.includes('Succeeded')).length;
      const active = files.filter((f) => f.state === 'InProgress').length;
      const erroredFiles = files.filter(
        (f) =>
          f.state.includes('Errored') ||
          f.state.includes('Cancelled') ||
          f.state.includes('TimedOut') ||
          f.state.includes('Rejected'),
      );
      const errored = erroredFiles.length;
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      const transferredBytes = files.reduce((s, f) => s + f.bytesTransferred, 0);
      const overallPercent = totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;
      const startTimes = files
        .map((f) => (f.startedAt ? new Date(f.startedAt).getTime() : NaN))
        .filter((t) => Number.isFinite(t));
      const startedAt = startTimes.length > 0 ? Math.min(...startTimes) : undefined;

      let state: AlbumGroup['state'] = 'queued';
      if (completed === files.length) state = 'done';
      else if (active > 0) state = 'downloading';
      else if (errored > 0 && completed + errored === files.length) state = 'error';

      groups.push({
        key,
        name,
        artistName: dir.albumJob?.artistName,
        albumTitle: dir.albumJob?.albumTitle,
        expectedTracks: dir.albumJob?.canonicalTrackCount,
        albumId: dir.albumJob?.albumId,
        username: transfer.username,
        fileIds: files.map((f) => f.id),
        erroredFileIds: erroredFiles.map((f) => f.id),
        totalFiles: files.length,
        completedFiles: completed,
        overallPercent,
        startedAt,
        state,
      });
    }
  }
  return groups.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
}

// ─── Unified download feed ──────────────────────────────────────────────
//
// One normalized row type that both slskd album groups and URL acquire jobs map
// into, so the Downloads → Active tab renders a single feed showing how (method),
// what stage, when, where, and the controls — instead of two disjoint sections.

export type DownloadKind = 'slskd' | 'acquire';

export interface DownloadItem {
  key: string;
  kind: DownloadKind;
  /** Album title / URL label. */
  title: string;
  /** Artist for slskd hunts; absent for acquire. */
  subtitle?: string;
  method: AcquisitionMethod;
  stage: PipelineStage;
  /** When the download started (ms epoch), if known. */
  startedAt?: number;
  /** Canonical album dir the files landed in, once known. */
  storagePath?: string;
  /** Destination library album id, for deep-linking to the completed album. */
  albumId?: string;
  /** Completed / total tracks (or playlist items). */
  progress?: { done: number; total: number };
  /** 0–100 progress for the in-flight bar, when a percentage is meaningful. */
  percent?: number;
  error?: string;
  /** Tracks the fallback gave up on — renders "· K unavailable" (honest partial). */
  unavailable?: number;
  canRetry: boolean;
  canCancel: boolean;
  canRemove: boolean;
}

/** Map an acquisition-plugin backend id to an AcquisitionMethod. */
export function methodForBackend(backend: string): AcquisitionMethod {
  return backend === 'ytdlp' || backend === 'spotdl' || backend === 'archive' ? backend : 'unknown';
}

/** slskd group `state` → the coarse pipeline stage shown to the user. */
function slskdStage(state: AlbumGroup['state']): PipelineStage {
  return state; // states are a strict subset of PipelineStage
}

/** Acquire job `state` → stage, preferring the job's own fine-grained `stage`. */
function acquireStage(job: AcquireJob): PipelineStage {
  if (job.stage) return job.stage;
  switch (job.state) {
    case 'running':
      return 'downloading';
    case 'done':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return 'queued';
  }
}

/** Adapt a slskd album group into a unified download item. */
export function groupToDownloadItem(g: AlbumGroup): DownloadItem {
  return {
    key: g.key,
    kind: 'slskd',
    title: albumGroupTitle(g),
    subtitle: g.artistName,
    method: 'slskd',
    stage: slskdStage(g.state),
    albumId: g.albumId,
    startedAt: g.startedAt,
    progress: { done: g.completedFiles, total: albumGroupTotal(g) },
    percent: g.state === 'downloading' ? g.overallPercent : undefined,
    canRetry: g.state === 'error' && g.erroredFileIds.length > 0,
    canCancel: g.state === 'downloading' || g.state === 'queued',
    canRemove: true,
  };
}

/** Display label for an acquire job: its label, else a shortened URL. */
export function acquireJobLabel(job: AcquireJob): string {
  if (job.label) return job.label;
  try {
    const u = new URL(job.url);
    const path = u.pathname.length > 1 ? u.pathname.slice(0, 40) : '';
    return u.hostname + path;
  } catch {
    return job.url.slice(0, 50);
  }
}

/** Adapt a URL acquire job into a unified download item. */
export function acquireJobToDownloadItem(job: AcquireJob): DownloadItem {
  const stage = acquireStage(job);
  const progress = job.progress ?? undefined;
  return {
    key: job.id,
    kind: 'acquire',
    title: acquireJobLabel(job),
    method: methodForBackend(job.backend),
    stage,
    startedAt: job.created_at ? job.created_at * 1000 : undefined,
    storagePath: job.storage_path ?? undefined,
    albumId: job.albumId ?? undefined,
    progress,
    percent:
      stage === 'downloading' && progress && progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : undefined,
    error: job.error ?? undefined,
    // A 'done' job can still carry an error: a partial-download warning (e.g.
    // "1 of 16 tracks") rides in the same field as a hard failure so the row
    // can offer Retry instead of reading as an unqualified success.
    canRetry: job.state === 'failed' || (job.state === 'done' && !!job.error),
    canCancel: job.state === 'running' || job.state === 'queued',
    canRemove: job.state === 'done' || job.state === 'failed',
  };
}

// Active stages first, terminal last; within a stage, most-recently-started first.
const STAGE_ORDER: Record<PipelineStage, number> = {
  downloading: 0,
  organizing: 1,
  scanning: 2,
  processing: 3,
  queued: 4,
  error: 5,
  done: 6,
};

/** Stages the unified job can advance a finished slskd row to (post-download). */
const POST_DOWNLOAD_STAGES: ReadonlySet<PipelineStage> = new Set([
  'organizing',
  'scanning',
  'processing',
  'done',
]);

/**
 * Fold the unified acquisition jobs (`GET /api/downloads/jobs`) into the feed:
 * a slskd row whose transfers all succeeded adopts the job's post-download
 * stage (organizing → scanning → processing → done) and its unavailable count,
 * so the row keeps reporting until the album actually lands in the library.
 * Active jobs whose transfers vanished from slskd (restart, cleared list) are
 * appended as their own rows so a job in flight is never invisible. URL jobs
 * are skipped — the AcquireJob lane already renders them.
 */
export function mergeAcquisitionJobs(
  items: DownloadItem[],
  jobs: AcquisitionJobView[],
): DownloadItem[] {
  const merged = [...items];
  const byAlbumId = new Map<string, number>();
  merged.forEach((item, i) => {
    if (item.kind === 'slskd' && item.albumId) byAlbumId.set(item.albumId, i);
  });

  for (const job of jobs) {
    if (job.kind === 'url') continue;
    const idx = job.albumId != null ? byAlbumId.get(job.albumId) : undefined;
    if (idx !== undefined) {
      const item = merged[idx];
      // Only advance a row whose transfers are finished; an in-flight row keeps
      // its live progress/percent from slskd.
      if (item.stage === 'done' && POST_DOWNLOAD_STAGES.has(job.stage)) {
        merged[idx] = {
          ...item,
          stage: job.stage,
          unavailable: job.progress.unavailable > 0 ? job.progress.unavailable : item.unavailable,
        };
      } else if (job.progress.unavailable > 0) {
        merged[idx] = { ...item, unavailable: job.progress.unavailable };
      }
      continue;
    }
    // No live transfers for this job: only surface it while it's still active
    // (finished jobs with no transfers are history, not feed).
    if (job.state !== 'active') continue;
    merged.push({
      key: `acq:${job.id}`,
      kind: 'slskd',
      title: job.albumTitle ?? job.artistName ?? job.sourceRef ?? job.id,
      subtitle: job.artistName ?? undefined,
      method: (job.method as AcquisitionMethod) ?? 'slskd',
      stage: job.stage,
      albumId: job.albumId ?? undefined,
      startedAt: job.createdAt,
      progress: { done: job.progress.delivered, total: job.progress.expected },
      unavailable: job.progress.unavailable > 0 ? job.progress.unavailable : undefined,
      error: job.error ?? undefined,
      canRetry: false,
      canCancel: false,
      canRemove: false,
    });
  }
  return merged.sort((a, b) => {
    const byStage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (byStage !== 0) return byStage;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
}

/**
 * Merge slskd groups + acquire jobs into one sorted feed for the Active tab.
 */
export function buildDownloadFeed(groups: AlbumGroup[], jobs: AcquireJob[]): DownloadItem[] {
  const items = [...groups.map(groupToDownloadItem), ...jobs.map(acquireJobToDownloadItem)];
  return items.sort((a, b) => {
    const byStage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (byStage !== 0) return byStage;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
}
