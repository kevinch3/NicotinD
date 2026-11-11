import type { Database } from 'bun:sqlite';
import type { Lidarr, LidarrTrack } from '../lidarr/index.js';
import { createLogger, filesMatchingTitles, titlesMissingFromOwned } from '@nicotind/core';
import { albumAlreadyComplete, onDiskTitles } from './library-completeness.js';
import { recordAcquiredArtistIdentity } from './artist-identity-store.js';
import { artistIdFor } from './library-scanner.js';
import {
  attachAddonRef,
  createJob,
  findActiveAlbumJob,
  holdAlbum,
} from './acquisition-job-store.js';
import type { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError, type HuntLane } from './addons/client.js';
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
  | 'enqueue-failed'
  /** The reserved job was cancelled while the hunt ran, so nothing was enqueued. */
  | 'cancelled';

/** How many confident candidates one acquire walks before giving up (#530). */
const MAX_PICK_ATTEMPTS = 3;
/** The slskd addon's words for a folder carrying none of the wanted tracks (#1209). */
const ADDON_LACKS_WANTED = /covers none of the wanted tracks/i;

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
/** Fewer searches answered than fired: the source cut the hunt short (#1049). */
function huntCutShort(res: { searchesFired?: number; searchesAnswered?: number }): boolean {
  return (
    typeof res.searchesFired === 'number' &&
    typeof res.searchesAnswered === 'number' &&
    res.searchesAnswered < res.searchesFired
  );
}

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
  /** Who asked, when someone did. The job's owner may discard its partial tracks. */
  userId?: string | null;
  /**
   * Skip the idempotency key: someone asked for this album again, and the addon
   * would replay the failed job the key still names (#1511).
   */
  retry?: boolean;
  /** A caller answering a request passes its budget; unattended lanes can wait longer. */
  huntTimeoutMs?: number;
  /** Which lane asked, for the hunt log line (#1626). */
  lane?: HuntLane;
  /** The local album being completed, so on-disk tracks match by id, not only by name. */
  localAlbumId?: string;
  /**
   * A job row the caller reserved in `resolving` (docs/album-hunt.md "A Get is a
   * server job"). The caller ran the in-flight guard to reserve it, so it is not
   * run again here — it would find this very row — and the row is attached to the
   * addon job rather than a second one created.
   */
  reservedJobId?: string;
  /** Asked just before the enqueue: false when the reserved job was cancelled meanwhile. */
  stillWanted?: () => boolean;
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

  // Already downloading through any lane — checked before the hunt, which would
  // otherwise spend the source's search lanes on an album in flight (#1539).
  const target = { lidarrAlbumId, artist: artistName, title: albumTitle };
  let release: (() => void) | null = null;
  if (!input.reservedJobId) {
    if (findActiveAlbumJob(db, target)) return { outcome: 'in-flight' };
    // Held until the job row exists, as every Get lane does (`holdAlbum`).
    release = holdAlbum(target);
    if (!release) return { outcome: 'in-flight' };
  }
  try {
    const tracks = await lidarr.track.listByAlbum(lidarrAlbumId);

    // Already on disk (any edition) → done, no download.
    if (albumAlreadyComplete(db, artistName, albumTitle, tracks.length || 1)) {
      return { outcome: 'already-complete' };
    }

    const addon = deps.getAddon();
    if (!addon) {
      return { outcome: 'slskd-unavailable', detail: 'No acquisition addon is enabled' };
    }
    return await acquireViaAddon(deps, input, addon, tracks);
  } finally {
    release?.();
  }
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

  let res;
  try {
    res = await addon.client.albumsSearch(
      {
        artist: artistName,
        album: albumTitle,
        canonicalTracks: titles.map((title) => ({ title })),
      },
      { timeoutMs: input.huntTimeoutMs, lane: input.lane, albumId: lidarrAlbumId },
    );
  } catch (err) {
    log.warn({ lidarrAlbumId, addonId, err }, 'Addon album search failed');
    return { outcome: 'slskd-unavailable', detail: causeOf(err) };
  }
  const confident = res.candidates.filter((c) => c.matchPct >= minMatchPct);

  // Library knowledge stays core-side: the addon acquires only the tracks not
  // already on disk (the same complete-only discipline as the direct path).
  // Only consulted once a candidate cleared the bar — an empty hunt is a
  // no-candidate/deferral whatever is on disk.
  let wanted = titles;
  if (confident.length) {
    const onDisk = onDiskTitles(db, artistName, albumTitle, input.localAlbumId);
    wanted = titlesMissingFromOwned(titles, onDisk);
    if (wanted.length === 0) return { outcome: 'already-complete' };
  }

  // The addon scopes the job to `wanted` and refuses a folder carrying none of
  // them with a 400 (#1209) — so the pick skips such a folder under the addon's
  // own rule. A candidate listing no files gives nothing to judge; the addon
  // keeps the final word on it.
  const picks = confident
    .filter((c) => c.files.length === 0 || filesMatchingTitles(c.files, wanted, titles).length > 0)
    .slice(0, MAX_PICK_ATTEMPTS);
  if (!picks.length) {
    // The hunt never reached the source's network (slskd running but logged out
    // of Soulseek, #1040), or its search lanes were held by other work and some
    // of this hunt's searches never ran (#1049). The result then says nothing
    // about the album, so it must not be recorded as 'no-candidate' — that token
    // means "we looked and it isn't there". A candidate that *did* clear the bar
    // is real, so a partial outage still acquires.
    if (res.sourceOffline) {
      return { outcome: 'slskd-unavailable', detail: 'Source offline — the hunt never reached it' };
    }
    if (huntCutShort(res)) {
      return {
        outcome: 'slskd-unavailable',
        detail: `Source busy — only ${res.searchesAnswered} of ${res.searchesFired} searches completed`,
      };
    }
    if (!confident.length) return { outcome: 'no-candidate' };
    return {
      outcome: 'no-candidate',
      detail: `${confident.length} candidate${confident.length === 1 ? '' : 's'} cleared ${minMatchPct}% but none carries any of the ${wanted.length} wanted tracks`,
    };
  }

  try {
    recordAcquiredArtistIdentity(db, {
      artistKey: artistIdFor(artistName),
      artistName,
      mbid: artistMbid ?? null,
    });
  } catch (err) {
    log.warn({ lidarrAlbumId, err }, 'Failed to persist acquired artist identity');
  }

  if (input.stillWanted && !input.stillWanted()) return { outcome: 'cancelled' };

  // A refusal about one peer (offline, or holding none of the wanted tracks) says
  // nothing about the next, so the pick walks down the confident candidates.
  let addonJob;
  let best = picks[0]!;
  const refusals: Array<{ peer: string; cause: string }> = [];
  for (const pick of picks) {
    try {
      addonJob = await addon.client.createJob(
        {
          intent: 'album',
          artist: artistName,
          album: albumTitle,
          canonicalTracks: titles.map((title) => ({ title })),
          wantedTracks: wanted.map((title) => ({ title })),
          candidateRef: pick.candidateRef,
        },
        input.retry ? undefined : `acquire:${lidarrAlbumId}`,
        { lane: input.lane, albumId: lidarrAlbumId },
      );
      best = pick;
      break;
    } catch (err) {
      if (err instanceof AddonRequestError && err.status === 409) return { outcome: 'in-flight' };
      log.warn({ lidarrAlbumId, addonId, peer: pick.username, err }, 'Addon job creation failed');
      refusals.push({ peer: pick.username, cause: causeOf(err) });
      // Any other 400 is about the request, and fails the same for every peer (#1507).
      if (err instanceof AddonRequestError && err.status === 400) {
        if (ADDON_LACKS_WANTED.test(err.detail ?? err.message)) continue;
        break;
      }
      // 'enqueue-failed' is terminal for the caller (the watchlist marks the row
      // failed), so it has to mean "asking again will fail again". A source that
      // went down between the hunt and the enqueue is the opposite of that, and
      // used to kill the row over an outage that clears in minutes. The addon's
      // readiness is the discriminator — and only ever downgrades a failure to a
      // retry, so if asking throws we keep the original, harsher outcome.
      if (!(await addonIsReady(addon))) {
        return { outcome: 'slskd-unavailable', detail: 'Source offline — enqueue deferred' };
      }
    }
  }
  if (!addonJob) {
    // One refusal reads as its cause; several need their peers to tell them apart.
    const detail =
      refusals.length === 1
        ? refusals[0]!.cause
        : refusals.map((r) => `${r.peer}: ${r.cause}`).join('; ');
    return { outcome: 'enqueue-failed', detail };
  }

  // The unified feed row carries the hunt metadata; the poller mirrors the
  // addon's items into it (repoints included) via the job mapping.
  const sourceRef = `addon:${addonId}:${addonJob.id}`;
  try {
    if (input.reservedJobId) attachAddonRef(db, input.reservedJobId, sourceRef);
    const coreJobId =
      input.reservedJobId ??
      createJob(db, {
        kind: 'auto-acquire',
        method: addonId,
        artistName,
        albumTitle,
        lidarrAlbumId,
        artistMbid: artistMbid ?? null,
        canonicalTracks: titles,
        sourceRef,
        userId: input.userId ?? null,
        files: [],
      });
    // `addonJob.createdAt` is what lets a later poll tell "this exact job's
    // card was removed" apart from "the addon restarted and reissued this id
    // for a different job" (issue #1018) — the same protection the poller's
    // own auto-mint path gets.
    mapAddonJob(db, addonId, addonJob.id, coreJobId, addonJob.createdAt);
  } catch (err) {
    log.warn({ lidarrAlbumId, err }, 'Failed to record acquisition job for addon acquire');
  }

  log.info(
    { lidarrAlbumId, album: albumTitle, addonId, matchPct: best.matchPct },
    'Auto-acquired album via addon',
  );
  return { outcome: 'enqueued' };
}
