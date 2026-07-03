import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { SlskdRef } from '../index.js';
import type { CatalogService } from './catalog-search.service.js';
import type { AlbumHunterService } from './album-hunter.service.js';
import { acquireAlbum } from './album-acquire.js';

const log = createLogger('watchlist');

export interface WatchlistRow {
  id: number;
  foreign_album_id: string | null;
  artist_mbid: string | null;
  artist_name: string;
  album_title: string;
  lidarr_album_id: number | null;
  state: 'watching' | 'acquired' | 'failed';
  last_checked_at: number | null;
  last_error: string | null;
  created_at: number;
}

export interface AddWatchInput {
  foreignAlbumId?: string | null;
  artistMbid?: string | null;
  artistName: string;
  albumTitle: string;
}

export interface WatchlistDeps {
  db: Database;
  catalog: CatalogService;
  hunter: AlbumHunterService;
  lidarr: Lidarr;
  slskdRef: SlskdRef;
  intervalMs?: number;
  minMatchPct?: number;
  enabled?: boolean;
  /**
   * Gate auto-acquisition on an enabled acquisition plugin. When it returns
   * false the poller skips the whole sweep (no new downloads initiated) even
   * though slskd may still be configured — respects the plugin toggle.
   */
  isAcquisitionEnabled?: () => boolean;
}

/**
 * Monitors albums the user wants and auto-acquires them once a confidently
 * complete folder appears on Soulseek. Each `watching` row is periodically
 * hunted; the first candidate at/above `minMatchPct` is downloaded through the
 * same primitives the interactive hunt uses (idempotency guard, fallback job
 * record), then the row flips to `acquired`. A row already on disk, or with a
 * download already in flight, resolves without a second download.
 *
 * Trade-off (consistent with the catalog/discography flow): resolving a watched
 * album adds its artist to Lidarr as monitored.
 */
export class WatchlistService {
  private db: Database;
  private catalog: CatalogService;
  private hunter: AlbumHunterService;
  private lidarr: Lidarr;
  private slskdRef: SlskdRef;
  private intervalMs: number;
  private minMatchPct: number;
  private enabled: boolean;
  private isAcquisitionEnabled: () => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(deps: WatchlistDeps) {
    this.db = deps.db;
    this.catalog = deps.catalog;
    this.hunter = deps.hunter;
    this.lidarr = deps.lidarr;
    this.slskdRef = deps.slskdRef;
    this.intervalMs = deps.intervalMs ?? 1_800_000;
    this.minMatchPct = deps.minMatchPct ?? 80;
    this.enabled = deps.enabled ?? true;
    this.isAcquisitionEnabled = deps.isAcquisitionEnabled ?? (() => true);
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    log.info(
      { intervalMs: this.intervalMs, minMatchPct: this.minMatchPct },
      'Starting watchlist poller',
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

  list(): WatchlistRow[] {
    return this.db
      .query<WatchlistRow, []>('SELECT * FROM watchlist ORDER BY created_at DESC')
      .all();
  }

  /** Add (or re-arm) a watched album. Idempotent on foreign_album_id. */
  add(input: AddWatchInput): WatchlistRow {
    const existing = input.foreignAlbumId
      ? this.db
          .query<WatchlistRow, [string]>('SELECT * FROM watchlist WHERE foreign_album_id = ?')
          .get(input.foreignAlbumId)
      : null;
    if (existing) {
      // Re-arm a previously acquired/failed entry so it's hunted again.
      if (existing.state !== 'watching') {
        this.db.run(`UPDATE watchlist SET state = 'watching', last_error = NULL WHERE id = ?`, [
          existing.id,
        ]);
      }
      return this.get(existing.id)!;
    }
    this.db.run(
      `INSERT INTO watchlist (foreign_album_id, artist_mbid, artist_name, album_title, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.foreignAlbumId ?? null,
        input.artistMbid ?? null,
        input.artistName,
        input.albumTitle,
        Date.now(),
      ],
    );
    const id = Number(
      (this.db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
    );
    return this.get(id)!;
  }

  remove(id: number): boolean {
    const res = this.db.run('DELETE FROM watchlist WHERE id = ?', [id]);
    return Number(res.changes ?? 0) > 0;
  }

  private get(id: number): WatchlistRow | null {
    return (
      this.db.query<WatchlistRow, [number]>('SELECT * FROM watchlist WHERE id = ?').get(id) ?? null
    );
  }

  /** One poll pass over every `watching` row. Public so tests can drive it. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    // Respect the acquisition-plugin toggle — no auto-downloads when disabled.
    if (!this.isAcquisitionEnabled()) return;
    this.sweeping = true;
    try {
      const rows = this.db
        .query<WatchlistRow, []>(`SELECT * FROM watchlist WHERE state = 'watching'`)
        .all();
      for (const row of rows) {
        await this.tryAcquire(row);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async tryAcquire(row: WatchlistRow): Promise<void> {
    try {
      const albumId = await this.resolveAlbumId(row);
      if (albumId === null) {
        this.touch(row.id);
        return;
      }

      // Delegate the acquire to the shared core (the same primitives the
      // interactive hunt and the Lidarr auto-acquire loop use), then map its
      // outcome to this row's state transitions.
      const outcome = await acquireAlbum(
        { db: this.db, hunter: this.hunter, lidarr: this.lidarr, slskdRef: this.slskdRef },
        {
          lidarrAlbumId: albumId,
          artistName: row.artist_name,
          albumTitle: row.album_title,
          minMatchPct: this.minMatchPct,
        },
      );

      switch (outcome) {
        case 'enqueued':
        case 'already-complete':
        case 'in-flight':
          this.markAcquired(row.id);
          break;
        case 'enqueue-failed':
          this.fail(row.id, 'Enqueue failed');
          break;
        case 'no-candidate':
        case 'slskd-unavailable':
          // Nothing good enough (or slskd down) yet — try again next sweep.
          this.touch(row.id);
          break;
      }
    } catch (err) {
      this.touch(row.id, err instanceof Error ? err.message : String(err));
      log.debug({ id: row.id, err }, 'Watchlist acquire attempt failed; will retry');
    }
  }

  /** Resolve (and cache) the Lidarr album id for a row, or null if not resolvable. */
  private async resolveAlbumId(row: WatchlistRow): Promise<number | null> {
    if (row.lidarr_album_id) return row.lidarr_album_id;
    if (!row.foreign_album_id || !row.artist_mbid) return null;
    const resolved = await this.catalog.resolveAlbum({
      foreignAlbumId: row.foreign_album_id,
      artistMbid: row.artist_mbid,
      artistName: row.artist_name,
      albumTitle: row.album_title,
    });
    this.db.run('UPDATE watchlist SET lidarr_album_id = ? WHERE id = ?', [
      resolved.lidarrAlbumId,
      row.id,
    ]);
    return resolved.lidarrAlbumId;
  }

  private markAcquired(id: number): void {
    this.db.run(
      `UPDATE watchlist SET state = 'acquired', last_checked_at = ?, last_error = NULL WHERE id = ?`,
      [Date.now(), id],
    );
  }

  private touch(id: number, error?: string): void {
    this.db.run('UPDATE watchlist SET last_checked_at = ?, last_error = ? WHERE id = ?', [
      Date.now(),
      error ?? null,
      id,
    ]);
  }

  private fail(id: number, error: string): void {
    this.db.run(
      `UPDATE watchlist SET state = 'failed', last_checked_at = ?, last_error = ? WHERE id = ?`,
      [Date.now(), error, id],
    );
  }
}
