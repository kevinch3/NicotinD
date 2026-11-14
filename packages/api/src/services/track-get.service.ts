import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError } from './addons/client.js';
import { mapAddonJob, sanitizeAddonError } from './addons/job-poller.js';
import {
  attachAddonRef,
  createJob,
  failReservedJob,
  isReservedJobPending,
} from './acquisition-job-store.js';
import { HuntQueue } from './hunt-queue.js';

const log = createLogger('track-get');

/** The reserved rows are the queue; this only bounds a runaway caller. */
const MAX_WAITING = 1_000;

export type TrackGetAnswer = { status: 'accepted'; jobId: string } | { status: 'no-addon' };

export interface TrackGetRequest {
  artist: string;
  title: string;
  /** The release the track was seen on, when the surface knows it: the organizer files by it. */
  album?: string | null;
  userId: string | null;
}

export interface TrackGetDeps {
  db: Database;
  getAddon: () => RemoteAddonPlugin | null;
}

interface PendingTrackGet {
  jobId: string;
  artist: string;
  title: string;
  album: string | null;
}

/**
 * A one-click track Get, owned by the server from the click on (#1885), the
 * album Get's shape for one song: the job row is reserved in `resolving` before
 * the source is asked, so the row shows it at once and it survives the tab
 * closing. The source's `tracks` intent then finds the song on the network and
 * picks the copy; a peer that fails is the addon's to replace. A song nobody
 * has closes the job with the reason, on the same feed. See docs/album-hunt.md
 * "A track Get is a server job".
 */
export class TrackGetService {
  private readonly queue = new HuntQueue<void>({ maxQueued: MAX_WAITING });
  private readonly attempts = new Map<string, Promise<void>>();

  constructor(private readonly deps: TrackGetDeps) {}

  request(req: TrackGetRequest): TrackGetAnswer {
    const addon = this.deps.getAddon();
    if (!addon) return { status: 'no-addon' };
    const album = req.album?.trim() || null;
    const jobId = createJob(this.deps.db, {
      kind: 'track-search',
      method: addon.manifest.id,
      stage: 'resolving',
      userId: req.userId,
      artistName: req.artist,
      albumTitle: album,
      displayTitle: req.title,
      canonicalTracks: [req.title],
      files: [],
    });
    this.enqueue({ jobId, artist: req.artist, title: req.title, album });
    return { status: 'accepted', jobId };
  }

  /** Queue again every track Get a restart interrupted before its source was asked. */
  resumePending(): number {
    const rows = this.deps.db
      .query<
        { id: string; artist_name: string; album_title: string | null; tracks: string | null },
        []
      >(
        `SELECT id, artist_name, album_title, canonical_tracks_json AS tracks
           FROM acquisition_jobs
          WHERE state = 'active' AND stage = 'resolving' AND kind = 'track-search'
            AND source_ref IS NULL AND cancel_requested_at IS NULL
            AND artist_name IS NOT NULL
          ORDER BY created_at`,
      )
      .all();
    let resumed = 0;
    for (const r of rows) {
      const title = (JSON.parse(r.tracks ?? '[]') as string[])[0];
      if (!title) continue;
      this.enqueue({ jobId: r.id, artist: r.artist_name, title, album: r.album_title });
      resumed += 1;
    }
    if (resumed) log.info({ count: resumed }, 'Resumed reserved track Gets');
    return resumed;
  }

  /** Resolves once the job's attempt has run — for tests and shutdown. */
  async settled(jobId: string): Promise<void> {
    await this.attempts.get(jobId);
  }

  private enqueue(get: PendingTrackGet): void {
    try {
      const { id } = this.queue.enqueue(get.jobId, () => this.run(get));
      const done = this.queue.wait(id).then(
        () => {},
        () => {},
      );
      this.attempts.set(get.jobId, done);
      void done.then(() => {
        if (this.attempts.get(get.jobId) === done) this.attempts.delete(get.jobId);
      });
    } catch (err) {
      failReservedJob(this.deps.db, get.jobId, err instanceof Error ? err.message : String(err));
    }
  }

  private async run(get: PendingTrackGet): Promise<void> {
    const { db } = this.deps;
    if (!isReservedJobPending(db, get.jobId)) return;
    const addon = this.deps.getAddon();
    if (!addon) {
      failReservedJob(db, get.jobId, 'No download source is enabled.');
      return;
    }
    let job;
    try {
      job = await addon.client.createJob(
        {
          intent: 'tracks',
          artist: get.artist,
          ...(get.album ? { album: get.album } : {}),
          titles: [get.title],
        },
        `track-get:${get.jobId}`,
        { lane: 'track-get' },
      );
    } catch (err) {
      // The source answers 400 when no peer has the song: a miss, not a fault.
      const reason =
        err instanceof AddonRequestError && err.status === 400
          ? `No copy of "${get.title}" was found.`
          : sanitizeAddonError(err instanceof Error ? err.message : String(err));
      failReservedJob(db, get.jobId, reason);
      return;
    }
    if (!isReservedJobPending(db, get.jobId)) {
      // Cancelled while the source searched: stop what it just started.
      await addon.client.cancelJob(job.id).catch(() => undefined);
      return;
    }
    attachAddonRef(db, get.jobId, `addon:${addon.manifest.id}:${job.id}`);
    mapAddonJob(db, addon.manifest.id, job.id, get.jobId, job.createdAt);
  }
}
