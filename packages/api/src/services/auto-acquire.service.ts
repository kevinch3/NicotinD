import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { SlskdRef } from '../index.js';
import type { AlbumHunterService } from './album-hunter.service.js';
import { acquireAlbum } from './album-acquire.js';

const log = createLogger('auto-acquire');

export interface AutoAcquireDeps {
  db: Database;
  hunter: AlbumHunterService;
  lidarr: Lidarr;
  slskdRef: SlskdRef;
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
  private hunter: AlbumHunterService;
  private lidarr: Lidarr;
  private slskdRef: SlskdRef;
  private intervalMs: number;
  private maxPerSweep: number;
  private minMatchPct: number;
  private isAcquisitionEnabled: () => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(deps: AutoAcquireDeps) {
    this.db = deps.db;
    this.hunter = deps.hunter;
    this.lidarr = deps.lidarr;
    this.slskdRef = deps.slskdRef;
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

  /** One sweep over Lidarr's missing list. Public so tests can drive it. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    // Respect the acquisition-plugin toggle — no auto-downloads when disabled.
    if (!this.isAcquisitionEnabled()) return;
    this.sweeping = true;
    try {
      let missing;
      try {
        missing = await this.lidarr.album.wantedMissing(1, this.maxPerSweep);
      } catch (err) {
        log.debug({ err }, 'wantedMissing failed during auto-acquire sweep');
        return;
      }

      for (const album of missing) {
        const artistName = album.artist?.artistName;
        if (!artistName || !album.title) continue;
        try {
          const outcome = await acquireAlbum(
            { db: this.db, hunter: this.hunter, lidarr: this.lidarr, slskdRef: this.slskdRef },
            {
              lidarrAlbumId: album.id,
              artistName,
              albumTitle: album.title,
              minMatchPct: this.minMatchPct,
              artistMbid: album.artist?.foreignArtistId ?? null,
            },
          );
          log.debug({ albumId: album.id, album: album.title, outcome }, 'Auto-acquire sweep result');
        } catch (err) {
          log.debug({ albumId: album.id, err }, 'Auto-acquire attempt failed; will retry next sweep');
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
