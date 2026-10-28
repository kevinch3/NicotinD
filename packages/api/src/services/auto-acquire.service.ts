import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { Lidarr, LidarrAlbum } from '../lidarr/index.js';
import type { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { acquireAlbum } from './album-acquire.js';
import { albumAlreadyComplete } from './library-completeness.js';

const log = createLogger('auto-acquire');

/** Missing-list page size — fixed, independent of `maxPerSweep`. */
export const AUTO_ACQUIRE_PAGE_SIZE = 50;

/** Pages read per sweep at most, so a sweep stays a bounded number of Lidarr calls. */
export const AUTO_ACQUIRE_MAX_PAGES = 4;

export interface AutoAcquireDeps {
  db: Database;
  lidarr: Lidarr;
  /** Live lookup of the active remote acquisition addon (phase-2 cutover). */
  getAddon: () => RemoteAddonPlugin | null;
  /** How often the poller sweeps Lidarr's missing list (default 1h). */
  intervalMs?: number;
  /** Max albums acquired per sweep, so we never flood slskd. */
  maxPerSweep?: number;
  /** Minimum folder match % to auto-acquire unattended. */
  minMatchPct?: number;
  /**
   * Gate on an enabled acquisition plugin. When it returns false the poller skips
   * the whole sweep (no new downloads) even though slskd may be configured —
   * respects the plugin toggle, same as the watchlist poller.
   */
  isAcquisitionEnabled?: () => boolean;
}

/**
 * Native "Soularr-equivalent" auto-acquisition loop. Periodically pulls Lidarr's
 * *wanted/missing* list (monitored albums Lidarr doesn't have) and feeds each,
 * capped per sweep, into the shared `acquireAlbum` core — the same hunt/select/
 * enqueue/fallback primitives the interactive hunt and the watchlist poller use.
 *
 * Structurally a `WatchlistService` seeded from Lidarr instead of the star table:
 * the only new behaviour is *where the albums come from*. It's re-entrant and
 * idempotent — `acquireAlbum`'s `already-complete`/`in-flight` guards mean a
 * repeated sweep never double-downloads, so no extra bookkeeping table is needed.
 *
 * Default-off (opt-in via `downloads.autoAcquireEnabled`). See
 * docs/auto-acquisition-plan.md.
 */
export class AutoAcquireService {
  private db: Database;
  private lidarr: Lidarr;
  private getAddon: () => RemoteAddonPlugin | null;
  private intervalMs: number;
  private maxPerSweep: number;
  private minMatchPct: number;
  private isAcquisitionEnabled: () => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  /** 1-based missing-list page the next sweep starts from. */
  private nextPage = 1;

  constructor(deps: AutoAcquireDeps) {
    this.db = deps.db;
    this.lidarr = deps.lidarr;
    this.getAddon = deps.getAddon;
    this.intervalMs = deps.intervalMs ?? 3_600_000;
    this.maxPerSweep = deps.maxPerSweep ?? 3;
    this.minMatchPct = deps.minMatchPct ?? 80;
    this.isAcquisitionEnabled = deps.isAcquisitionEnabled ?? (() => true);
  }

  start(): void {
    if (this.timer) return;
    log.info(
      { intervalMs: this.intervalMs, maxPerSweep: this.maxPerSweep, minMatchPct: this.minMatchPct },
      'Starting auto-acquire poller',
    );
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    void this.sweep();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep over Lidarr's missing list. Public so tests can drive it.
   *
   * Lidarr's "missing" comes from its own file scan, which never sees the library
   * once its root folder is kept off it (#1580) — so the list leads with albums
   * we already hold. The sweep therefore walks pages from a cursor that persists
   * across sweeps, and only an album that is actually attempted spends the
   * `maxPerSweep` budget.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    // Respect the acquisition-plugin toggle — no auto-downloads when disabled.
    if (!this.isAcquisitionEnabled()) return;
    this.sweeping = true;
    try {
      let attempted = 0;
      for (let read = 0; read < AUTO_ACQUIRE_MAX_PAGES && attempted < this.maxPerSweep; read++) {
        let page: LidarrAlbum[];
        try {
          page = await this.lidarr.album.wantedMissing(this.nextPage, AUTO_ACQUIRE_PAGE_SIZE);
        } catch (err) {
          log.debug({ err }, 'wantedMissing failed during auto-acquire sweep');
          return;
        }

        let i = 0;
        for (; i < page.length && attempted < this.maxPerSweep; i++) {
          if (await this.tryAcquire(page[i]!)) attempted++;
        }
        // A page the budget cut short is re-read next sweep; a finished one
        // advances the cursor, and the short last page wraps it to the start.
        if (i < page.length) break;
        const last = page.length < AUTO_ACQUIRE_PAGE_SIZE;
        this.nextPage = last ? 1 : this.nextPage + 1;
        if (last) break;
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** True when the album spent the sweep's budget — anything but "already have it". */
  private async tryAcquire(album: LidarrAlbum): Promise<boolean> {
    const artistName = album.artist?.artistName;
    if (!artistName || !album.title) return false;
    // Checked here when Lidarr states the track total, saving acquireAlbum's
    // per-album tracklist call; without it acquireAlbum makes the same check.
    const total = album.statistics?.totalTrackCount ?? 0;
    if (total > 0 && albumAlreadyComplete(this.db, artistName, album.title, total)) return false;
    try {
      const { outcome, detail } = await acquireAlbum(
        { db: this.db, lidarr: this.lidarr, getAddon: this.getAddon },
        {
          lidarrAlbumId: album.id,
          artistName,
          albumTitle: album.title,
          minMatchPct: this.minMatchPct,
          artistMbid: album.artist?.foreignArtistId ?? null,
        },
      );
      log.debug(
        { albumId: album.id, album: album.title, outcome, detail },
        'Auto-acquire sweep result',
      );
      return outcome !== 'already-complete';
    } catch (err) {
      log.debug({ albumId: album.id, err }, 'Auto-acquire attempt failed; will retry next sweep');
      return true;
    }
  }
}
