import type { Database } from 'bun:sqlite';
import { createLogger, spotifyResourceFromUrl } from '@nicotind/core';

const log = createLogger('acquire-prefetch');

export interface ReleaseLookup {
  lookupRelease(resource: { kind: 'album' | 'playlist' | 'track'; id: string }): Promise<{
    name: string;
    artist: string | null;
    trackTitles: string[];
  } | null>;
}

/**
 * Resolve *what a pasted link is* without waiting for the transfer.
 *
 * A URL job used to learn its own name and size from the download: the addon
 * accepts the link, the row moves to `queued`, and both arrive later with the
 * files. Five simultaneous Spotify submissions therefore rendered as five
 * identical `Spotify download · 0 of 0 · 5m ago` rows for minutes (issue #989),
 * and the denominator — `COUNT(*)` over the item rows mirrored so far — climbed
 * as they landed, so progress ran backwards (issue #990).
 *
 * Identity is cheap and needs no download slot, so it is resolved on its own.
 * Two properties make this safe to run beside the addon:
 *
 * - **It never overwrites.** Every write is `COALESCE`-guarded, so an addon that
 *   reports real metadata always wins, whenever it arrives.
 * - **It never fails a job.** A missing credential, a private playlist or an
 *   upstream blip leaves the row exactly as it was; the addon remains the
 *   authority and the card degrades to the behaviour it has today.
 *
 * The tracklist is written to `canonical_tracks_json`, which is already the
 * column the feed reads as the release's committed size — so the denominator is
 * fixed at resolve time rather than re-derived from arrivals.
 */
export class AcquireMetadataPrefetch {
  /** In-flight resolves, so tests (and shutdown) can wait rather than sleep. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly lookup: ReleaseLookup,
  ) {}

  /**
   * Kick off a resolve for `jobId`. Deliberately not awaited by the submit
   * path — the response must not wait on Spotify — but tracked, because an
   * untracked fire-and-forget is how a scan race became an e2e flake (#655).
   */
  start(jobId: string, sourceUrl: string): void {
    const resource = spotifyResourceFromUrl(sourceUrl);
    if (!resource) return;
    const task = this.resolve(jobId, resource).finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }

  /** Resolve once every started lookup has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private async resolve(
    jobId: string,
    resource: { kind: 'album' | 'playlist' | 'track'; id: string },
  ): Promise<void> {
    const found = await this.lookup.lookupRelease(resource).catch(() => null);
    if (!found) return;

    const now = Date.now();
    // The display title names the card whatever the link is; only an *album*
    // link may name an album, because filing metadata built from a playlist
    // name mints a phantom album (see albumTitleForUrlJob).
    this.db.run(
      `UPDATE acquisition_jobs
         SET display_title = COALESCE(display_title, ?),
             artist_name   = COALESCE(artist_name, ?),
             album_title   = COALESCE(album_title, ?),
             updated_at    = ?
       WHERE id = ?`,
      [found.name, found.artist, resource.kind === 'album' ? found.name : null, now, jobId],
    );
    if (found.trackTitles.length > 0) {
      this.db.run(
        `UPDATE acquisition_jobs
           SET canonical_tracks_json = COALESCE(canonical_tracks_json, ?), updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(found.trackTitles), now, jobId],
      );
    }
    log.info(
      { jobId, kind: resource.kind, name: found.name, tracks: found.trackTitles.length },
      'resolved a link’s identity ahead of its transfer',
    );
  }
}
