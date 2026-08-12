import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  createLogger,
  normalizeTitle,
  titlesOverlap,
  type AddonAlbumCandidate,
  type AddonJobRequest,
} from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import { AlbumFallbackService, type AlternateCandidate } from './album-fallback.service.js';
import type { AlbumHunterService, FolderCandidate } from './album-hunter.service.js';
import type { TrackHunterService } from './track-hunter.service.js';
import {
  addJobItems,
  createAddonJob,
  itemIdForFile,
  itemIdForTitle,
  type NewJobItem,
} from './job-store.js';

const log = createLogger('job-engine');

export class JobConflictError extends Error {
  constructor(readonly existingJobId: string) {
    super('an active job for this album already exists');
  }
}

export class JobRequestError extends Error {}

export interface JobEngineDeps {
  db: Database;
  slskd: Slskd;
  hunter: AlbumHunterService;
  trackHunter: TrackHunterService;
  /** Resolve a candidateRef minted by POST /albums/search. */
  resolveCandidate: (
    ref: string,
  ) => { candidate: FolderCandidate; siblings: FolderCandidate[] } | null;
}

/**
 * Executes a protocol job request (docs/acquisition-addon-protocol.md):
 * `album` hunts/uses a picked folder, enqueues the wanted subset, and arms the
 * per-peer fallback; `tracks` runs individual track hunts; `browse-grab`
 * enqueues explicit peer files. Every path lands a job + items in the ledger
 * the host polls.
 */
export async function executeJobRequest(
  deps: JobEngineDeps,
  req: AddonJobRequest,
): Promise<string> {
  switch (req.intent) {
    case 'album':
      return executeAlbumJob(deps, req);
    case 'tracks':
      return executeTracksJob(deps, req);
    case 'browse-grab':
      return executeBrowseGrab(deps, req);
  }
}

async function executeAlbumJob(deps: JobEngineDeps, req: AddonJobRequest): Promise<string> {
  const { db } = deps;
  if (!req.artist || !req.album) throw new JobRequestError('album jobs need artist + album');
  const canonicalTracks = req.canonicalTracks ?? [];
  const wanted = (req.wantedTracks?.length ? req.wantedTracks : canonicalTracks).map(
    (t) => t.title,
  );

  // Idempotency, addon layer: one active job per (artist, album). The host's
  // own guards run before the request; this catches lost-response retries.
  const existing = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM addon_jobs WHERE state = 'active' AND intent = 'album' AND artist = ? AND album = ?`,
    )
    .get(req.artist, req.album);
  if (existing) throw new JobConflictError(existing.id);

  let best: FolderCandidate;
  let siblings: FolderCandidate[];
  if (req.candidateRef) {
    const resolved = deps.resolveCandidate(req.candidateRef);
    if (!resolved)
      throw new JobRequestError('candidateRef expired or unknown — re-run albums/search');
    best = resolved.candidate;
    siblings = resolved.siblings;
  } else {
    const candidates = await deps.hunter.hunt(req.artist, req.album, canonicalTracks, {
      skewSearch: true,
    });
    const threshold = req.minMatchPct ?? 0;
    const pick = candidates.find((c) => c.matchPct >= threshold);
    if (!pick) {
      throw new JobRequestError(
        `no candidate reached ${threshold}% match (${candidates.length} found)`,
      );
    }
    best = pick;
    siblings = candidates.filter((c) => c !== pick);
  }

  // Scope the enqueue to the wanted tracks (the host's missing-on-disk subset)
  // — the #262 discipline: a whole-discography dump folder must never enqueue
  // beyond the album, and already-owned tracks are never re-pulled.
  const files = wanted.length ? filesMatchingTitles(best.files, wanted) : best.files;
  if (!files.length)
    throw new JobRequestError('the picked folder covers none of the wanted tracks');

  await deps.slskd.transfers.enqueue(best.username, files);

  const alternates: AlternateCandidate[] = siblings.map((c) => ({
    username: c.username,
    directory: c.directory,
    files: c.files.map((f) => ({ filename: f.filename, size: f.size, bitRate: f.bitRate })),
    audioFormat: c.format,
  }));
  const albumJobId = AlbumFallbackService.recordJob(db, {
    lidarrAlbumId: null,
    username: best.username,
    directory: best.directory,
    artistName: req.artist,
    albumTitle: req.album,
    canonicalTracks: canonicalTracks.map((t) => t.title),
    targetFiles: files.map((f) => ({ filename: f.filename })),
    alternates,
  });

  const jobId = randomUUID();
  createAddonJob(db, {
    id: jobId,
    intent: 'album',
    artist: req.artist,
    album: req.album,
    canonicalTracks,
    albumJobId,
  });
  addJobItems(
    db,
    jobId,
    files.map((f): NewJobItem => {
      const title = titleForFile(f.filename, wanted);
      return {
        itemId: title ? itemIdForTitle(title) : itemIdForFile(f.filename),
        title,
        username: best.username,
        filename: f.filename,
        size: f.size,
        bitRateKbps: f.bitRate,
        audioFormat: best.format,
      };
    }),
  );
  log.info({ jobId, albumJobId, files: files.length }, 'album job enqueued');
  return jobId;
}

async function executeTracksJob(deps: JobEngineDeps, req: AddonJobRequest): Promise<string> {
  if (!req.artist || !req.titles?.length) {
    throw new JobRequestError('tracks jobs need artist + titles');
  }
  const result = await deps.trackHunter.huntAndDownload(req.artist, req.titles);
  if (!result.downloads.length) {
    throw new JobRequestError(`no tracks found (${result.misses.length} misses)`);
  }
  const jobId = randomUUID();
  createAddonJob(deps.db, { id: jobId, intent: 'tracks', artist: req.artist, album: req.album });
  addJobItems(
    deps.db,
    jobId,
    result.downloads.map((d): NewJobItem => ({
      itemId: itemIdForTitle(d.title),
      title: d.title,
      username: d.username,
      filename: d.filename,
      size: d.size,
      bitRateKbps: d.bitRate,
    })),
  );
  return jobId;
}

async function executeBrowseGrab(deps: JobEngineDeps, req: AddonJobRequest): Promise<string> {
  if (!req.username || !req.files?.length) {
    throw new JobRequestError('browse-grab jobs need username + files');
  }
  await deps.slskd.transfers.enqueue(req.username, req.files);
  const jobId = randomUUID();
  createAddonJob(deps.db, {
    id: jobId,
    intent: 'browse-grab',
    artist: req.artist,
    album: req.album,
  });
  addJobItems(
    deps.db,
    jobId,
    req.files.map((f): NewJobItem => ({
      itemId: itemIdForFile(f.filename),
      title: null,
      username: req.username!,
      filename: f.filename,
      size: f.size,
    })),
  );
  return jobId;
}

/** Files whose normalized basename overlaps any wanted title (pickAlternate's rule). */
export function filesMatchingTitles<T extends { filename: string }>(
  files: T[],
  titles: string[],
): T[] {
  const normalized = titles.map(normalizeTitle);
  return files.filter((f) => {
    const base = normalizeBasename(f.filename);
    return normalized.some((t) => titlesOverlap(t, base));
  });
}

function titleForFile(filename: string, titles: string[]): string | null {
  const base = normalizeBasename(filename);
  return titles.find((t) => titlesOverlap(normalizeTitle(t), base)) ?? null;
}

function normalizeBasename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const noExt = base.slice(0, base.lastIndexOf('.') || base.length);
  return normalizeTitle(noExt);
}

/** Mint the response candidates + a TTL-bound ref map for later job requests. */
export function candidateCache(ttlMs = 15 * 60_000) {
  const map = new Map<
    string,
    { candidate: FolderCandidate; siblings: FolderCandidate[]; expires: number }
  >();
  return {
    put(candidates: FolderCandidate[]): AddonAlbumCandidate[] {
      const now = Date.now();
      for (const [ref, entry] of map) if (entry.expires < now) map.delete(ref);
      return candidates.map((candidate) => {
        const ref = randomUUID();
        map.set(ref, {
          candidate,
          siblings: candidates.filter((c) => c !== candidate),
          expires: now + ttlMs,
        });
        return {
          candidateRef: ref,
          username: candidate.username,
          directory: candidate.directory,
          matchedTracks: candidate.matchedTracks,
          totalTracks: candidate.totalTracks,
          matchPct: candidate.matchPct,
          format: candidate.format,
          estimatedSizeMb: candidate.estimatedSizeMb,
          isLive: candidate.isLive,
          files: candidate.files.map((f) => ({
            filename: f.filename,
            size: f.size,
            bitRateKbps: f.bitRate,
          })),
          freeUploadSlots: candidate.freeUploadSlots,
          queueLength: candidate.queueLength,
          uploadSpeed: candidate.uploadSpeed,
        };
      });
    },
    resolve(ref: string) {
      const entry = map.get(ref);
      if (!entry || entry.expires < Date.now()) return null;
      return { candidate: entry.candidate, siblings: entry.siblings };
    },
  };
}
