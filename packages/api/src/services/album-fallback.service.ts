import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Database } from 'bun:sqlite';
import { getDatabase } from '../db.js';
import { normalizeTitle, titlesOverlap } from './album-hunter.service.js';

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

export interface AlternateCandidate {
  username: string;
  directory: string;
  files: Array<{ filename: string; size: number }>;
}

export interface RecordJobInput {
  lidarrAlbumId: number | null;
  username: string;
  directory: string;
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
  canonical_tracks_json: string;
  target_files_json: string | null;
  alternates_json: string;
  fallback_attempts: number;
}

export interface AlbumFallbackOptions {
  db?: Database;
  /** Max alternate peers to try per album before giving up. */
  maxFallbackAttempts?: number;
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

  constructor(slskd: Slskd, options: AlbumFallbackOptions = {}) {
    this.slskd = slskd;
    this.db = options.db ?? getDatabase();
    this.maxFallbackAttempts = options.maxFallbackAttempts ?? 3;
  }

  /** Persist an album job so its missing tracks can later be recovered. */
  static recordJob(db: Database, input: RecordJobInput): void {
    db.run(
      `INSERT INTO album_jobs
         (lidarr_album_id, username, directory, canonical_tracks_json, target_files_json, alternates_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.lidarrAlbumId,
        input.username,
        input.directory,
        JSON.stringify(input.canonicalTracks),
        input.targetFiles ? JSON.stringify(input.targetFiles.map((f) => f.filename)) : null,
        JSON.stringify(input.alternates),
        Date.now(),
      ],
    );
  }

  /** One reconciliation pass. Public so tests can drive it deterministically. */
  async sweep(): Promise<void> {
    const jobs = this.db
      .query(
        `SELECT id, username, directory, canonical_tracks_json, target_files_json, alternates_json, fallback_attempts
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
    const gaveUp = this.gaveUpKeys();
    for (const group of downloads) {
      for (const dir of group.directories) {
        for (const file of dir.files) {
          if (file.state === 'Completed, Succeeded') {
            succeeded.push(normalizeBasename(file.filename));
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
      const missing = targets.filter(
        (title) => !succeeded.some((s) => titlesOverlap(title, s)),
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
      if (!picked) {
        this.setState(job.id, 'exhausted');
        continue;
      }

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

      // Consume the used alternate and bump the attempt counter.
      const remaining = alternates.filter((a) => a !== picked.alternate);
      this.db.run(
        'UPDATE album_jobs SET alternates_json = ?, fallback_attempts = fallback_attempts + 1 WHERE id = ?',
        [JSON.stringify(remaining), job.id],
      );
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
          if (RETRYABLE_STATES.has(file.state) && !gaveUp.has(`${job.username}::${file.filename}`)) {
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

function normalizeBasename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const noExt = base.slice(0, base.lastIndexOf('.') || base.length);
  return normalizeTitle(noExt);
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
