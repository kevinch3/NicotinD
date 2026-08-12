import type { Database } from 'bun:sqlite';
import type { Lidarr, LidarrTrack } from '@nicotind/lidarr-client';
import { createLogger, normalizeTitle, titlesOverlap } from '@nicotind/core';
import type { SlskdRef } from '../index.js';
import type { AlbumHunterService, FolderCandidate } from './album-hunter.service.js';
import { AlbumFallbackService } from './album-fallback.service.js';
import {
  albumAlreadyComplete,
  filesForCanonicalTracks,
  filesMissingOnDisk,
  onDiskTitles,
} from './library-completeness.js';
import { recordAcquiredArtistIdentity } from './artist-identity-store.js';
import { artistIdFor } from './library-scanner.js';
import { createJob } from './acquisition-job-store.js';
import type { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError } from './addons/client.js';
import { mapAddonJob } from './addons/job-poller.js';

const log = createLogger('album-acquire');

/** Result of one unattended acquire attempt against a resolved Lidarr album. */
export type AcquireOutcome =
  /** Already on disk (any edition) — nothing to do. */
  | 'already-complete'
  /** A download for this album is already in flight — don't duplicate. */
  | 'in-flight'
  /** A confident folder was found and its missing tracks were enqueued. */
  | 'enqueued'
  /** No folder cleared the confidence threshold this pass — retry later. */
  | 'no-candidate'
  /** slskd isn't available right now — retry later. */
  | 'slskd-unavailable'
  /** A candidate was chosen but the enqueue call failed. */
  | 'enqueue-failed';

export interface AcquireAlbumDeps {
  db: Database;
  hunter: AlbumHunterService;
  lidarr: Lidarr;
  slskdRef: SlskdRef;
  /**
   * The active remote acquisition addon, if one is enabled — read live per
   * acquire (an admin can enable/disable mid-session). When present, the hunt
   * + enqueue + fallback run addon-side over the protocol; every library-side
   * guard stays here.
   */
  getAddon?: () => RemoteAddonPlugin | null;
}

export interface AcquireAlbumInput {
  /** Already-resolved numeric Lidarr album id (the caller resolves it). */
  lidarrAlbumId: number;
  artistName: string;
  albumTitle: string;
  /** Minimum folder match % to auto-acquire unattended. */
  minMatchPct: number;
  /** Lidarr/MusicBrainz artist id, when the caller has it — persisted as identity. */
  artistMbid?: string | null;
}

/**
 * Unattended acquisition of one album through the exact primitives the interactive
 * hunt uses — the shared core behind both the watchlist poller and the Lidarr
 * missing-list auto-acquire loop (docs/auto-acquisition-plan.md). Given a resolved
 * Lidarr album id it: skips albums already on disk or already downloading, hunts
 * Soulseek with skew enabled, auto-selects the top candidate clearing `minMatchPct`,
 * enqueues only the tracks not already on disk, and records an album job so the
 * cross-peer fallback can recover any tracks the chosen peer fails to deliver.
 *
 * Pure of any caller-specific bookkeeping: it returns an outcome and lets the
 * caller persist state (the watchlist maps it to row transitions; the auto-acquire
 * loop just logs it). Idempotent across calls via the `already-complete`/`in-flight`
 * guards, so a repeated sweep never double-downloads.
 */
export async function acquireAlbum(
  deps: AcquireAlbumDeps,
  input: AcquireAlbumInput,
): Promise<AcquireOutcome> {
  const { db, hunter, lidarr, slskdRef } = deps;
  const { lidarrAlbumId, artistName, albumTitle, minMatchPct, artistMbid } = input;

  const tracks = await lidarr.track.listByAlbum(lidarrAlbumId);

  // Already on disk (any edition) → done, no download.
  if (albumAlreadyComplete(db, artistName, albumTitle, tracks.length || 1)) {
    return 'already-complete';
  }

  // Addon cutover (docs/acquisition-addon-protocol.md phase 2): when a remote
  // acquisition addon is enabled, the source-side half runs over the protocol.
  const addon = deps.getAddon?.() ?? null;
  if (addon) return acquireViaAddon(deps, input, addon, tracks);

  // A download for this album is already in flight (e.g. user hunted it manually,
  // or a prior sweep enqueued it) → consider it handled; don't enqueue a duplicate.
  const active = db
    .query<{ id: number }, [number]>(
      `SELECT id FROM album_jobs WHERE lidarr_album_id = ? AND state = 'active' LIMIT 1`,
    )
    .get(lidarrAlbumId);
  if (active) return 'in-flight';

  const slskd = slskdRef.current;
  if (!slskd) return 'slskd-unavailable';

  const candidates = await hunter.hunt(artistName, albumTitle, tracks, { skewSearch: true });
  // Candidates are ranked best-first; take the top one clearing the unattended
  // confidence threshold. Nothing good enough yet → try again next sweep.
  const best = candidates.find((c) => c.matchPct >= minMatchPct);
  if (!best) return 'no-candidate';

  // Scope to the album's own tracks first: a peer folder can be a whole
  // discography, and enqueuing all of it downloads other albums and blows up
  // the job's tally (issue #262). Then complete-only: drop the tracks already
  // on disk (see filesMissingOnDisk) so a partially-present album fills in
  // cleanly instead of re-downloading duplicate versions.
  const albumFiles = filesForCanonicalTracks(
    best.files,
    tracks.map((t) => t.title),
  );
  const filesToDownload = filesMissingOnDisk(db, artistName, albumTitle, albumFiles);
  if (filesToDownload.length === 0) {
    // The chosen folder's tracks are all on disk already — treat as complete.
    return 'already-complete';
  }

  try {
    await slskd.transfers.enqueue(best.username, filesToDownload);
  } catch (err) {
    log.warn({ lidarrAlbumId, err }, 'Auto-acquire enqueue failed');
    return 'enqueue-failed';
  }

  const toFiles = (c: FolderCandidate) =>
    c.files.map((f) => ({
      filename: f.filename,
      size: f.size,
      bitRate: f.bitRate,
      audioFormat: c.format,
    }));
  const alternates = candidates
    .filter((c) => c !== best)
    .map((c) => ({ username: c.username, directory: c.directory, files: toFiles(c) }));
  // The download is coming: persist the canonical artist identity (one act + MBID)
  // now, so the scan that lands it already knows the artist. Best-effort.
  try {
    recordAcquiredArtistIdentity(db, {
      artistKey: artistIdFor(artistName),
      artistName,
      mbid: artistMbid ?? null,
    });
  } catch (err) {
    log.warn({ lidarrAlbumId, err }, 'Failed to persist acquired artist identity');
  }

  let albumJobId: number | null = null;
  try {
    albumJobId = AlbumFallbackService.recordJob(db, {
      lidarrAlbumId,
      username: best.username,
      directory: best.directory,
      artistName,
      albumTitle,
      canonicalTracks: tracks.map((t) => t.title),
      targetFiles: filesToDownload,
      alternates,
    });
  } catch (err) {
    log.warn({ lidarrAlbumId, err }, 'Failed to record album job for auto-acquisition');
  }

  // Unified acquisition job: stored transfer↔job linkage + hunt metadata for
  // the downloads feed, organizer and enrichment. Best-effort like the above.
  try {
    createJob(db, {
      kind: 'auto-acquire',
      method: 'slskd',
      artistName,
      albumTitle,
      lidarrAlbumId,
      artistMbid: artistMbid ?? null,
      canonicalTracks: tracks.map((t) => t.title),
      albumJobId,
      sourceRef: best.username,
      username: best.username,
      files: filesToDownload.map((f) => ({
        filename: f.filename,
        size: f.size,
        bitRate: f.bitRate,
        audioFormat: best.format,
      })),
    });
  } catch (err) {
    log.warn({ lidarrAlbumId, err }, 'Failed to record acquisition job');
  }

  log.info(
    { lidarrAlbumId, album: albumTitle, from: best.username, matchPct: best.matchPct },
    'Auto-acquired album',
  );
  return 'enqueued';
}

/**
 * The addon-side acquire: hunt + pick + wanted-track-scoped enqueue + fallback
 * all happen in the addon; core keeps the library knowledge (what's on disk),
 * the identity persistence, and the unified feed row the poller mirrors items
 * into. The addon's own per-album 409 doubles as the in-flight guard, so a
 * lost response or a concurrent sweep can never double-download.
 */
async function acquireViaAddon(
  deps: AcquireAlbumDeps,
  input: AcquireAlbumInput,
  addon: RemoteAddonPlugin,
  tracks: LidarrTrack[],
): Promise<AcquireOutcome> {
  const { db } = deps;
  const { lidarrAlbumId, artistName, albumTitle, minMatchPct, artistMbid } = input;
  const addonId = addon.manifest.id;
  const titles = tracks.map((t) => t.title);

  let best;
  try {
    const res = await addon.client.albumsSearch({
      artist: artistName,
      album: albumTitle,
      canonicalTracks: titles.map((title) => ({ title })),
    });
    best = res.candidates.find((c) => c.matchPct >= minMatchPct);
  } catch (err) {
    log.warn({ lidarrAlbumId, addonId, err }, 'Addon album search failed');
    return 'slskd-unavailable';
  }
  if (!best) return 'no-candidate';

  // Library knowledge stays core-side: the addon acquires only the tracks not
  // already on disk (the same complete-only discipline as the direct path).
  const onDisk = onDiskTitles(db, artistName, albumTitle);
  const wanted = titles.filter((t) => !onDisk.some((d) => titlesOverlap(d, normalizeTitle(t))));
  if (wanted.length === 0) return 'already-complete';

  try {
    recordAcquiredArtistIdentity(db, {
      artistKey: artistIdFor(artistName),
      artistName,
      mbid: artistMbid ?? null,
    });
  } catch (err) {
    log.warn({ lidarrAlbumId, err }, 'Failed to persist acquired artist identity');
  }

  let addonJob;
  try {
    addonJob = await addon.client.createJob(
      {
        intent: 'album',
        artist: artistName,
        album: albumTitle,
        canonicalTracks: titles.map((title) => ({ title })),
        wantedTracks: wanted.map((title) => ({ title })),
        candidateRef: best.candidateRef,
      },
      `acquire:${lidarrAlbumId}`,
    );
  } catch (err) {
    if (err instanceof AddonRequestError && err.status === 409) return 'in-flight';
    log.warn({ lidarrAlbumId, addonId, err }, 'Addon job creation failed');
    return 'enqueue-failed';
  }

  // The unified feed row carries the hunt metadata; the poller mirrors the
  // addon's items into it (repoints included) via the job mapping.
  try {
    const coreJobId = createJob(db, {
      kind: 'auto-acquire',
      method: addonId,
      artistName,
      albumTitle,
      lidarrAlbumId,
      artistMbid: artistMbid ?? null,
      canonicalTracks: titles,
      sourceRef: `addon:${addonId}:${addonJob.id}`,
      files: [],
    });
    mapAddonJob(db, addonId, addonJob.id, coreJobId);
  } catch (err) {
    log.warn({ lidarrAlbumId, err }, 'Failed to record acquisition job for addon acquire');
  }

  log.info(
    { lidarrAlbumId, album: albumTitle, addonId, matchPct: best.matchPct },
    'Auto-acquired album via addon',
  );
  return 'enqueued';
}
