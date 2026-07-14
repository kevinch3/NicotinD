import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Database } from 'bun:sqlite';
import { getDatabase } from '../db.js';
import { normalizeTitle, titlesOverlap } from './album-hunter.service.js';
import { albumIdFor } from './library-scanner.js';
import {
  acquisitionJobIdForAlbumJob,
  markMissingItemsUnavailable,
  recomputeStage,
  repointOrAttachItem,
} from './acquisition-job-store.js';

const log = createLogger('album-fallback');

// Transfer states that mean the primary peer is still actively working a track.
// While any of these hold for the primary folder we let auto-retry run before
// reaching for an alternate peer.
const ACTIVE_STATES = new Set([
  'Requested',
  'Queued, Locally',
  'Queued, Remotely',
  'Initializing',
  'InProgress',
]);
const RETRYABLE_STATES = new Set([
  'Completed, Errored',
  'Completed, TimedOut',
  'Completed, Rejected',
]);

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
  '.m4a',
  '.aac',
  '.wav',
  '.aiff',
  '.wma',
  '.ape',
  '.wv',
]);

const FRESH_SEARCH_POLL_MS = 2_000;
const FRESH_SEARCH_TIMEOUT_MS = 20_000;

export interface AlternateCandidate {
  username: string;
  directory: string;
  files: Array<{ filename: string; size: number }>;
}

export interface RecordJobInput {
  lidarrAlbumId: number | null;
  username: string;
  directory: string;
  /**
   * Artist name, used by the fresh per-track recovery search when the recorded
   * alternates can't cover a missing track. Null for legacy/unknown.
   */
  artistName?: string | null;
  /** Album title, for the incomplete-albums UI surface. Null for legacy/unknown. */
  albumTitle?: string | null;
  /** Raw canonical track titles from Lidarr (kept for diagnostics/back-compat). */
  canonicalTracks: string[];
  /**
   * The files the user actually selected to download (the primary folder's
   * manifest). This — not the canonical tracklist — is the fallback's recovery
   * target: a folder that downloads completely must never trigger a fallback.
   */
  targetFiles?: Array<{ filename: string }>;
  /** Ranked alternate folder candidates (excluding the primary). */
  alternates: AlternateCandidate[];
}

interface AlbumJobRow {
  id: number;
  username: string;
  directory: string;
  artist_name: string | null;
  album_title: string | null;
  canonical_tracks_json: string;
  target_files_json: string | null;
  alternates_json: string;
  fallback_attempts: number;
}

interface ExhaustedJobRow {
  id: number;
  artist_name: string | null;
  revive_count: number;
  last_revived_at: number | null;
}

export interface AlbumFallbackOptions {
  db?: Database;
  /** Max alternate peers to try per album before giving up. */
  maxFallbackAttempts?: number;
  /** Periodically revive `exhausted` jobs for another fallback wave. */
  autoRetryExhausted?: boolean;
  /** Minimum delay before re-trying the same exhausted job. */
  exhaustedRetryCooldownMs?: number;
  /** Cap on revivals per job before it stays exhausted. */
  exhaustedMaxRevives?: number;
}

/**
 * Cross-peer recovery for album downloads. When the primary peer fails to
 * deliver some tracks (and auto-retry has stopped trying), this pulls just the
 * missing tracks from the next-best alternate peer recorded at download time.
 */
export class AlbumFallbackService {
  private slskd: Slskd;
  private db: Database;
  private maxFallbackAttempts: number;
  private autoRetryExhausted: boolean;
  private exhaustedRetryCooldownMs: number;
  private exhaustedMaxRevives: number;

  constructor(slskd: Slskd, options: AlbumFallbackOptions = {}) {
    this.slskd = slskd;
    this.db = options.db ?? getDatabase();
    this.maxFallbackAttempts = options.maxFallbackAttempts ?? 3;
    this.autoRetryExhausted = options.autoRetryExhausted ?? false;
    this.exhaustedRetryCooldownMs = options.exhaustedRetryCooldownMs ?? 3_600_000;
    this.exhaustedMaxRevives = options.exhaustedMaxRevives ?? 5;
  }

  /**
   * Persist an album job so its missing tracks can later be recovered.
   * Returns the new row id so callers can link it from `acquisition_jobs`.
   */
  static recordJob(db: Database, input: RecordJobInput): number {
    db.run(
      `INSERT INTO album_jobs
         (lidarr_album_id, username, directory, artist_name, album_title, canonical_tracks_json, target_files_json, alternates_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.lidarrAlbumId,
        input.username,
        input.directory,
        input.artistName ?? null,
        input.albumTitle ?? null,
        JSON.stringify(input.canonicalTracks),
        input.targetFiles ? JSON.stringify(input.targetFiles.map((f) => f.filename)) : null,
        JSON.stringify(input.alternates),
        Date.now(),
      ],
    );
    const row = db.query<{ id: number }, []>(`SELECT last_insert_rowid() AS id`).get();
    return row?.id ?? 0;
  }

  /** One reconciliation pass. Public so tests can drive it deterministically. */
  async sweep(): Promise<void> {
    // First give long-exhausted jobs (peers may now be back online) another shot
    // by flipping eligible ones back to 'active' — they're then swept this pass.
    if (this.autoRetryExhausted) this.reviveExhausted();

    const jobs = this.db
      .query(
        `SELECT id, username, directory, artist_name, album_title, canonical_tracks_json, target_files_json, alternates_json, fallback_attempts
         FROM album_jobs WHERE state = 'active'`,
      )
      .all() as AlbumJobRow[];
    if (!jobs.length) return;

    let downloads;
    try {
      downloads = await this.slskd.transfers.getDownloads();
    } catch (err) {
      log.debug({ err }, 'getDownloads failed during fallback sweep');
      return;
    }

    // Normalized basenames of every successfully-downloaded file, across all
    // peers — a track is satisfied no matter which peer ultimately delivered it.
    const succeeded: string[] = [];
    // Normalized basenames of tracks currently downloading (any peer). Used to
    // keep the fresh-search recovery from re-enqueueing a track that an earlier
    // wave is already pulling.
    const inFlight: string[] = [];
    const gaveUp = this.gaveUpKeys();
    for (const group of downloads) {
      for (const dir of group.directories) {
        for (const file of dir.files) {
          if (file.state === 'Completed, Succeeded') {
            succeeded.push(normalizeBasename(file.filename));
          } else if (ACTIVE_STATES.has(file.state)) {
            inFlight.push(normalizeBasename(file.filename));
          }
        }
      }
    }

    for (const job of jobs) {
      // Recovery target = the chosen folder's own manifest (normalized track
      // titles), falling back to the canonical Lidarr tracklist only for legacy
      // jobs recorded before the manifest was persisted. Targeting the manifest
      // is what keeps a fully-delivered folder from triggering a fallback wave:
      // the canonical list can be a deluxe edition whose extra cuts no single
      // folder contains, so chasing it dumps duplicate rips into the album.
      const targets = parseTargets(job);
      // A track is satisfied if a peer just delivered it (`succeeded`) OR it is
      // already in the library on disk. The on-disk check is essential for
      // *revived* jobs: their original slskd transfers are long gone from
      // getDownloads, so without it the sweep would re-download the whole album.
      const onDisk = this.libraryTitlesForJob(job);
      const missing = targets.filter(
        (title) =>
          !succeeded.some((s) => titlesOverlap(title, s)) &&
          !onDisk.some((s) => titlesOverlap(title, s)),
      );

      if (!missing.length) {
        this.setState(job.id, 'done');
        continue;
      }

      // Don't reach for a fallback while the primary peer is still trying.
      if (this.primaryStillWorking(downloads, job, gaveUp)) continue;

      if (job.fallback_attempts >= this.maxFallbackAttempts) {
        this.setState(job.id, 'exhausted');
        continue;
      }

      const alternates = JSON.parse(job.alternates_json) as AlternateCandidate[];
      const picked = pickAlternate(alternates, missing);

      // Cheapest path first: pull from a recorded alternate folder if one covers
      // a missing track. Only when none does do we pay for a fresh network search.
      if (picked) {
        try {
          await this.slskd.transfers.enqueue(picked.alternate.username, picked.files);
        } catch (err) {
          log.warn({ jobId: job.id, err }, 'Fallback enqueue failed; will retry next sweep');
          continue;
        }

        log.info(
          { jobId: job.id, from: picked.alternate.username, tracks: picked.files.length },
          'Fallback: pulled missing tracks from an alternate peer',
        );

        // Keep the unified acquisition job pointing at the live transfers: the
        // re-pulled tracks now come from the alternate's folder, so without
        // this the feed/organizer would lose them (they no longer match the
        // primary's stored keys). Best-effort.
        this.repointAcquisitionItems(
          job.id,
          picked.alternate.username,
          picked.files.map((f) => f.filename),
          missing,
        );

        // Consume the used alternate and bump the attempt counter.
        const remaining = alternates.filter((a) => a !== picked.alternate);
        this.db.run(
          'UPDATE album_jobs SET alternates_json = ?, fallback_attempts = fallback_attempts + 1 WHERE id = ?',
          [JSON.stringify(remaining), job.id],
        );
        continue;
      }

      // No recorded alternate covers the gap. Legacy jobs (no artist recorded)
      // have nothing left to try — give up, preserving the old behavior.
      if (!job.artist_name) {
        this.setState(job.id, 'exhausted');
        continue;
      }

      // Fresh per-track search across all peers, skipping tracks a previous wave
      // is already downloading. If everything missing is already in flight, wait.
      const freshTargets = missing.filter((m) => !inFlight.some((s) => titlesOverlap(m, s)));
      if (!freshTargets.length) continue;

      const enqueued = await this.recoverViaFreshSearch(job.id, job.artist_name, freshTargets);
      // Count the wave as an attempt either way so a hopeless gap eventually
      // exhausts instead of re-searching forever.
      this.db.run('UPDATE album_jobs SET fallback_attempts = fallback_attempts + 1 WHERE id = ?', [
        job.id,
      ]);
      if (enqueued) {
        log.info(
          { jobId: job.id, tracks: enqueued },
          'Fallback: pulled missing tracks via fresh per-track search',
        );
      }
    }
  }

  /**
   * Fresh recovery: search slskd for each still-missing track ("<artist>
   * <track>") across all peers, pick the healthiest matching file per track,
   * and enqueue them grouped by peer. Returns the number of files enqueued.
   * why: the recorded alternates are a snapshot from hunt time — by the time the
   * primary fails they may be offline or never had the track. A live search is
   * the only way to recover those, turning would-be `exhausted` jobs into `done`.
   */
  private async recoverViaFreshSearch(
    albumJobId: number,
    artistName: string,
    missing: string[],
  ): Promise<number> {
    const picks = await Promise.all(
      missing.map((title) => this.searchBestForTrack(artistName, title)),
    );

    // Group the chosen files by peer, de-duping identical filenames. Keep the
    // missing title each file recovers so the unified job item can be repointed.
    const byPeer = new Map<string, Array<{ filename: string; size: number }>>();
    const titleForFilename = new Map<string, string>();
    for (const [i, pick] of picks.entries()) {
      if (!pick) continue;
      const list = byPeer.get(pick.username) ?? [];
      if (!list.some((f) => f.filename === pick.file.filename)) list.push(pick.file);
      byPeer.set(pick.username, list);
      titleForFilename.set(pick.file.filename, missing[i]!);
    }

    let enqueued = 0;
    for (const [username, files] of byPeer) {
      try {
        await this.slskd.transfers.enqueue(username, files);
        enqueued += files.length;
      } catch (err) {
        log.warn({ username, err }, 'Fresh-search fallback enqueue failed');
        continue;
      }
      this.repointAcquisitionItems(
        albumJobId,
        username,
        files.map((f) => f.filename),
        files.map((f) => titleForFilename.get(f.filename) ?? normalizeBasename(f.filename)),
      );
    }
    return enqueued;
  }

  /**
   * Point the unified acquisition job's items at the transfers a fallback wave
   * just enqueued. Each filename is matched to the missing title it recovers
   * (fuzzy, same titlesOverlap the wave selection used). Best-effort: a repoint
   * failure must never break the recovery that already succeeded.
   */
  private repointAcquisitionItems(
    albumJobId: number,
    username: string,
    filenames: string[],
    missingTitles: string[],
  ): void {
    try {
      const acqJobId = acquisitionJobIdForAlbumJob(this.db, albumJobId);
      if (!acqJobId) return;
      for (const filename of filenames) {
        const base = normalizeBasename(filename);
        const title =
          missingTitles.find((t) => titlesOverlap(t, base)) ??
          missingTitles.find((t) => titlesOverlap(normalizeTitle(t), base)) ??
          base;
        repointOrAttachItem(this.db, acqJobId, title, username, filename);
      }
    } catch (err) {
      log.warn({ albumJobId, err }, 'Failed to repoint acquisition job items');
    }
  }

  /** Run one slskd search for a track and return the healthiest matching file. */
  private async searchBestForTrack(
    artistName: string,
    title: string,
  ): Promise<{ username: string; file: { filename: string; size: number } } | null> {
    let search: { id: string } | null = null;
    try {
      search = await this.slskd.searches.create(`${artistName} ${title}`);
    } catch (err) {
      log.debug({ title, err }, 'Fresh-search create failed');
      return null;
    }

    try {
      const deadline = Date.now() + FRESH_SEARCH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const state = await this.slskd.searches.get(search.id).catch(() => null);
        if (!state || state.state !== 'InProgress') break;
        await new Promise((r) => setTimeout(r, FRESH_SEARCH_POLL_MS));
      }

      const responses = await this.slskd.searches.getResponses(search.id).catch(() => []);
      const normTitle = normalizeTitle(title);

      let best: {
        username: string;
        file: { filename: string; size: number };
        extras: number;
        score: number;
      } | null = null;

      for (const response of responses) {
        const peerScore = healthScore(response);
        for (const file of response.files) {
          const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
          if (!AUDIO_EXTENSIONS.has(ext)) continue;
          const normFile = normalizeBasename(file.filename);
          if (!titlesOverlap(normTitle, normFile)) continue;

          // Cleanliness dominates: the file with the fewest extra words beyond the
          // canonical title wins, so we recover "Bohemian Rhapsody" — never the
          // "(5.1 mix)"/"(New Mix)" variant that a healthy FLAC peer would
          // otherwise win on. Health/FLAC only break ties among equally-clean files.
          const extras = extraTokenCount(normTitle, normFile);
          const score = peerScore + (ext === '.flac' ? 1 : 0);
          if (!best || extras < best.extras || (extras === best.extras && score > best.score)) {
            best = {
              username: response.username,
              file: { filename: file.filename, size: file.size },
              extras,
              score,
            };
          }
        }
      }

      return best ? { username: best.username, file: best.file } : null;
    } finally {
      await this.slskd.searches.delete(search.id).catch(() => {});
    }
  }

  private primaryStillWorking(
    downloads: Awaited<ReturnType<Slskd['transfers']['getDownloads']>>,
    job: AlbumJobRow,
    gaveUp: Set<string>,
  ): boolean {
    for (const group of downloads) {
      if (group.username !== job.username) continue;
      for (const dir of group.directories) {
        if (dir.directory !== job.directory) continue;
        for (const file of dir.files) {
          if (ACTIVE_STATES.has(file.state)) return true;
          // An errored file the retry layer hasn't given up on yet is still in play.
          if (
            RETRYABLE_STATES.has(file.state) &&
            !gaveUp.has(`${job.username}::${file.filename}`)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private gaveUpKeys(): Set<string> {
    const rows = this.db
      .query('SELECT transfer_key FROM transfer_retries WHERE gave_up = 1')
      .all() as Array<{ transfer_key: string }>;
    return new Set(rows.map((r) => r.transfer_key));
  }

  private setState(id: number, state: string): void {
    this.db.run('UPDATE album_jobs SET state = ? WHERE id = ?', [state, id]);
    // The fallback giving up is the signal that the still-missing tracks are
    // unobtainable: close the owning unified job as an honest partial
    // ("N of M · K unavailable") instead of leaving it downloading forever.
    if (state === 'exhausted' || state === 'done') {
      try {
        const acqJobId = acquisitionJobIdForAlbumJob(this.db, id);
        if (acqJobId) {
          if (state === 'exhausted') markMissingItemsUnavailable(this.db, acqJobId);
          recomputeStage(this.db, acqJobId);
        }
      } catch (err) {
        log.warn({ albumJobId: id, err }, 'Failed to close acquisition job with fallback state');
      }
    }
  }

  /**
   * Flip eligible `exhausted` jobs back to `active` (fresh attempt budget) so the
   * same sweep pass re-attempts them. Eligibility: the job has an artist (the
   * fresh-search needs it), hasn't been revived more than `exhaustedMaxRevives`
   * times, and its last revival is older than the cooldown. Public for tests.
   */
  reviveExhausted(): void {
    const now = Date.now();
    const rows = this.db
      .query(
        `SELECT id, artist_name, revive_count, last_revived_at
         FROM album_jobs WHERE state = 'exhausted'`,
      )
      .all() as ExhaustedJobRow[];

    for (const row of rows) {
      // Legacy jobs without an artist can't fresh-search, so reviving them would
      // just re-exhaust with no new behavior — skip.
      if (!row.artist_name) continue;
      if (row.revive_count >= this.exhaustedMaxRevives) continue;
      if (row.last_revived_at && now - row.last_revived_at < this.exhaustedRetryCooldownMs) {
        continue;
      }
      this.db.run(
        `UPDATE album_jobs
         SET state = 'active', fallback_attempts = 0, revive_count = revive_count + 1, last_revived_at = ?
         WHERE id = ?`,
        [now, row.id],
      );
      log.info(
        { jobId: row.id, revive: row.revive_count + 1 },
        'Reviving exhausted album job for another fallback wave',
      );
    }
  }

  /**
   * Normalized titles of the job's album that already exist in the library on
   * disk. Keyed via the same deterministic album id the scanner mints, so a
   * revived job doesn't re-fetch tracks it already has. Empty when the job has
   * no artist/title (legacy) or the album hasn't been scanned yet.
   */
  private libraryTitlesForJob(job: AlbumJobRow): string[] {
    if (!job.artist_name || !job.album_title) return [];
    const albumId = albumIdFor(job.artist_name, job.album_title);
    const rows = this.db
      .query('SELECT title FROM library_songs WHERE album_id = ?')
      .all(albumId) as Array<{ title: string }>;
    return rows.map((r) => normalizeTitle(r.title));
  }
}

/**
 * The set of track titles (normalized) the fallback must see satisfied before a
 * job is done. Prefers the primary folder's manifest (`target_files_json`); for
 * legacy jobs recorded without it, falls back to the canonical Lidarr titles.
 */
function parseTargets(job: AlbumJobRow): string[] {
  if (job.target_files_json) {
    const files = JSON.parse(job.target_files_json) as string[];
    if (files.length) return files.map(normalizeBasename);
  }
  return (JSON.parse(job.canonical_tracks_json) as string[]).map(normalizeTitle);
}

/**
 * Rank a peer for fresh-search recovery: free upload slots dominate (an occupied
 * peer truncates), then a shorter queue, then faster upload speed.
 */
function healthScore(r: {
  freeUploadSlots?: number;
  queueLength?: number;
  uploadSpeed?: number;
}): number {
  const slots = (r.freeUploadSlots ?? 0) > 0 ? 1000 : 0;
  const queuePenalty = Math.min(r.queueLength ?? 0, 999);
  const speed = (r.uploadSpeed ?? 0) / 1_000_000;
  return slots - queuePenalty + speed;
}

function normalizeBasename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const noExt = base.slice(0, base.lastIndexOf('.') || base.length);
  return normalizeTitle(noExt);
}

/**
 * How many words a candidate filename has beyond the canonical track title — a
 * proxy for version/edition noise ("(5.1 mix)", "(New Mix)", "(remastered)").
 * 0 means the candidate is exactly the track; higher means more cruft.
 */
function extraTokenCount(canonicalNorm: string, fileNorm: string): number {
  const canon = new Set(canonicalNorm.split(' ').filter(Boolean));
  const fileWords = fileNorm.split(' ').filter(Boolean);
  return fileWords.reduce((n, w) => (canon.has(w) ? n : n + 1), 0);
}

/**
 * Picks the first alternate that covers at least one missing track and returns
 * just the files matching the missing tracks (so we don't re-download tracks the
 * primary already delivered).
 */
function pickAlternate(
  alternates: AlternateCandidate[],
  missing: string[],
): { alternate: AlternateCandidate; files: Array<{ filename: string; size: number }> } | null {
  const normalizedMissing = missing.map(normalizeTitle);
  for (const alternate of alternates) {
    const files = alternate.files.filter((f) => {
      const norm = normalizeBasename(f.filename);
      return normalizedMissing.some((m) => titlesOverlap(m, norm));
    });
    if (files.length) return { alternate, files };
  }
  return null;
}
