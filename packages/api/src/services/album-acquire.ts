import type { Database } from 'bun:sqlite';
import type { Lidarr, LidarrTrack } from '@nicotind/lidarr-client';
import { createLogger, normalizeTitle, titlesOverlap } from '@nicotind/core';
import { albumAlreadyComplete, onDiskTitles } from './library-completeness.js';
import { recordAcquiredArtistIdentity } from './artist-identity-store.js';
import { artistIdFor } from './library-scanner.js';
import { createJob } from './acquisition-job-store.js';
import type { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError } from './addons/client.js';
import { mapAddonJob, sanitizeAddonError } from './addons/job-poller.js';

const log = createLogger('album-acquire');

/** Result of one unattended acquire attempt against a resolved Lidarr album. */
export type AcquireOutcome =
  /** Already on disk (any edition) — nothing to do. */
  | 'already-complete'
  /** A download for this album is already in flight — don't duplicate. */
  | 'in-flight'
  /** A confident folder was found and its missing tracks were enqueued. */
  | 'enqueued'
  /**
   * We asked the source and nothing cleared the confidence threshold — an
   * honest "not there (yet)". Never used for a hunt that failed to reach the
   * source at all: that is `slskd-unavailable`, because the two differ in what
   * the caller should do (#1040).
   */
  | 'no-candidate'
  /**
   * The source could not be reached or was not able to search — retry later.
   * Also the outcome for an enqueue that died while the source was down, which
   * must not be reported as the terminal `enqueue-failed`.
   */
  | 'slskd-unavailable'
  /** A candidate was chosen but the enqueue call failed. */
  | 'enqueue-failed';

/**
 * The outcome plus, on a failure, the cause it was derived from. A bare token
 * cannot separate "no addon enabled" from "the addon 400'd", so the failing
 * paths carry the sanitized error text (docs/mcp-agent.md).
 */
export interface AcquireResult {
  outcome: AcquireOutcome;
  detail?: string;
}

/**
 * Is the addon able to do work right now? Only ever used to soften a failure
 * into a retry, so an unanswerable question is deliberately read as "ready":
 * losing the real error would be worse than deferring one attempt too few.
 */
async function addonIsReady(addon: RemoteAddonPlugin): Promise<boolean> {
  try {
    const health = await addon.client.getHealth();
    return health.ok && health.ready;
  } catch {
    return true;
  }
}

/** The addon's own error text, reduced to the line a person should read. */
function causeOf(err: unknown): string {
  return sanitizeAddonError(err instanceof Error ? err.message : String(err));
}

export interface AcquireAlbumDeps {
  db: Database;
  lidarr: Lidarr;
  /**
   * The active remote acquisition addon — read live per acquire (an admin can
   * enable/disable mid-session). The hunt + enqueue + fallback run addon-side
   * over the protocol (phase 3 removed the in-process path); every
   * library-side guard stays here. None enabled → 'slskd-unavailable'.
   */
  getAddon: () => RemoteAddonPlugin | null;
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
 * Pure of any caller-specific bookkeeping: it returns an outcome (plus, on a
 * failure, why) and lets the caller persist state (the watchlist maps it to row
 * transitions; the auto-acquire loop just logs it). Idempotent across calls via
 * the `already-complete`/`in-flight` guards, so a repeated sweep never
 * double-downloads.
 */
export async function acquireAlbum(
  deps: AcquireAlbumDeps,
  input: AcquireAlbumInput,
): Promise<AcquireResult> {
  const { db, lidarr } = deps;
  const { lidarrAlbumId, artistName, albumTitle } = input;

  const tracks = await lidarr.track.listByAlbum(lidarrAlbumId);

  // Already on disk (any edition) → done, no download.
  if (albumAlreadyComplete(db, artistName, albumTitle, tracks.length || 1)) {
    return { outcome: 'already-complete' };
  }

  const addon = deps.getAddon();
  if (!addon) {
    return { outcome: 'slskd-unavailable', detail: 'No acquisition addon is enabled' };
  }
  return acquireViaAddon(deps, input, addon, tracks);
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
): Promise<AcquireResult> {
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
    // The hunt never reached the source's network (slskd running but logged out
    // of Soulseek, #1040). An empty result then says nothing about the album, so
    // it must not be recorded as 'no-candidate' — that token means "we looked and
    // it isn't there", which stops a curator asking and makes the watchlist
    // re-decide the same wrong thing every sweep. A candidate that *did* clear
    // the bar is real, so a partial outage still acquires.
    if (!best && res.sourceOffline) {
      return { outcome: 'slskd-unavailable', detail: 'Source offline — the hunt never reached it' };
    }
  } catch (err) {
    log.warn({ lidarrAlbumId, addonId, err }, 'Addon album search failed');
    return { outcome: 'slskd-unavailable', detail: causeOf(err) };
  }
  if (!best) return { outcome: 'no-candidate' };

  // Library knowledge stays core-side: the addon acquires only the tracks not
  // already on disk (the same complete-only discipline as the direct path).
  const onDisk = onDiskTitles(db, artistName, albumTitle);
  const wanted = titles.filter((t) => !onDisk.some((d) => titlesOverlap(d, normalizeTitle(t))));
  if (wanted.length === 0) return { outcome: 'already-complete' };

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
    if (err instanceof AddonRequestError && err.status === 409) return { outcome: 'in-flight' };
    log.warn({ lidarrAlbumId, addonId, err }, 'Addon job creation failed');
    // 'enqueue-failed' is terminal for the caller (the watchlist marks the row
    // failed), so it has to mean "asking again will fail again". A source that
    // went down between the hunt and the enqueue is the opposite of that, and
    // used to kill the row over an outage that clears in minutes. The addon's
    // readiness is the discriminator — and only ever downgrades a failure to a
    // retry, so if asking throws we keep the original, harsher outcome.
    if (!(await addonIsReady(addon))) {
      return { outcome: 'slskd-unavailable', detail: 'Source offline — enqueue deferred' };
    }
    return { outcome: 'enqueue-failed', detail: causeOf(err) };
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
  return { outcome: 'enqueued' };
}
