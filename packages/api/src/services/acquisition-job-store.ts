import type { Database } from 'bun:sqlite';
import type { AcquireAlbumDestination, TrackStatus } from '@nicotind/core';
import { fold } from '@nicotind/core';
import { normalizeTitle, titlesOverlap } from '@nicotind/core';
import { albumIdFor } from './library-scanner.js';
import { jobDestinationAlbums } from './job-destinations.js';

/**
 * Unified acquisition job store (`acquisition_jobs` + `acquisition_job_items`).
 *
 * Every download — slskd hunt, fallback recovery, direct grab, track search,
 * URL acquire — is wrapped in one job whose transfer↔job linkage is stored at
 * enqueue time, replacing the read-time `(username, directory)` string
 * matching that used to lose per-track fallbacks and alternate-peer pulls.
 * `album_jobs` stays as the cross-peer fallback engine's private table
 * (linked via album_job_id); `acquire_jobs` stays authoritative for URL jobs
 * (the mirror row shares its uuid).
 */

/**
 * Artist/album pairs of every recorded acquisition — `album_jobs` UNION the
 * unified `acquisition_jobs` (the latter also covers track-search/direct grabs
 * that never create an album_jobs row). ONE home for the UNION the download-
 * suppression, curator-protection, and scanner-canonical readers each hand-wrote.
 * `activeOnly` restricts to in-flight jobs (`state='active'`). Missing tables
 * (minimal test DBs / slskd unconfigured) degrade to an empty list.
 */
export function jobAlbumPairs(
  db: Database,
  opts: { activeOnly?: boolean } = {},
): Array<{ artistName: string; albumTitle: string }> {
  const stateFilter = opts.activeOnly ? "state = 'active' AND " : '';
  try {
    return db
      .query<{ artist_name: string; album_title: string }, []>(
        `SELECT artist_name, album_title FROM album_jobs
         WHERE ${stateFilter}artist_name IS NOT NULL AND album_title IS NOT NULL
         UNION
         SELECT artist_name, album_title FROM acquisition_jobs
         WHERE ${stateFilter}artist_name IS NOT NULL AND album_title IS NOT NULL`,
      )
      .all()
      .map((r) => ({ artistName: r.artist_name, albumTitle: r.album_title }));
  } catch {
    return [];
  }
}

/**
 * Canonical Lidarr tracklists per recorded acquisition — the same `album_jobs`
 * UNION `acquisition_jobs`, restricted to rows carrying a `canonical_tracks_json`.
 * Parsed to string[]; unparseable/empty rows are skipped. Missing tables → [].
 */
export function jobCanonicalTracklists(
  db: Database,
): Array<{ artistName: string; albumTitle: string; canonicalTracks: string[] }> {
  let rows: Array<{ artist_name: string; album_title: string; canonical_tracks_json: string }>;
  try {
    rows = db
      .query<{ artist_name: string; album_title: string; canonical_tracks_json: string }, []>(
        `SELECT artist_name, album_title, canonical_tracks_json FROM album_jobs
         WHERE artist_name IS NOT NULL AND album_title IS NOT NULL AND canonical_tracks_json IS NOT NULL
         UNION
         SELECT artist_name, album_title, canonical_tracks_json FROM acquisition_jobs
         WHERE artist_name IS NOT NULL AND album_title IS NOT NULL AND canonical_tracks_json IS NOT NULL`,
      )
      .all();
  } catch {
    return [];
  }
  const out: Array<{ artistName: string; albumTitle: string; canonicalTracks: string[] }> = [];
  for (const r of rows) {
    let titles: unknown;
    try {
      titles = JSON.parse(r.canonical_tracks_json);
    } catch {
      continue;
    }
    if (!Array.isArray(titles) || titles.length === 0) continue;
    out.push({
      artistName: r.artist_name,
      albumTitle: r.album_title,
      canonicalTracks: titles as string[],
    });
  }
  return out;
}

export type AcquisitionJobKind =
  'album-hunt' | 'auto-acquire' | 'direct' | 'track-search' | 'url' | 'import';
export type AcquisitionJobItemState =
  'downloading' | 'completed' | 'organized' | 'scanned' | 'failed' | 'unavailable';

export interface CreateJobInput {
  kind: AcquisitionJobKind;
  method: string;
  artistName?: string | null;
  albumTitle?: string | null;
  /**
   * What the Downloads card is *called* — a playlist name, a video title, an
   * import's source folder. Never filing metadata: `albumTitle` mints an album
   * id and steers the organizer, so a playlist name belongs here instead.
   */
  displayTitle?: string | null;
  lidarrAlbumId?: number | null;
  releaseMbid?: string | null;
  artistMbid?: string | null;
  genres?: string[] | null;
  year?: number | null;
  canonicalTracks?: string[] | null;
  albumJobId?: number | null;
  sourceRef?: string | null;
  /**
   * The submitted link, for `kind:'url'` jobs. Persisted separately from
   * `sourceRef` (which holds the `addon:<id>:<jobId>` back-reference) so an
   * addon-run URL job still records what was pasted — that's what makes a
   * re-paste of an in-flight link recognisable instead of starting a second
   * download of the same thing.
   */
  sourceUrl?: string | null;
  /** Peer the items were enqueued from (slskd). Per-file username overrides this. */
  username?: string | null;
  files?: Array<{
    filename: string;
    size?: number;
    trackTitle?: string | null;
    /** Multi-peer jobs (track search) enqueue different files from different peers. */
    username?: string;
    /**
     * Enqueue-time quality from the slskd search response (`SlskdFile.bitRate`).
     * nil when the peer response didn't carry a bitrate (older slskd, unknown
     * codec). Stored on `acquisition_job_items.bit_rate_kbps` / `audio_format`
     * and rolled up by `listJobFeed`. Upgraded post-scan via the same item's
     * `library_songs.bit_rate` once `markItemsScanned` lands.
     */
    bitRate?: number | null;
    audioFormat?: string | null;
  }>;
  /** Share an existing id (URL jobs mirror acquire_jobs.id). */
  id?: string;
  /**
   * Opening stage. Defaults to the column default `'downloading'`, which is
   * honest for an enqueue that really has files moving — and a lie for a job
   * created *before* its source has resolved anything (an addon URL job: the
   * route mirrors the row at submit so the card appears instantly, but the
   * addon has not fetched a byte yet). Those pass `'queued'` so a link that
   * never resolves doesn't read as "Downloading 0 of 0".
   */
  stage?: 'queued' | 'downloading';
}

export interface AcquisitionJobItem {
  id: number;
  trackTitle: string | null;
  username: string | null;
  filename: string | null;
  transferKey: string | null;
  attempts: number;
  state: AcquisitionJobItemState;
  relativePath: string | null;
  songId: string | null;
  /** Enqueue-time bitrate (kbps) from the slskd `bitRate` search field; nil when unknown. */
  bitRate: number | null;
  /** Enqueue-time codec label from the slskd search response; nil when unknown. */
  audioFormat: string | null;
}

export interface AcquisitionJob {
  id: string;
  kind: AcquisitionJobKind;
  method: string;
  state: string;
  stage: string;
  artistName: string | null;
  albumTitle: string | null;
  lidarrAlbumId: number | null;
  releaseMbid: string | null;
  artistMbid: string | null;
  genres: string[] | null;
  year: number | null;
  canonicalTracks: string[] | null;
  albumJobId: number | null;
  sourceRef: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  items: AcquisitionJobItem[];
}

/**
 * The stored transfer identity: the EXACT enqueued username + remote filename.
 * Never normalized — backslashes and case must round-trip against what
 * slskd's getDownloads() echoes back (same contract as transfer_retries).
 */
export function transferKeyFor(username: string, filename: string): string {
  return `${username}::${filename}`;
}

/** Normalized basename for canonical-title matching (same shape album-fallback uses). */
function normalizeBasename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const noExt = base.slice(0, base.lastIndexOf('.') || base.length);
  return normalizeTitle(noExt);
}

/** Best-effort canonical title for an enqueued file, so the fallback can repoint it later. */
function matchTrackTitle(filename: string, canonicalTracks: string[]): string | null {
  const base = normalizeBasename(filename);
  return canonicalTracks.find((t) => titlesOverlap(normalizeTitle(t), base)) ?? null;
}

export function createJob(db: Database, input: CreateJobInput): string {
  const id = input.id ?? crypto.randomUUID();
  const now = Date.now();
  const insert = db.transaction(() => {
    db.run(
      `INSERT INTO acquisition_jobs
         (id, kind, method, stage, artist_name, album_title, display_title, lidarr_album_id,
          release_mbid, artist_mbid, genres_json, year, canonical_tracks_json, album_job_id,
          source_ref, source_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        input.method,
        input.stage ?? 'downloading',
        input.artistName ?? null,
        input.albumTitle ?? null,
        input.displayTitle ?? null,
        input.lidarrAlbumId ?? null,
        input.releaseMbid ?? null,
        input.artistMbid ?? null,
        input.genres?.length ? JSON.stringify(input.genres) : null,
        input.year ?? null,
        input.canonicalTracks?.length ? JSON.stringify(input.canonicalTracks) : null,
        input.albumJobId ?? null,
        input.sourceRef ?? null,
        input.sourceUrl ?? null,
        now,
        now,
      ],
    );
    for (const file of input.files ?? []) {
      const username = file.username ?? input.username ?? null;
      const trackTitle =
        file.trackTitle ??
        (input.canonicalTracks?.length
          ? matchTrackTitle(file.filename, input.canonicalTracks)
          : null);
      db.run(
        `INSERT INTO acquisition_job_items
           (job_id, track_title, username, filename, transfer_key, bit_rate_kbps, audio_format, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          trackTitle,
          username,
          file.filename,
          username ? transferKeyFor(username, file.filename) : null,
          file.bitRate ?? null,
          file.audioFormat ?? null,
          now,
        ],
      );
    }
  });
  insert();
  return id;
}

interface JobRow {
  id: string;
  kind: AcquisitionJobKind;
  method: string;
  state: string;
  stage: string;
  artist_name: string | null;
  album_title: string | null;
  display_title: string | null;
  lidarr_album_id: number | null;
  release_mbid: string | null;
  artist_mbid: string | null;
  genres_json: string | null;
  year: number | null;
  canonical_tracks_json: string | null;
  album_job_id: number | null;
  source_ref: string | null;
  source_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  id: number;
  track_title: string | null;
  username: string | null;
  filename: string | null;
  transfer_key: string | null;
  attempts: number;
  state: AcquisitionJobItemState;
  relative_path: string | null;
  song_id: string | null;
  bit_rate_kbps: number | null;
  audio_format: string | null;
}

function parseJsonArray(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function mapItem(row: ItemRow): AcquisitionJobItem {
  return {
    id: row.id,
    trackTitle: row.track_title,
    username: row.username,
    filename: row.filename,
    transferKey: row.transfer_key,
    attempts: row.attempts,
    state: row.state,
    relativePath: row.relative_path,
    songId: row.song_id,
    bitRate: row.bit_rate_kbps,
    audioFormat: row.audio_format,
  };
}

function mapJob(row: JobRow, items: ItemRow[]): AcquisitionJob {
  return {
    id: row.id,
    kind: row.kind,
    method: row.method,
    state: row.state,
    stage: row.stage,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    lidarrAlbumId: row.lidarr_album_id,
    releaseMbid: row.release_mbid,
    artistMbid: row.artist_mbid,
    genres: parseJsonArray(row.genres_json),
    year: row.year,
    canonicalTracks: parseJsonArray(row.canonical_tracks_json),
    albumJobId: row.album_job_id,
    sourceRef: row.source_ref,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map(mapItem),
  };
}

export function getJob(db: Database, id: string): AcquisitionJob | null {
  const row = db.query<JobRow, [string]>(`SELECT * FROM acquisition_jobs WHERE id = ?`).get(id);
  if (!row) return null;
  const items = db
    .query<ItemRow, [string]>(`SELECT * FROM acquisition_job_items WHERE job_id = ? ORDER BY id`)
    .all(id);
  return mapJob(row, items);
}

export interface TransferJobMeta {
  jobId: string;
  kind: AcquisitionJobKind;
  artistName: string | null;
  albumTitle: string | null;
  lidarrAlbumId: number | null;
  genres: string[] | null;
  year: number | null;
  canonicalTracks: string[] | null;
}

/** States that can still change peer/outcome — everything but a delivered file. */
const REPOINTABLE_STATES = `('downloading', 'failed', 'unavailable')`;
/** States still waiting on pipeline progress (used by the idle valve). */
const NON_TERMINAL_STATES = `('downloading', 'completed', 'organized')`;

/** Idle valve: a job whose non-terminal items saw no activity for this long is closed out. */
const ITEM_IDLE_VALVE_MS = 24 * 3_600_000;
/** Finished jobs older than this are pruned (mirrors AcquireWatcher's 7-day sweep). */
const FINISHED_JOB_TTL_MS = 7 * 24 * 3_600_000;

export function markItemCompleted(db: Database, transferKey: string): void {
  db.run(
    `UPDATE acquisition_job_items SET state = 'completed', updated_at = ?
     WHERE transfer_key = ? AND state IN ${NON_TERMINAL_STATES}`,
    [Date.now(), transferKey],
  );
}

export function markItemOrganized(db: Database, transferKey: string, relativePath: string): void {
  db.run(
    `UPDATE acquisition_job_items SET state = 'organized', relative_path = ?, updated_at = ?
     WHERE transfer_key = ?`,
    [relativePath, Date.now(), transferKey],
  );
}

/**
 * Attach scanned song ids to items by their post-organize relative path.
 *
 * Matched `COLLATE NOCASE`: the organizer records the path it wrote, while the
 * scanner mints `library_songs.path` from the file's tags, and the two disagree
 * on casing often enough to strand items (prod: `01 - ¿Quién te dijo eso.opus`
 * organized vs `01 - ¿Quién Te Dijo Eso.opus` scanned — issue #262).
 */
export function markItemsScanned(db: Database, pathToSongId: Map<string, string>): void {
  const now = Date.now();
  for (const [relativePath, songId] of pathToSongId) {
    db.run(
      `UPDATE acquisition_job_items SET state = 'scanned', song_id = ?, updated_at = ?
       WHERE relative_path = ? COLLATE NOCASE AND state != 'scanned'`,
      [songId, now, relativePath],
    );
  }
}

/**
 * Re-resolve items stuck at `organized` against the library.
 *
 * why: `markItemsScanned` only ever runs over the relative paths of the scan
 * batch that just finished. An item organized by a *different* batch — a
 * fallback wave landing after the primary's scan, a duplicate copy deduped into
 * an existing path, a scan that errored mid-batch — is never revisited, so it
 * sits at `organized` forever and `recomputeStage` correctly refuses to close a
 * job whose items are non-terminal. That is the actual mechanism behind the
 * jobs stranded at `state=active, stage=scanning`: on prod, 20 of the 28
 * stranded items already had a `library_songs` row at their exact recorded
 * path — nothing was ever going to look again.
 *
 * Idempotent and cheap (bounded by the number of non-terminal items), so it can
 * run on every hygiene pass. Returns the number of items rescued.
 */
export function reconcileOrganizedItems(db: Database): number {
  const rows = db
    .query<{ id: number; job_id: string; relative_path: string }, []>(
      `SELECT id, job_id, relative_path FROM acquisition_job_items
       WHERE state = 'organized' AND relative_path IS NOT NULL`,
    )
    .all();
  if (rows.length === 0) return 0;

  const now = Date.now();
  const touched = new Set<string>();
  let rescued = 0;
  /**
   * Accent-folded path → song id, built lazily and only when an exact match has
   * already failed — see `resolveByFoldedPath`.
   */
  let foldedIndex: Map<string, string> | null = null;

  const resolveByFoldedPath = (relativePath: string): string | null => {
    if (!foldedIndex) {
      foldedIndex = new Map();
      for (const s of db
        .query<{ id: string; path: string }, []>(`SELECT id, path FROM library_songs`)
        .all()) {
        // First writer wins: two paths folding alike is pathological, and
        // picking either is better than dropping both.
        if (!foldedIndex.has(fold(s.path))) foldedIndex.set(fold(s.path), s.id);
      }
    }
    return foldedIndex.get(fold(relativePath)) ?? null;
  };

  for (const row of rows) {
    const exact = db
      .query<{ id: string }, [string]>(`SELECT id FROM library_songs WHERE path = ? COLLATE NOCASE`)
      .get(row.relative_path);
    // why the fallback: SQLite's NOCASE folds ASCII case ONLY, never diacritics,
    // so an organizer-recorded `Los Autenticos Decadentes/…` never matches the
    // library's `Los Auténticos Decadentes/…`. Measured on prod: a job sat at
    // `scanning` for 23 h with four organized items whose files were present the
    // whole time under the accented spelling. Same `fold()` the search matcher
    // and hunt scorer already use for exactly this Latin-American accent gap.
    const songId = exact?.id ?? resolveByFoldedPath(row.relative_path);
    if (!songId) continue;
    db.run(
      `UPDATE acquisition_job_items SET state = 'scanned', song_id = ?, updated_at = ? WHERE id = ?`,
      [songId, now, row.id],
    );
    touched.add(row.job_id);
    rescued++;
  }
  for (const jobId of touched) recomputeStage(db, jobId);
  return rescued;
}

/**
 * Post-scan album backfill for a **direct** grab (issue #223). A raw
 * peer-browse / single-file grab has no canonical Lidarr metadata — its
 * enqueue-time `artist_name`/`album_title` are best-effort guesses parsed from
 * the peer's folder segments (often noisy, sometimes absent), so the Downloads
 * feed row and the "Open in Library" deep-link resolve to the wrong album or
 * nothing. Once the file has actually landed we know exactly *where* it went:
 * the scanned item's `song_id` → `library_songs.album_id` → the canonical
 * `library_albums` row. Re-point the job's `artist_name`/`album_title` to that
 * album's canonical artist+name so `albumIdFor(artistName, albumTitle)` (used by
 * the feed + `enrichWithAcquisitionJobs`) reproduces the real album id.
 *
 * Restricted to `kind='direct'` on purpose — hunt/auto-acquire/track-search
 * jobs carry authoritative canonical metadata that must never be overwritten by
 * a post-scan guess. When a grab spanned several albums the dominant (mode)
 * landed album wins, matching the one-card-per-job feed model. Best-effort: a
 * missing `library_albums` table (minimal test DB) or no scanned item degrades
 * to a no-op, never throwing into the watcher's scan seam.
 */
export function backfillDirectJobAlbum(db: Database, jobId: string): void {
  const job = db
    .query<{ kind: string }, [string]>(`SELECT kind FROM acquisition_jobs WHERE id = ?`)
    .get(jobId);
  if (!job || job.kind !== 'direct') return;
  let dominant: { artist: string; name: string } | undefined;
  try {
    const row = db
      .query<{ artist: string; name: string; c: number }, [string]>(
        `SELECT a.artist AS artist, a.name AS name, COUNT(*) AS c
         FROM acquisition_job_items i
         JOIN library_songs s ON s.id = i.song_id
         JOIN library_albums a ON a.id = s.album_id
         WHERE i.job_id = ? AND i.state = 'scanned' AND i.song_id IS NOT NULL
         GROUP BY a.id
         ORDER BY c DESC, a.name ASC
         LIMIT 1`,
      )
      .get(jobId);
    if (row) dominant = { artist: row.artist, name: row.name };
  } catch {
    return; // library_songs / library_albums not present — nothing to backfill.
  }
  if (!dominant) return;
  db.run(
    `UPDATE acquisition_jobs SET artist_name = ?, album_title = ?, updated_at = ?
     WHERE id = ? AND kind = 'direct'`,
    [dominant.artist, dominant.name, Date.now(), jobId],
  );
}

/**
 * Fallback re-enqueue: point the matching still-missing item at a new peer.
 * Restricted to non-completed items so an overlapping title can never
 * mislabel a delivered file. Returns false when nothing safe matched.
 *
 * `bitRate` and `audioFormat` are optional and refresh-on-known only:
 * passing a value upgrades the existing row, omitting them preserves the
 * previously-known quality (so an unknown-quality alternate-peer pull never
 * downgrades a card from "320 kbps" to "no info").
 */
export function repointItem(
  db: Database,
  jobId: string,
  trackTitle: string,
  username: string,
  filename: string,
  bitRate?: number | null,
  audioFormat?: string | null,
): boolean {
  const candidates = db
    .query<{ id: number; track_title: string | null }, [string]>(
      `SELECT id, track_title FROM acquisition_job_items
       WHERE job_id = ? AND state IN ${REPOINTABLE_STATES}`,
    )
    .all(jobId);
  const wanted = normalizeTitle(trackTitle);
  const match = candidates.find(
    (c) => c.track_title && titlesOverlap(normalizeTitle(c.track_title), wanted),
  );
  if (!match) return false;
  // Two parallel updates: peer identity (always) + quality (refresh-on-known).
  // Splitting keeps the non-quality path zero-cost for fallback waves that
  // already have nothing new to add (the dominant case).
  db.run(
    `UPDATE acquisition_job_items
     SET username = ?, filename = ?, transfer_key = ?, state = 'downloading',
         attempts = attempts + 1, updated_at = ?
     WHERE id = ?`,
    [username, filename, transferKeyFor(username, filename), Date.now(), match.id],
  );
  if (bitRate != null || audioFormat != null) {
    db.run(
      `UPDATE acquisition_job_items
       SET bit_rate_kbps = COALESCE(?, bit_rate_kbps),
           audio_format  = COALESCE(?, audio_format)
       WHERE id = ?`,
      [bitRate ?? null, audioFormat ?? null, match.id],
    );
  }
  return true;
}

/** The unified job that owns a fallback `album_jobs` row, if one was recorded. */
export function acquisitionJobIdForAlbumJob(db: Database, albumJobId: number): string | null {
  const row = db
    .query<{ id: string }, [number]>(
      `SELECT id FROM acquisition_jobs WHERE album_job_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(albumJobId);
  return row?.id ?? null;
}

/**
 * Repoint the matching item, or attach a fresh one when no safe match exists
 * (defensive: a fallback wave for a track the job never itemised must still
 * be linked, not lost). `bitRate`/`audioFormat` thread through to both branches
 * (repoint uses refresh-on-known; attach records them as the seed quality).
 */
export function repointOrAttachItem(
  db: Database,
  jobId: string,
  trackTitle: string,
  username: string,
  filename: string,
  bitRate?: number | null,
  audioFormat?: string | null,
): void {
  if (repointItem(db, jobId, trackTitle, username, filename, bitRate, audioFormat)) return;
  db.run(
    `INSERT INTO acquisition_job_items
       (job_id, track_title, username, filename, transfer_key, bit_rate_kbps, audio_format, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      trackTitle,
      username,
      filename,
      transferKeyFor(username, filename),
      bitRate ?? null,
      audioFormat ?? null,
      Date.now(),
    ],
  );
}

/**
 * Give up on a job's still-pending items (fallback exhausted / manual close):
 * they become `unavailable` so the job can finish as an honest partial
 * ("11 of 13 · 2 unavailable") instead of hanging on tracks nobody has.
 */
export function markMissingItemsUnavailable(db: Database, jobId: string): void {
  db.run(
    `UPDATE acquisition_job_items SET state = 'unavailable', updated_at = ?
     WHERE job_id = ? AND state IN ${NON_TERMINAL_STATES}`,
    [Date.now(), jobId],
  );
}

/**
 * Derive the job's stage/state purely from its item states (+ the landed flag
 * of scanned songs). Idempotent — safe under any watcher/scan/graduate
 * interleaving, no stored counters to corrupt.
 */
export function recomputeStage(db: Database, jobId: string): string | null {
  const job = db
    .query<{ state: string; stage: string }, [string]>(
      `SELECT state, stage FROM acquisition_jobs WHERE id = ?`,
    )
    .get(jobId);
  if (!job) return null;
  // Terminal job states are never reopened by a recompute.
  if (job.state === 'superseded') return job.stage;

  const counts = new Map<string, number>();
  for (const row of db
    .query<{ state: string; c: number }, [string]>(
      `SELECT state, COUNT(*) c FROM acquisition_job_items WHERE job_id = ? GROUP BY state`,
    )
    .all(jobId)) {
    counts.set(row.state, row.c);
  }
  if (counts.size === 0) return job.stage;

  let stage: string;
  let state: string;
  if (counts.has('downloading')) {
    stage = 'downloading';
    state = 'active';
  } else if (counts.has('completed')) {
    stage = 'organizing';
    state = 'active';
  } else if (counts.has('organized')) {
    stage = 'scanning';
    state = 'active';
  } else if ((counts.get('scanned') ?? 0) === 0) {
    stage = 'error';
    state = 'failed';
  } else {
    const pendingLanding = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) c FROM acquisition_job_items i
         JOIN library_songs s ON s.id = i.song_id
         WHERE i.job_id = ? AND i.state = 'scanned' AND s.landed_at IS NULL`,
      )
      .get(jobId);
    if ((pendingLanding?.c ?? 0) > 0) {
      stage = 'processing';
      state = 'active';
    } else {
      stage = 'done';
      state = 'done';
    }
  }
  db.run(`UPDATE acquisition_jobs SET state = ?, stage = ?, updated_at = ? WHERE id = ?`, [
    state,
    stage,
    Date.now(),
    jobId,
  ]);
  return stage;
}

/**
 * Re-derive every active job's stage. Called after landing passes
 * (`graduatePending`) so jobs waiting in `processing` close the moment their
 * songs land. Bounded: active jobs are few.
 */
export function recomputeActiveJobStages(db: Database): void {
  const rows = db
    .query<{ id: string }, []>(`SELECT id FROM acquisition_jobs WHERE state = 'active'`)
    .all();
  for (const row of rows) recomputeStage(db, row.id);
}

/** Mirror of the hunt route's `?replace=true`: retire prior active jobs for the album. */
export function supersedeActiveJobs(db: Database, target: { lidarrAlbumId: number }): void {
  db.run(
    `UPDATE acquisition_jobs SET state = 'superseded', updated_at = ?
     WHERE state = 'active' AND lidarr_album_id = ?`,
    [Date.now(), target.lidarrAlbumId],
  );
}

/**
 * Startup + periodic hygiene (same contract AcquireWatcher gives acquire_jobs):
 * fail items idle past the 24h valve so a restart or vanished transfer can
 * never strand a job "downloading" forever, then prune finished jobs.
 */
export function reconcileOnBoot(db: Database, now = Date.now()): void {
  // Rescue first, fail second: an item whose file *did* land must reach
  // 'scanned' rather than being written off by the idle valve below.
  reconcileOrganizedItems(db);

  const staleJobIds = db
    .query<{ job_id: string }, [number]>(
      `SELECT DISTINCT job_id FROM acquisition_job_items
       WHERE state IN ${NON_TERMINAL_STATES} AND updated_at < ?`,
    )
    .all(now - ITEM_IDLE_VALVE_MS)
    .map((r) => r.job_id);
  if (staleJobIds.length) {
    db.run(
      `UPDATE acquisition_job_items SET state = 'failed', updated_at = ?
       WHERE state IN ${NON_TERMINAL_STATES} AND updated_at < ?`,
      [now, now - ITEM_IDLE_VALVE_MS],
    );
    for (const jobId of staleJobIds) recomputeStage(db, jobId);
  }

  // The valve above is ITEM-driven, so a job that never grew a single item is
  // structurally invisible to it — and `recomputeStage` refuses to rule on one
  // (it derives stage FROM items). That is the shape of an addon URL job whose
  // addon never reported a terminal state: eternally `active`, never pruned
  // (the prune below only takes terminal rows), an undismissable ghost card.
  // `AddonJobPoller.applyAddonOutcome` closes the normal case the moment the
  // addon says so; this is the backstop for an addon that simply never does.
  // `kind='import'` rows are item-less by design too, but safe here: their run
  // loop bumps `updated_at` on every chunk and `import_jobs` (authoritative)
  // drives them to a terminal state, so a stale one is genuinely abandoned.
  db.run(
    `UPDATE acquisition_jobs
        SET state = 'failed', stage = 'error',
            error = COALESCE(error, 'This download never started and has been given up on.'),
            updated_at = ?
      WHERE state = 'active' AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM acquisition_job_items WHERE job_id = acquisition_jobs.id)`,
    [now, now - ITEM_IDLE_VALVE_MS],
  );

  // Prune keys on updated_at (when the job last moved), not created_at, so a
  // job the valve just closed stays visible for its full TTL. Explicit item
  // delete: FK cascade needs PRAGMA foreign_keys, which we don't rely on.
  const prune = db.transaction(() => {
    db.run(
      `DELETE FROM acquisition_job_items WHERE job_id IN (
         SELECT id FROM acquisition_jobs
         WHERE state IN ('done', 'failed', 'superseded') AND updated_at < ?
       )`,
      [now - FINISHED_JOB_TTL_MS],
    );
    db.run(
      `DELETE FROM acquisition_jobs
       WHERE state IN ('done', 'failed', 'superseded') AND updated_at < ?`,
      [now - FINISHED_JOB_TTL_MS],
    );
  });
  prune();
}

export interface AcquisitionJobFeedItem {
  id: string;
  kind: AcquisitionJobKind;
  method: string;
  state: string;
  stage: string;
  artistName: string | null;
  albumTitle: string | null;
  /**
   * The job's own display name (addon-supplied playlist/video/release title, an
   * import's source folder). The first rung of `downloadTitleFor`; null on
   * every job whose source never offered one.
   */
  displayTitle: string | null;
  /** The link the user pasted, for `kind:'url'` jobs — the title chain's URL rung. */
  sourceUrl: string | null;
  lidarrAlbumId: number | null;
  sourceRef: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  progress: { expected: number; delivered: number; unavailable: number; failed: number };
  /**
   * Dominant enqueue-time bitrate + codec across the job's items (mode wins;
   * ties broken by max kbps), upgraded post-scan via the items' matching
   * `library_songs.bit_rate` / `library_songs.suffix` rows (the authoritative
   * post-transcode value). Powers the "· 320 kbps" chip in the download card
   * (`formatQuality()` in `lib/download-status.ts`). undefined when no item
   * carries a quality signature — `formatQuality` then hides the chip.
   */
  bitRate?: number;
  audioFormat?: string;
  /**
   * Per-track status, mirroring URL-acquisition jobs' `tracks` field so the
   * frontend can render both uniformly. Mapped from `acquisition_job_items`
   * onto the shared `TrackStatus` union (see `itemStateToTrackStatus`).
   */
  items: { title: string; status: TrackStatus; username: string | null; filename: string | null }[];
  /**
   * The peers this job pulled from, so one card can show "Sources (5)" instead
   * of the feed splitting into five (issue #261). Grouped from
   * `acquisition_job_items.username`; empty for URL-acquire jobs, which have no
   * peer identity.
   */
  sources: { username: string; fileCount: number; state: TrackStatus }[];
  /**
   * Every library album the job's files landed in. Observed truth, so it both
   * names a finished card and drives the "View N albums" menu.
   */
  destinationAlbums: AcquireAlbumDestination[];
}

/**
 * The state to show for one peer within a job. Worst-first: a peer that failed
 * some files is reported as failed even if others landed, because that is the
 * thing the user may need to act on. Mirrors the ordering `recomputeStage`
 * uses to derive a job's own stage from its items.
 */
export function dominantItemState(states: string[]): TrackStatus {
  const order = ['failed', 'unavailable', 'downloading', 'completed', 'organized', 'scanned'];
  for (const s of order) {
    if (states.includes(s)) return itemStateToTrackStatus(s);
  }
  return itemStateToTrackStatus(states[0] ?? 'downloading');
}

/**
 * Map a slskd `acquisition_job_items.state` onto the shared `TrackStatus`
 * union used by every acquisition backend. `AcquisitionJobItemState` is
 * exhaustively `downloading | completed | organized | scanned | failed |
 * unavailable`; the `default` branch exists only to stay safe against a
 * malformed/legacy row, never as an expected fallthrough.
 */
function itemStateToTrackStatus(state: string): TrackStatus {
  switch (state) {
    case 'completed':
    case 'organized':
    case 'scanned':
      return 'done';
    case 'unavailable':
      return 'skipped';
    case 'failed':
      return 'failed';
    case 'downloading':
      return 'downloading';
    default:
      return 'pending';
  }
}

/**
 * Compute the dominant (bitRate, audioFormat) signature across one job's items.
 * Items that have been scanned are looked up in `library_songs` first; once the
 * scanner ran for a track, `library_songs.bit_rate` / `library_songs.suffix` is
 * the authoritative, post-transcode value and wins over the enqueue-time guess.
 * Mode across items (ties → max kbps) gives the "what's the dominant quality on
 * this card" number `formatQuality()` renders. Returns undefined when no item
 * carries a quality signature (legacy direct enqueue with no peer `bitRate`,
 * no scan row) so the UI can hide the chip cleanly.
 */
function rollupJobQuality(
  db: Database,
  jobId: string,
): { bitRate: number; audioFormat: string } | undefined {
  // Single GROUP BY over the resolved quality — COUNT(*) is the mode count.
  // ORDER BY mode-count DESC, kbps DESC resolves the tie-break to max kbps
  // (so 320/320/256 → 320, and 320/320/320 stays 320).
  let rows: Array<{ bit_rate: number; format: string; c: number }>;
  try {
    rows = db
      .query<{ bit_rate: number; format: string; c: number }, [string]>(
        `SELECT
           COALESCE(s.bit_rate, i.bit_rate_kbps) AS bit_rate,
           COALESCE(LOWER(s.suffix), i.audio_format) AS format,
           COUNT(*) AS c
         FROM acquisition_job_items i
         LEFT JOIN library_songs s ON s.path = i.relative_path
         WHERE i.job_id = ?
           AND COALESCE(s.bit_rate, i.bit_rate_kbps) IS NOT NULL
         GROUP BY bit_rate, format
         ORDER BY c DESC, bit_rate DESC
         LIMIT 1`,
      )
      .all(jobId);
  } catch {
    // library_songs may not exist in a minimal test DB; fall back to a simpler
    // GROUP BY that doesn't need the join.
    rows = db
      .query<{ bit_rate: number; format: string; c: number }, [string]>(
        `SELECT bit_rate_kbps AS bit_rate, audio_format AS format, COUNT(*) AS c
         FROM acquisition_job_items
         WHERE job_id = ? AND bit_rate_kbps IS NOT NULL
         GROUP BY bit_rate, format
         ORDER BY c DESC, bit_rate DESC
         LIMIT 1`,
      )
      .all(jobId);
  }
  if (rows.length === 0) return undefined;
  return { bitRate: rows[0].bit_rate, audioFormat: rows[0].format };
}

/**
 * The album a job's files actually landed in, for the card's "Open in Library"
 * deep link (issue #468).
 *
 * `albumIdFor(artistName, albumTitle)` alone is a *guess*: those names exist on
 * the job whether or not anything was ever filed — including the
 * `unfiledWarning` path where a job completes having filed nothing — so the
 * card offered a link that could not work under any timing (measured on prod:
 * 20 of 431 named jobs, 19 of which never landed at all). This is the same
 * anti-pattern #261 fixed for card identity: prefer what the server observed
 * over what a read-time re-derivation infers.
 *
 * Order: the album the job's own scanned items point at (`song_id` →
 * `library_songs.album_id` — the observed truth, and the one that stays right
 * when the names were only ever approximate), then the derived id **but only
 * if that album really exists**, then null so the caller renders no link.
 */
export function resolveJobAlbumId(
  db: Database,
  jobId: string,
  artistName: string | null,
  albumTitle: string | null,
): string | null {
  const landed = db
    .query<{ album_id: string; c: number }, [string]>(
      `SELECT s.album_id AS album_id, COUNT(*) c
         FROM acquisition_job_items i
         JOIN library_songs s ON s.id = i.song_id
        WHERE i.job_id = ? AND i.song_id IS NOT NULL AND s.album_id IS NOT NULL
        GROUP BY s.album_id
        ORDER BY c DESC, s.album_id
        LIMIT 1`,
    )
    .get(jobId);
  if (landed) return landed.album_id;

  if (!artistName || !albumTitle) return null;
  const derived = albumIdFor(artistName, albumTitle);
  const exists = db
    .query<{ id: string }, [string]>(`SELECT id FROM library_albums WHERE id = ?`)
    .get(derived);
  return exists ? derived : null;
}

/**
 * Downloads-feed read model: jobs newest-first with per-state item progress.
 * `delivered` counts every item that made it onto disk (completed, organized
 * or scanned); `unavailable`/`failed` make an honest partial renderable
 * ("11 of 13 · 2 unavailable").
 */
export function listJobFeed(db: Database, limit = 50): AcquisitionJobFeedItem[] {
  const jobs = db
    .query<JobRow, [number]>(`SELECT * FROM acquisition_jobs ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
  return jobs.map((row) => {
    const counts = new Map<string, number>();
    for (const r of db
      .query<{ state: string; c: number }, [string]>(
        `SELECT state, COUNT(*) c FROM acquisition_job_items WHERE job_id = ? GROUP BY state`,
      )
      .all(row.id)) {
      counts.set(r.state, r.c);
    }
    let expected = [...counts.values()].reduce((a, b) => a + b, 0);
    let delivered =
      (counts.get('completed') ?? 0) +
      (counts.get('organized') ?? 0) +
      (counts.get('scanned') ?? 0);
    // Import jobs mirror item-less (20k item rows would bloat every feed
    // poll); their file tallies live on the authoritative import_jobs row.
    // Guarded like rollupJobQuality: a missing row degrades to zero progress.
    if (row.kind === 'import' && expected === 0) {
      try {
        const imp = db
          .query<{ files_total: number; files_done: number }, [string]>(
            `SELECT files_total, files_done FROM import_jobs WHERE id = ?`,
          )
          .get(row.id);
        if (imp) {
          expected = imp.files_total;
          delivered = imp.files_done;
        }
      } catch {
        /* feed rendering must never fail on the fallback */
      }
    }
    const itemRows = db
      .query<
        {
          track_title: string | null;
          state: string;
          username: string | null;
          filename: string | null;
        },
        [string]
      >(
        `SELECT track_title, state, username, filename FROM acquisition_job_items WHERE job_id = ? ORDER BY id`,
      )
      .all(row.id);
    const quality = rollupJobQuality(db, row.id);
    // Peer breakdown for the card's "Sources (N)" disclosure. One hunt can pull
    // from several peers (a fallback wave, a multi-disc release); the data was
    // always in `acquisition_job_items`, the client just had no way to see it
    // and rendered each peer folder as its own card instead (issue #261).
    const sources = db
      .query<{ username: string | null; c: number; states: string }, [string]>(
        `SELECT username, COUNT(*) c, GROUP_CONCAT(state) states
         FROM acquisition_job_items WHERE job_id = ? GROUP BY username ORDER BY c DESC`,
      )
      .all(row.id)
      .filter((r): r is { username: string; c: number; states: string } => Boolean(r.username))
      .map((r) => ({
        username: r.username,
        fileCount: r.c,
        state: dominantItemState(r.states.split(',')),
      }));
    return {
      id: row.id,
      kind: row.kind,
      method: row.method,
      state: row.state,
      stage: row.stage,
      artistName: row.artist_name,
      albumTitle: row.album_title,
      displayTitle: row.display_title,
      sourceUrl: row.source_url,
      lidarrAlbumId: row.lidarr_album_id,
      sourceRef: row.source_ref,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      progress: {
        expected,
        delivered,
        unavailable: counts.get('unavailable') ?? 0,
        failed: counts.get('failed') ?? 0,
      },
      ...(quality ? { bitRate: quality.bitRate, audioFormat: quality.audioFormat } : {}),
      sources,
      destinationAlbums: jobDestinationAlbums(db, row.id),
      items: itemRows.map((r) => ({
        title: r.track_title ?? '',
        status: itemStateToTrackStatus(r.state),
        username: r.username,
        filename: r.filename,
      })),
    };
  });
}

/**
 * Resolve the job a transfer belongs to by its exact stored key — the
 * replacement for every read-time folder-string matcher.
 */
export function jobMetaForTransfer(
  db: Database,
  username: string,
  filename: string,
): TransferJobMeta | null {
  const row = db
    .query<JobRow, [string]>(
      `SELECT j.* FROM acquisition_job_items i JOIN acquisition_jobs j ON j.id = i.job_id
       WHERE i.transfer_key = ? ORDER BY i.updated_at DESC LIMIT 1`,
    )
    .get(transferKeyFor(username, filename));
  if (!row) return null;
  return {
    jobId: row.id,
    kind: row.kind,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    lidarrAlbumId: row.lidarr_album_id,
    genres: parseJsonArray(row.genres_json),
    year: row.year,
    canonicalTracks: parseJsonArray(row.canonical_tracks_json),
  };
}
