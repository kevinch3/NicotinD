import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError, type HuntLane } from './addons/client.js';
import { mapAddonJob } from './addons/job-poller.js';
import { rankAlternates, type AlternateSource } from './download-resource.js';
import {
  activePeers,
  addonJobIdsOf,
  canResourceJob,
  claimUnattributedItems,
  getJob,
  huntTracklist,
  recomputeStage,
  reserveResourcedItems,
  resourceableTitles,
  supersedeItems,
  type AcquisitionJob,
} from './acquisition-job-store.js';

const log = createLogger('job-resource');

/**
 * Re-sourcing a card's pending titles from another peer (#1065), shared by the
 * button's two routes and the automatic completion of a partial (#1879), so the
 * pick and the hand-over have one home. → docs/download-pipeline.md
 * "Re-sourcing from another peer".
 */

/** Parse a `addon:<id>:<jobId>` sourceRef, if that's what it is. */
export function parseAddonRef(
  sourceRef: string | null,
): { addonId: string; addonJobId: string } | null {
  if (!sourceRef?.startsWith('addon:')) return null;
  const rest = sourceRef.slice('addon:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return { addonId: rest.slice(0, sep), addonJobId: rest.slice(sep + 1) };
}

export interface ResourceTarget {
  job: AcquisitionJob;
  ref: { addonId: string; addonJobId: string };
  addon: RemoteAddonPlugin;
  tracklist: string[];
}

export type ResourceRefusal = { status: 400 | 404 | 503; error: string };

/** The job, its addon and its tracklist — or why this card cannot be re-sourced. */
export function resolveResourceTarget(
  db: Database,
  getPlugin: (addonId: string) => unknown,
  jobId: string,
): ResourceTarget | ResourceRefusal {
  const job = getJob(db, jobId);
  if (!job) return { status: 404, error: 'Job not found' };
  const row = db
    .query<{ cancel_requested_at: number | null }, [string]>(
      `SELECT cancel_requested_at FROM acquisition_jobs WHERE id = ?`,
    )
    .get(job.id);
  const facts = {
    kind: job.kind,
    artistName: job.artistName,
    albumTitle: job.albumTitle,
    canonicalTracks: job.canonicalTracks,
    cancelRequestedAt: row?.cancel_requested_at ?? null,
    items: job.items,
  };
  if (!canResourceJob(facts)) {
    return { status: 400, error: 'This download cannot be re-sourced from another peer' };
  }
  const ref = parseAddonRef(job.sourceRef);
  if (!ref || ref.addonId !== job.method) {
    return { status: 400, error: 'No acquisition addon owns this download' };
  }
  const addon = getPlugin(ref.addonId);
  if (!(addon instanceof RemoteAddonPlugin)) {
    return { status: 503, error: 'The acquisition addon is not available' };
  }
  return { job, ref, addon, tracklist: huntTracklist(facts) };
}

export interface AlternatesFound {
  wanted: string[];
  required: string[];
  alternates: AlternateSource[];
  rateLimited: boolean;
  sourceOffline: boolean;
}

/**
 * Which other peers have the tracks this job is still missing. Re-runs the hunt
 * and subtracts the peers already on the card — an "alternate" that is the
 * peer we are already waiting on is the same dead end. Throws what
 * `albumsSearch` throws (an `AddonTimeoutError` included).
 */
export async function searchAlternates(
  db: Database,
  target: ResourceTarget,
  opts: { require?: string[]; timeoutMs: number; lane: HuntLane },
): Promise<AlternatesFound | null> {
  const { job, addon } = target;
  // Coverage is always measured over EVERYTHING still pending, because that
  // is what the chosen peer will be asked for: re-sourcing releases the stuck
  // job, so there is no second source left to split the remainder with
  // (#1069). A narrower `wanted` here would quietly shrink the request.
  const wanted = resourceableTitles(db, job.id);
  if (!wanted.length) return null;
  // Ticked tracks are a REQUIREMENT, not a narrowing: "only offer peers that
  // have these". Intersected with what is pending right now, so a track
  // delivered since the tick cannot rule out every peer.
  const required = (opts.require ?? []).filter((t) => wanted.includes(t));
  const res = await addon.client.albumsSearch(
    {
      artist: job.artistName ?? '',
      album: job.albumTitle ?? '',
      canonicalTracks: target.tracklist.map((title) => ({ title })),
    },
    {
      timeoutMs: opts.timeoutMs,
      lane: opts.lane,
      ...(job.lidarrAlbumId ? { albumId: job.lidarrAlbumId } : {}),
    },
  );
  const ranked = rankAlternates(wanted, res.candidates, activePeers(db, job.id));
  return {
    wanted,
    required,
    alternates: required.length
      ? ranked.filter((a) => required.every((t) => a.coveredTitles.includes(t)))
      : ranked,
    // An empty list means something different in each of these cases, and the
    // picker says so: throttled and offline are both "we could not look
    // properly", not "nobody has it" (#1040, #1045).
    rateLimited: res.rateLimited ?? false,
    sourceOffline: res.sourceOffline ?? false,
  };
}

export type SwitchResult =
  | { status: 'switched'; addonJobId: string; titles: string[] }
  | { status: 'nothing-pending' }
  | { status: 'conflict' }
  | { status: 'expired' };

/**
 * Hand the named titles (default: everything still pending) to the chosen
 * peer. The new addon job is mapped onto THIS core job, so its items mirror
 * into the same card rather than opening a second one.
 */
export async function switchToPeer(
  db: Database,
  target: ResourceTarget,
  candidateRef: string,
  requested?: string[],
): Promise<SwitchResult> {
  const { job, ref, addon } = target;
  const available = resourceableTitles(db, job.id);
  // Intersected with what is pending RIGHT NOW: the picker's list was built
  // from a search that took tens of seconds, and a track delivered in the
  // meantime must not be taken away from the peer that delivered it.
  const titles = requested?.length ? requested.filter((t) => available.includes(t)) : available;
  if (!titles.length) return { status: 'nothing-pending' };

  // Attribute the existing rows BEFORE a second addon job can report, so the
  // terminal sweeps can tell the two apart (see OWNED_BY_ADDON_JOB).
  claimUnattributedItems(db, job.id, ref.addonJobId);

  // Release the stuck job FIRST (#1069). An addon may allow only one active
  // job per release — slskd does, and answers a second one with 409 — so
  // creating before cancelling made every re-source fail against the real
  // addon while passing against a more permissive test double. Cancelling
  // does not delete what already landed (only `deleteJob` does); it ends the
  // transfers that were not moving, which is the situation being fixed.
  //
  // This is why the new peer takes ALL of what is still pending rather than
  // only a ticked subset: once the old job is gone there is no second source
  // left to split with, so a split would just be a slower way to lose tracks.
  //
  // "The stuck job" is whichever peer holds the pending rows NOW: after one
  // re-source that is the replacement, not `source_ref`'s first job (#1878).
  for (const addonJobId of addonJobIdsOf(db, job.id, ref.addonJobId, { live: true })) {
    await addon.client.cancelJob(addonJobId).catch((err: unknown) => {
      log.warn(
        { jobId: job.id, addonJobId, err },
        're-source: cancelling the stuck addon job failed',
      );
    });
  }

  let addonJobId: string;
  try {
    const created = await addon.client.createJob({
      intent: 'album',
      artist: job.artistName ?? undefined,
      album: job.albumTitle ?? undefined,
      canonicalTracks: target.tracklist.map((title) => ({ title })),
      // The whole point: this peer is asked for the missing titles only, not
      // for the folder again.
      wantedTracks: titles.map((title) => ({ title })),
      candidateRef,
    });
    addonJobId = created.id;
  } catch (err) {
    // Past the cancel, so the stuck job is gone either way and its items will
    // settle as `unavailable`. Say which failure this was: only an expired
    // selection is fixed by searching again.
    log.warn({ jobId: job.id, err }, 're-source rejected by the addon');
    recomputeStage(db, job.id);
    const status = err instanceof AddonRequestError ? err.status : null;
    return { status: status === 409 ? 'conflict' : 'expired' };
  }

  mapAddonJob(db, ref.addonId, addonJobId, job.id);
  supersedeItems(db, job.id, titles);
  // After the supersede, which would otherwise take these queued rows too.
  reserveResourcedItems(db, job.id, addonJobId, titles);
  recomputeStage(db, job.id);
  return { status: 'switched', addonJobId, titles };
}
