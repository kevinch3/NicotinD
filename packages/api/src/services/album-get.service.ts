import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { Lidarr } from '../lidarr/index.js';
import type { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { acquireAlbum, type AcquireResult } from './album-acquire.js';
import { albumGetRetryDelayMs } from './album-get-retry.js';
import { albumAlreadyComplete } from './library-completeness.js';
import { albumIdFor, artistIdFor } from './library-scanner.js';
import { pickAlbumCover, pickArtistImage, setArtwork } from './artwork-store.js';
import { recordAcquiredArtistIdentity } from './artist-identity-store.js';
import {
  createJob,
  discardReservedJob,
  failReservedJob,
  findActiveAlbumJob,
  holdAlbum,
  isReservedJobPending,
  listReservedAlbumGets,
} from './acquisition-job-store.js';
import { HuntQueue } from './hunt-queue.js';

const log = createLogger('album-get');

/** Nobody holds a request on a queued Get, so its hunt gets the addon's whole multi-wave budget. */
const GET_HUNT_TIMEOUT_MS = 120_000;
/**
 * The bar a click's pick must clear. Lower than the unattended sweeps' (80): a
 * person asked for this album by name, where a sweep must not guess.
 */
export const GET_MIN_MATCH_PCT = 60;
/** The reserved rows are the queue; this only bounds a runaway caller. */
const MAX_WAITING = 1_000;

export type AlbumGetAnswer =
  | { status: 'accepted'; jobId: string }
  | { status: 'already-downloading'; jobId?: string }
  | { status: 'already-complete' }
  | { status: 'no-addon' }
  | { status: 'unknown-album' };

export interface AlbumGetRequest {
  lidarrAlbumId: number;
  /** The names the surface shows, when they differ from Lidarr's. */
  artistName?: string;
  albumTitle?: string;
  localAlbumId?: string;
  userId: string | null;
}

export interface AlbumGetDeps {
  db: Database;
  lidarr: Lidarr;
  getAddon: () => RemoteAddonPlugin | null;
  minMatchPct?: number;
  coverCacheDir?: string;
  retryDelayMs?: (attempt: number) => number | null;
  schedule?: (fn: () => void, ms: number) => void;
}

interface PendingGet {
  jobId: string;
  lidarrAlbumId: number;
  artistName: string;
  albumTitle: string;
  artistMbid: string | null;
  userId: string | null;
  localAlbumId?: string;
}

/**
 * A one-click album Get, owned by the server from the click on: the job row is
 * reserved before the source is asked, the hunt waits its turn in core, and a
 * source that could not search is asked again later. The browser only posts the
 * intent and reads the downloads feed. See docs/album-hunt.md "A Get is a server job".
 */
export class AlbumGetService {
  private readonly queue = new HuntQueue<AcquireResult>({ maxQueued: MAX_WAITING });
  private readonly attempts = new Map<string, Promise<void>>();
  private readonly retryDelayMs: (attempt: number) => number | null;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly deps: AlbumGetDeps) {
    this.retryDelayMs = deps.retryDelayMs ?? albumGetRetryDelayMs;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref?.();
      });
  }

  async request(req: AlbumGetRequest): Promise<AlbumGetAnswer> {
    const { db, lidarr } = this.deps;
    const addon = this.deps.getAddon();
    if (!addon) return { status: 'no-addon' };

    const byId = { lidarrAlbumId: req.lidarrAlbumId };
    const active = findActiveAlbumJob(db, byId);
    if (active) return { status: 'already-downloading', jobId: active.id };
    const release = holdAlbum(byId);
    if (!release) return { status: 'already-downloading' };
    let releaseNamed: (() => void) | null = null;
    try {
      const [album, tracks] = await Promise.all([
        lidarr.album.get(req.lidarrAlbumId).catch(() => null),
        lidarr.track.listByAlbum(req.lidarrAlbumId).catch(() => []),
      ]);
      const artistName = req.artistName ?? album?.artist?.artistName;
      const albumTitle = req.albumTitle ?? album?.title;
      if (!artistName || !albumTitle) return { status: 'unknown-album' };

      // The same album under another lane's naming (#1539).
      const named = { artist: artistName, title: albumTitle };
      const other = findActiveAlbumJob(db, named);
      if (other) return { status: 'already-downloading', jobId: other.id };
      releaseNamed = holdAlbum(named);
      if (!releaseNamed) return { status: 'already-downloading' };

      if (tracks.length > 0 && albumAlreadyComplete(db, artistName, albumTitle, tracks.length)) {
        return { status: 'already-complete' };
      }

      const artistMbid = album?.artist?.foreignArtistId ?? null;
      this.persistCanonical(album, artistName, albumTitle, artistMbid);

      const jobId = createJob(db, {
        kind: 'album-hunt',
        method: addon.manifest.id,
        stage: 'resolving',
        userId: req.userId,
        artistName,
        albumTitle,
        lidarrAlbumId: req.lidarrAlbumId,
        releaseMbid: album?.foreignAlbumId ?? null,
        artistMbid,
        genres: album?.genres?.length ? album.genres : (album?.artist?.genres ?? null),
        year: album?.releaseDate ? new Date(album.releaseDate).getUTCFullYear() : null,
        canonicalTracks: tracks.map((t) => t.title),
        files: [],
      });
      this.enqueue(
        {
          jobId,
          lidarrAlbumId: req.lidarrAlbumId,
          artistName,
          albumTitle,
          artistMbid,
          userId: req.userId,
          localAlbumId: req.localAlbumId,
        },
        1,
      );
      return { status: 'accepted', jobId };
    } finally {
      release();
      releaseNamed?.();
    }
  }

  /** Queue again every Get a restart interrupted before its source was asked. */
  resumePending(): number {
    const rows = listReservedAlbumGets(this.deps.db);
    for (const r of rows) this.enqueue({ ...r, jobId: r.id }, 1);
    if (rows.length) log.info({ count: rows.length }, 'Resumed reserved album Gets');
    return rows.length;
  }

  /** Resolves once the job's current attempt has run — for tests and shutdown. */
  async settled(jobId: string): Promise<void> {
    await this.attempts.get(jobId);
  }

  private enqueue(get: PendingGet, attempt: number): void {
    const { db } = this.deps;
    try {
      const { id } = this.queue.enqueue(get.jobId, async () => {
        const result = await this.run(get);
        this.conclude(get, attempt, result);
        return result;
      });
      const done = this.queue.wait(id).then(
        () => {},
        () => {},
      );
      this.attempts.set(get.jobId, done);
      void done.then(() => {
        if (this.attempts.get(get.jobId) === done) this.attempts.delete(get.jobId);
      });
    } catch (err) {
      failReservedJob(db, get.jobId, err instanceof Error ? err.message : String(err));
    }
  }

  private async run(get: PendingGet): Promise<AcquireResult> {
    const { db, lidarr, getAddon, minMatchPct = GET_MIN_MATCH_PCT } = this.deps;
    if (!isReservedJobPending(db, get.jobId)) return { outcome: 'cancelled' };
    try {
      return await acquireAlbum(
        { db, lidarr, getAddon },
        {
          lidarrAlbumId: get.lidarrAlbumId,
          artistName: get.artistName,
          albumTitle: get.albumTitle,
          artistMbid: get.artistMbid,
          userId: get.userId,
          localAlbumId: get.localAlbumId,
          minMatchPct,
          huntTimeoutMs: GET_HUNT_TIMEOUT_MS,
          lane: 'get',
          reservedJobId: get.jobId,
          stillWanted: () => isReservedJobPending(db, get.jobId),
        },
      );
    } catch (err) {
      log.warn({ jobId: get.jobId, err }, 'Album Get threw');
      return {
        outcome: 'enqueue-failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private conclude(get: PendingGet, attempt: number, result: AcquireResult): void {
    const { db } = this.deps;
    const { outcome, detail } = result;
    log.info(
      { jobId: get.jobId, albumId: get.lidarrAlbumId, attempt, outcome, detail },
      'Album Get attempt finished',
    );
    switch (outcome) {
      case 'enqueued':
      case 'cancelled':
        return;
      // Nothing to fetch, or another lane's job already is: no card of our own.
      case 'already-complete':
      case 'in-flight':
        discardReservedJob(db, get.jobId);
        return;
      case 'slskd-unavailable': {
        const delay = this.retryDelayMs(attempt);
        if (delay === null) {
          failReservedJob(db, get.jobId, detail ?? 'The download source stayed unavailable.');
          return;
        }
        this.schedule(() => {
          if (isReservedJobPending(db, get.jobId)) this.enqueue(get, attempt + 1);
        }, delay);
        return;
      }
      case 'no-candidate':
        failReservedJob(db, get.jobId, detail ?? 'No confident match was found on the source.');
        return;
      case 'enqueue-failed':
        failReservedJob(db, get.jobId, detail ?? 'The source refused the download.');
        return;
    }
  }

  /** The cover and identity the surface showed, kept for the scan that lands the files. */
  private persistCanonical(
    album: Awaited<ReturnType<Lidarr['album']['get']>> | null,
    artistName: string,
    albumTitle: string,
    artistMbid: string | null,
  ): void {
    const { db, coverCacheDir } = this.deps;
    try {
      const albumCover = pickAlbumCover(album?.images);
      if (albumCover) {
        setArtwork(db, albumIdFor(artistName, albumTitle), 'album', albumCover, coverCacheDir);
      }
      const artistImage = pickArtistImage(album?.artist?.images);
      if (artistImage) {
        setArtwork(db, artistIdFor(artistName), 'artist', artistImage, coverCacheDir, 'lidarr');
      }
      recordAcquiredArtistIdentity(db, {
        artistKey: artistIdFor(artistName),
        artistName,
        mbid: artistMbid,
      });
    } catch (err) {
      log.warn(
        { albumId: albumIdFor(artistName, albumTitle), err },
        'Failed to persist canonical art',
      );
    }
  }
}
