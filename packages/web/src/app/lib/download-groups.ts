import type {
  AcquireJob,
  AcquisitionJobView,
  AcquisitionMethod,
  PipelineStage,
  SlskdUserTransferGroup,
  TrackStatus,
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
  /**
   * The acquisition job that enqueued this folder, when the server could link
   * it. This — not `albumId` — is what the feed groups on (issue #261): one job
   * is one card, however many peers it pulled from. Absent for genuinely
   * external transfers and for any whose linkage was lost.
   */
  jobId?: string;
  username: string;
  fileIds: string[];
  erroredFileIds: string[];
  totalFiles: number;
  completedFiles: number;
  overallPercent: number;
  /** Earliest file start time (ms), when slskd reports one. */
  startedAt?: number;
  state: 'downloading' | 'queued' | 'done' | 'error';
  /**
   * Dominant bitrate (kbps) across the folder's transfers, attached by the
   * server's `enrichWithBitrate` pass. Drives the "· 320 kbps" chip on the
   * download card. Optional: absent for direct enqueues / pre-feature rows.
   */
  bitrateKbps?: number;
  /** Codec/format string ("FLAC", "MP3", …). Optional. */
  audioFormat?: string;
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
        jobId: dir.albumJob?.jobId,
        username: transfer.username,
        fileIds: files.map((f) => f.id),
        erroredFileIds: erroredFiles.map((f) => f.id),
        totalFiles: files.length,
        completedFiles: completed,
        overallPercent,
        startedAt,
        state,
        bitrateKbps: dir.bitrateKbps,
        audioFormat: dir.audioFormat,
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
   * Set on the single collapsed "Unlinked transfers" row: slskd transfers
   * matching no job (genuinely external downloads, plus any whose linkage was
   * lost). One group, never N loose cards — but still reachable and cancellable.
   */
  unlinkedCount?: number;
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
   * Per-track status, uniform across every acquisition backend (slskd hunts
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
   * When this card collapses several slskd folder groups of one album
   * (multi-peer hunts, CD1/CD2 subfolders, fallback pulls), the member group
   * keys — actions (cancel/retry/remove) must fan out to every one of them.
   */
  memberKeys?: string[];
  /**
   * Dominant bitrate (kbps) of the card's downloads. For slskd, this is
   * rolled up from `enrichWithBitrate` (server joins acquisition_job_items +
   * library_songs.bit_rate per the "actual quality" path). For URL acquires,
   * it mirrors `AcquireJob.bitRate` (probed at ingest). Drives the "· 320
   * kbps" chip. Optional: absent when no item has a quality signature yet.
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
    jobId: g.jobId,
    startedAt: g.startedAt,
    progress: { done: g.completedFiles, total: albumGroupTotal(g) },
    percent: g.state === 'downloading' ? g.overallPercent : undefined,
    bitrateKbps: g.bitrateKbps,
    audioFormat: g.audioFormat,
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

/** Stages the unified job can advance a finished slskd row to (post-download). */
const POST_DOWNLOAD_STAGES: ReadonlySet<PipelineStage> = new Set([
  'organizing',
  'scanning',
  'processing',
  'done',
]);

/**
 * Collapse the slskd folder groups of ONE acquisition job (multi-peer hunts,
 * CD1/CD2 subfolders, alternate-peer fallback pulls) into a single card,
 * preferring the job's item tallies ("9 of 13") over per-folder file counts.
 * The card stays on the most-active member's stage while anything is still
 * moving, and only adopts the job's post-download stage once every folder
 * finished.
 *
 * `bitRate` / `audioFormat` come from the acquisition job when present (the
 * authoritative rollup across every item across every member), falling back to
 * the mode of the members when no job-level value is known yet.
 */
function collapseJobMembers(
  groupKey: string,
  members: DownloadItem[],
  job: AcquisitionJobView | undefined,
): DownloadItem {
  const base = members[0];
  const mostActive = members.reduce((a, b) =>
    STAGE_ORDER[b.stage] < STAGE_ORDER[a.stage] ? b : a,
  );
  const allDone = members.every((m) => m.stage === 'done');
  const stage =
    allDone && job && POST_DOWNLOAD_STAGES.has(job.stage) ? job.stage : mostActive.stage;

  const progress = job
    ? { done: job.progress.delivered, total: job.progress.expected }
    : {
        done: members.reduce((s, m) => s + (m.progress?.done ?? 0), 0),
        total: Math.max(...members.map((m) => m.progress?.total ?? 0)),
      };
  const percents = members.map((m) => m.percent).filter((p): p is number => p !== undefined);
  const startTimes = members.map((m) => m.startedAt).filter((t): t is number => t !== undefined);
  const unavailable = job && job.progress.unavailable > 0 ? job.progress.unavailable : undefined;
  // Authoritative source: the unified job (rolled up by listJobFeed including
  // library_songs upgrades). Fallback: mode across members.
  let collapsedBitrate: number | undefined;
  let collapsedFormat: string | undefined;
  if (job?.bitRate != null) {
    collapsedBitrate = job.bitRate;
    collapsedFormat = job.audioFormat;
  } else {
    const memberBitrates = members.map((m) => m.bitrateKbps).filter((b): b is number => !!b);
    if (memberBitrates.length > 0) {
      const counts = new Map<number, number>();
      for (const b of memberBitrates) counts.set(b, (counts.get(b) ?? 0) + 1);
      let best = 0;
      let bestCount = 0;
      for (const [kbps, c] of counts) {
        if (c > bestCount || (c === bestCount && kbps > best)) {
          best = kbps;
          bestCount = c;
        }
      }
      collapsedBitrate = best;
      collapsedFormat =
        members.find((m) => m.bitrateKbps === best)?.audioFormat ??
        members.find((m) => m.audioFormat)?.audioFormat;
    }
  }

  return {
    ...base,
    // Keyed on the job, so the card is stable however many peer folders the
    // job spans and however that set changes as fallback waves land.
    key: groupKey,
    stage,
    jobId: job?.id ?? base.jobId,
    sources: job?.sources,
    // The job's per-item statuses are authoritative for a collapsed album card
    // (same source as the tallies above) — the member groups have no
    // per-track granularity of their own to conflict with.
    tracks: job?.items,
    progress,
    percent:
      stage === 'downloading' && percents.length
        ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length)
        : undefined,
    startedAt: startTimes.length ? Math.min(...startTimes) : undefined,
    unavailable: unavailable ?? base.unavailable,
    bitrateKbps: collapsedBitrate ?? base.bitrateKbps,
    audioFormat: collapsedFormat ?? base.audioFormat,
    memberKeys: members.map((m) => m.key),
    canRetry: members.some((m) => m.canRetry),
    canCancel: members.some((m) => m.canCancel),
    canRemove: true,
  };
}

/**
 * Fold the unified acquisition jobs (`GET /api/downloads/jobs`) into the feed.
 *
 * **One job = one card.** Card identity is the `jobId` the server recorded at
 * enqueue time and now ships on every transfer directory — not a key re-derived
 * from album metadata at read time. That re-derivation is why one hunt kept
 * splitting into several cards: a fallback wave pulling from a second peer
 * produced a folder whose derived key didn't line up, and each fix only closed
 * one of the many ways it could fail to (issue #261). Keying on the job also
 * makes two *separate* jobs for the same album stay two cards, which the old
 * `albumId` collapse wrongly merged.
 *
 * Transfers matching no job — genuinely external downloads, plus any whose
 * linkage was lost — collapse into a single "Unlinked transfers" row rather
 * than N loose cards, so they stay visible and cancellable without dominating
 * the feed. URL jobs are skipped; the AcquireJob lane already renders them.
 */
export function mergeAcquisitionJobs(
  items: DownloadItem[],
  jobs: AcquisitionJobView[],
): DownloadItem[] {
  const merged: DownloadItem[] = [];
  const buckets = new Map<string, DownloadItem[]>();
  const unlinked: DownloadItem[] = [];
  for (const item of items) {
    if (item.kind !== 'slskd') {
      merged.push(item);
    } else if (item.jobId) {
      const list = buckets.get(item.jobId) ?? [];
      list.push(item);
      buckets.set(item.jobId, list);
    } else {
      unlinked.push(item);
    }
  }

  const jobById = new Map<string, AcquisitionJobView>();
  for (const job of jobs) {
    if (job.kind !== 'url') jobById.set(job.id, job);
  }

  for (const [jobId, members] of buckets) {
    merged.push(collapseJobMembers(`job:${jobId}`, members, jobById.get(jobId)));
  }

  for (const job of jobs) {
    if (job.kind === 'url') continue;
    if (buckets.has(job.id)) continue;
    // The raw transfers lane is gone (phase 3): every network job renders from
    // the feed row alone, finished ones included — the server's 7-day TTL prune
    // bounds the history, and a done card is what carries "Open in Library".
    merged.push({
      key: `job:${job.id}`,
      kind: 'slskd',
      title: job.albumTitle ?? job.artistName ?? job.sourceRef ?? job.id,
      subtitle: job.artistName ?? undefined,
      method: (job.method as AcquisitionMethod) ?? 'slskd',
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

  if (unlinked.length > 0) merged.push(collapseUnlinked(unlinked));

  return merged.sort((a, b) => {
    const byStage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (byStage !== 0) return byStage;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
}

/**
 * Fold every job-less slskd transfer into one row. These are downloads
 * NicotinD did not initiate (or whose job link was lost); they must stay
 * actionable, but a feed of loose peer-folder cards is exactly the noise the
 * job-as-card model exists to remove.
 */
export function collapseUnlinked(members: DownloadItem[]): DownloadItem {
  const mostActive = members.reduce((a, b) =>
    STAGE_ORDER[b.stage] < STAGE_ORDER[a.stage] ? b : a,
  );
  const percents = members.map((m) => m.percent).filter((p): p is number => p !== undefined);
  const startTimes = members.map((m) => m.startedAt).filter((t): t is number => t !== undefined);
  return {
    key: 'unlinked',
    kind: 'slskd',
    title: `Unlinked transfers (${members.length})`,
    method: 'slskd',
    stage: mostActive.stage,
    unlinkedCount: members.length,
    startedAt: startTimes.length ? Math.min(...startTimes) : undefined,
    progress: {
      done: members.reduce((s, m) => s + (m.progress?.done ?? 0), 0),
      total: members.reduce((s, m) => s + (m.progress?.total ?? 0), 0),
    },
    percent:
      mostActive.stage === 'downloading' && percents.length
        ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length)
        : undefined,
    memberKeys: members.map((m) => m.key),
    canRetry: members.some((m) => m.canRetry),
    canCancel: members.some((m) => m.canCancel),
    canRemove: true,
  };
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
