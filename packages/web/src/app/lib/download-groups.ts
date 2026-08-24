import type {
  AcquireJob,
  AcquisitionJobView,
  AcquisitionMethod,
  PipelineStage,
  TrackStatus,
} from '@nicotind/core';
import {
  downloadTitleFor,
  parseJobFailureSummary,
  summarizeFailures,
  type DownloadTitle,
  type FailureGroup,
} from '@nicotind/core';
import { methodBadge } from './acquisition-method';

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
  /**
   * The job's per-track failures grouped by class, when the addon reported them
   * (docs/download-pipeline.md "Failure breakdown"). Absent for a whole-job
   * crash, which has one reason and needs no breakdown.
   */
  failures?: FailureGroup[];
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

/** Map an acquisition-plugin/addon backend id to an AcquisitionMethod. Accepts
 *  both the legacy in-process ids (`ytdlp`/`spotdl`/`archive`/`slskd`) and the
 *  addon ids they became (`ytdlp-addon`/`spotdl-addon`/`bundled-archive`/
 *  `slskd-addon`) — otherwise an addon-backed job renders as "Unknown source"
 *  (issues #509, #532). `import` is here for the same reason: the admin
 *  folder-import flow has always written `method: 'import'`, so its 'Imported'
 *  badge was unreachable and every import rendered "? Unknown source". */
export function methodForBackend(backend: string): AcquisitionMethod {
  const base = backend === 'bundled-archive' ? 'archive' : backend.replace(/-addon$/, '');
  return base === 'ytdlp' ||
    base === 'spotdl' ||
    base === 'archive' ||
    base === 'slskd' ||
    base === 'import'
    ? base
    : 'unknown';
}

/**
 * Render the title chain's last rung — the one place the English source copy
 * lives, so it can be localized later rather than being baked into the
 * derivation (which is a pure, i18n-free core helper).
 *
 * "YouTube video" rather than "YouTube track": a single yt-dlp URL is a video,
 * and that is what the user pasted.
 */
export function renderDownloadTitle(title: DownloadTitle, method: AcquisitionMethod): string {
  if (title.kind === 'text') return title.text;
  const label = methodBadge(method).label;
  switch (title.urlKind) {
    case 'playlist':
      return `${label} playlist`;
    case 'album':
      return `${label} album`;
    case 'track':
      return method === 'ytdlp' ? `${label} video` : `${label} track`;
    default:
      return `${label} download`;
  }
}

/**
 * Group a job's per-track failures for the card, or `undefined` when the error
 * carries none — a single-reason failure reads better as the plain line it
 * already is than as a breakdown of one.
 */
function failureGroupsFor(error: string | null | undefined): FailureGroup[] | undefined {
  const groups = summarizeFailures(parseJobFailureSummary(error));
  return groups.length > 0 ? groups : undefined;
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

/**
 * Display label for an in-process acquire job. Runs the same shared chain as
 * the unified lane so the two can't drift — `job.label` is the display title,
 * the destination albums are the landed truth, and the pasted URL is the
 * fallback (a humanized slug where the host offers one, else the source label).
 */
export function acquireJobLabel(job: AcquireJob): string {
  const derived = downloadTitleFor({
    displayTitle: job.label,
    albumTitle: job.albumTitle,
    artistName: job.albumArtist,
    destinationAlbums: job.destinationAlbums,
    sourceUrl: job.url,
  });
  if (derived.kind === 'text') return derived.text;
  return renderDownloadTitle(derived, methodForBackend(job.backend));
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
    failures: failureGroupsFor(job.error),
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
  // An **addon**-run URL job has no `acquire_jobs` row; the unified lane is its
  // only rich source (peer/source breakdown, the friendly "Spotify download"
  // title, the job-scoped cancel/remove routes), so it always wins for those.
  // `GET /api/acquire/jobs` projects those same jobs so the Acquire page's link
  // card can track a pasted URL — that projection shares the job id, and
  // without this filter the very same download would render as two cards here.
  const addonUrlIds = new Set(
    jobs.filter((j) => j.kind === 'url' && j.sourceRef?.startsWith('addon:')).map((j) => j.id),
  );
  const merged: DownloadItem[] = items.filter((i) => !addonUrlIds.has(i.key));
  // A URL job rendered by the in-process `acquire_jobs` lane shares its id with
  // this `acquisition_jobs` mirror (same UUID), so skip it here to avoid a double
  // card. That lane stays authoritative for in-process jobs — it carries the
  // per-track list, destination albums and generated playlist id.
  const acquireKeys = new Set(merged.map((i) => i.key));

  for (const job of jobs) {
    if (job.kind === 'url' && acquireKeys.has(job.id)) continue;
    const method = methodForBackend(job.method ?? '');
    // One shared chain names every card (docs/download-pipeline.md "Card
    // titles"): the addon's own display title, else the canonical album, else
    // where the files landed, else the peer/source folder, else the pasted
    // link, and only then the bare source label. `sourceRef` is never a rung —
    // it holds the opaque `addon:<id>:<uuid>` key or an absolute import path.
    const derived = downloadTitleFor(job);
    const title = renderDownloadTitle(derived, method);
    // An admin import is a mirror row (docs/import.md): `import_jobs` owns its
    // lifecycle and its own routes, so the job-scoped controls don't apply.
    const isImport = job.kind === 'import';
    merged.push({
      key: `job:${job.id}`,
      kind: 'network',
      title,
      // Only when it adds something: the old unconditional artistName repeated
      // the title verbatim whenever the title had come from artistName.
      subtitle: derived.kind === 'text' ? derived.subtitle : (job.artistName ?? undefined),
      method,
      stage: job.stage,
      // Mirrors the acquire lane's rule: a job whose files landed in several
      // albums has no single "Open in Library" target, so it offers the
      // "View N albums" menu instead of both at once.
      albumId: (job.destinationAlbums?.length ?? 0) > 1 ? undefined : (job.albumId ?? undefined),
      // Set once an addon-run playlist job closes and the server generates the
      // native playlist (issue #587) — `canOpenPlaylist`/`playlistRoute` were
      // already built for the acquire lane and just needed this field.
      playlistId: job.playlistId ?? undefined,
      jobId: job.id,
      sources: job.sources,
      destinationAlbums: job.destinationAlbums?.length ? job.destinationAlbums : undefined,
      startedAt: job.createdAt,
      tracks: job.items,
      progress: { done: job.progress.delivered, total: job.progress.expected },
      unavailable: job.progress.unavailable > 0 ? job.progress.unavailable : undefined,
      error: job.error ?? undefined,
      failures: failureGroupsFor(job.error),
      // A failed URL acquire can be re-submitted — `POST /api/acquire/jobs/:id/
      // retry` has always supported it; the card simply never offered it. A
      // *partial* one closes 'done' carrying the addon's warning, and is the
      // case retry helps most: the addons resume rather than restart.
      canRetry:
        job.kind === 'url' && (job.stage === 'error' || (job.stage === 'done' && !!job.error)),
      // 'queued' counts: an addon URL job is mirrored at submit, before the
      // addon has fetched a byte, and a link that never resolves must not be
      // left with no control at all. An **import** is excluded: its card is a
      // mirror row with no addon behind it, so the job cancel route it would
      // call ("this download has nothing left to cancel") always 400s — and
      // that failure is now toasted rather than swallowed.
      canCancel: !isImport && (job.stage === 'downloading' || job.stage === 'queued'),
      // Removal is unconditional core-side (`DELETE /api/downloads/jobs/:id`
      // always drops the row, best-efforting the addon half), so gating it on a
      // stage the row can get stuck at is what made a ghost card undismissable.
      // An import in flight is the exception: `import_jobs` is authoritative
      // there, and dropping the mirror mid-run would orphan a live job.
      canRemove: !isImport || job.stage === 'done' || job.stage === 'error',
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
