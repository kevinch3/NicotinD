import type {
  AcquireJob,
  AcquisitionJobView,
  AcquisitionMethod,
  PipelineStage,
  TrackStatus,
} from '@nicotind/core';

// ─── Unified download feed ──────────────────────────────────────────────
//
// One normalized row type that network acquisition jobs and URL acquire jobs
// map into, so the Downloads → Active tab renders a single feed showing how
// (method), what stage, when, where, and the controls.

export type DownloadKind = 'network' | 'acquire';

export interface DownloadItem {
  key: string;
  kind: DownloadKind;
  /** Album title / URL label. */
  title: string;
  /** Artist for network hunts; absent for acquire. */
  subtitle?: string;
  method: AcquisitionMethod;
  stage: PipelineStage;
  /** When the download started (ms epoch), if known. */
  startedAt?: number;
  /** Canonical album dir the files landed in, once known. */
  storagePath?: string;
  /** Destination library album id, for deep-linking to the completed album. */
  albumId?: string;
  /**
   * The acquisition job this card *is* (issue #261). Card identity is the job
   * the server recorded at enqueue time, not a value re-derived from album
   * metadata at read time — so a hunt that fell back across five peers is one
   * card, and two separate jobs for the same album stay two cards.
   */
  jobId?: string;
  /**
   * Peers this job pulled from, for the "Sources (N)" disclosure. Straight from
   * `AcquisitionJobView.sources`; absent for non-job rows.
   */
  sources?: { username: string; fileCount: number; state: TrackStatus }[];
  /**
   * The full set of albums this job's files landed in, when known (URL
   * acquire jobs only). More than one entry means `albumId` above is null
   * (Task 1's design) — the row offers a "View N albums" menu instead of a
   * single "Open in Library" link.
   */
  destinationAlbums?: { albumArtist: string; albumTitle: string; albumId: string }[];
  /**
   * Native playlist generated from a playlist-classified acquire job (Spotify
   * playlist, YouTube playlist, archive.org item with `as=playlist`). When
   * set, the row offers an "Open playlist" deep-link to /library/playlists/:id.
   * Null for non-playlist jobs, for jobs whose post-ingest step hadn't run
   * yet, and for pre-feature rows. See docs/playlist-from-acquisition.md.
   */
  playlistId?: string;
  /**
   * Per-track status, uniform across every acquisition backend (network hunts
   * via the matched `AcquisitionJobView.items`, URL acquires via
   * `AcquireJob.tracks`) — the frontend doesn't need to know which backend a
   * job came from to render "now playing" / "up next".
   */
  tracks?: { title: string; status: TrackStatus }[];
  /** Completed / total tracks (or playlist items). */
  progress?: { done: number; total: number };
  /** 0–100 progress for the in-flight bar, when a percentage is meaningful. */
  percent?: number;
  error?: string;
  /** Tracks the fallback gave up on — renders "· K unavailable" (honest partial). */
  unavailable?: number;
  /**
   * Dominant bitrate (kbps) of the card's downloads, rolled up server-side
   * (`enrichWithBitrate` joins acquisition_job_items + library_songs.bit_rate)
   * or, for URL acquires, mirroring `AcquireJob.bitRate` (probed at ingest).
   * Drives the "· 320 kbps" chip. Absent when no item has a quality signature.
   */
  bitrateKbps?: number;
  /** Codec/format string ("FLAC", "MP3", …) attached alongside the bitrate. */
  audioFormat?: string;
  canRetry: boolean;
  canCancel: boolean;
  canRemove: boolean;
}

/** Map an acquisition-plugin backend id to an AcquisitionMethod. */
export function methodForBackend(backend: string): AcquisitionMethod {
  return backend === 'ytdlp' || backend === 'spotdl' || backend === 'archive' ? backend : 'unknown';
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
    destinationAlbums: job.destinationAlbums,
    playlistId: job.playlistId ?? undefined,
    tracks: job.tracks,
    progress,
    percent:
      stage === 'downloading' && progress && progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : undefined,
    error: job.error ?? undefined,
    bitrateKbps: job.bitRate ?? undefined,
    audioFormat: job.audioFormat ?? undefined,
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

/**
 * Fold the unified acquisition jobs (`GET /api/downloads/jobs`) into the feed.
 *
 * **One job = one card.** Card identity is the `jobId` the server recorded at
 * enqueue time — never a key re-derived from album metadata at read time, which
 * is why one hunt used to split into several cards (issue #261). Since phase 3
 * the raw transfers lane is gone: every network job renders from its feed row
 * alone, finished ones included — the server's TTL prune bounds the history,
 * and a done card is what carries "Open in Library". URL jobs are skipped; the
 * AcquireJob lane already renders them.
 */
export function mergeAcquisitionJobs(
  items: DownloadItem[],
  jobs: AcquisitionJobView[],
): DownloadItem[] {
  const merged: DownloadItem[] = [...items];

  for (const job of jobs) {
    if (job.kind === 'url') continue;
    merged.push({
      key: `job:${job.id}`,
      kind: 'network',
      title: job.albumTitle ?? job.artistName ?? job.sourceRef ?? job.id,
      subtitle: job.artistName ?? undefined,
      method: (job.method as AcquisitionMethod) ?? 'unknown',
      stage: job.stage,
      albumId: job.albumId ?? undefined,
      jobId: job.id,
      sources: job.sources,
      startedAt: job.createdAt,
      tracks: job.items,
      progress: { done: job.progress.delivered, total: job.progress.expected },
      unavailable: job.progress.unavailable > 0 ? job.progress.unavailable : undefined,
      error: job.error ?? undefined,
      canRetry: false,
      canCancel: job.stage === 'downloading',
      canRemove: job.stage === 'done' || job.stage === 'error',
    });
  }

  return merged.sort((a, b) => {
    const byStage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (byStage !== 0) return byStage;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
}

/** Sort URL acquire jobs into the unified feed shape for the Active tab. */
export function buildDownloadFeed(jobs: AcquireJob[]): DownloadItem[] {
  const items = jobs.map(acquireJobToDownloadItem);
  return items.sort((a, b) => {
    const byStage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (byStage !== 0) return byStage;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
}
