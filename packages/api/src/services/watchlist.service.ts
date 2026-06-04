import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { SlskdRef } from '../index.js';
import type { CatalogService } from './catalog-search.service.js';
import type { AlbumHunterService, FolderCandidate } from './album-hunter.service.js';
import { AlbumFallbackService } from './album-fallback.service.js';
import { albumAlreadyComplete, filesMissingOnDisk } from './library-completeness.js';

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

      const tracks = await this.lidarr.track.listByAlbum(albumId);

      // Already on disk (any edition) → done, no download.
      if (albumAlreadyComplete(this.db, row.artist_name, row.album_title, tracks.length || 1)) {
        this.markAcquired(row.id);
        return;
      }

      // A download for this album is already in flight (e.g. user hunted it
      // manually) → consider it handled; don't enqueue a duplicate.
      const active = this.db
        .query<
          { id: number },
          [number]
        >(`SELECT id FROM album_jobs WHERE lidarr_album_id = ? AND state = 'active' LIMIT 1`)
        .get(albumId);
      if (active) {
        this.markAcquired(row.id);
        return;
      }

      const slskd = this.slskdRef.current;
      if (!slskd) {
        this.touch(row.id);
        return;
      }

      const candidates = await this.hunter.hunt(row.artist_name, row.album_title, tracks, {
        skewSearch: true,
      });
      // Candidates are ranked best-first; take the top one clearing the unattended
      // confidence threshold. Nothing good enough yet → try again next sweep.
      const best = candidates.find((c) => c.matchPct >= this.minMatchPct);
      if (!best) {
        this.touch(row.id);
        return;
      }

      // Complete-only: enqueue only tracks not already on disk (see
      // filesMissingOnDisk) so a partially-present watched album fills in cleanly
      // instead of re-downloading duplicate versions of tracks we already have.
      const filesToDownload = filesMissingOnDisk(
        this.db,
        row.artist_name,
        row.album_title,
        best.files,
      );
      if (filesToDownload.length === 0) {
        // The chosen folder's tracks are all on disk already — treat as acquired.
        this.markAcquired(row.id);
        return;
      }

      try {
        await slskd.transfers.enqueue(best.username, filesToDownload);
      } catch (err) {
        this.fail(row.id, `Enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const toFiles = (c: FolderCandidate) =>
        c.files.map((f) => ({ filename: f.filename, size: f.size }));
      const alternates = candidates
        .filter((c) => c !== best)
        .map((c) => ({ username: c.username, directory: c.directory, files: toFiles(c) }));
      try {
        AlbumFallbackService.recordJob(this.db, {
          lidarrAlbumId: albumId,
          username: best.username,
          directory: best.directory,
          artistName: row.artist_name,
          albumTitle: row.album_title,
          canonicalTracks: tracks.map((t) => t.title),
          targetFiles: filesToDownload,
          alternates,
        });
      } catch (err) {
        log.warn({ id: row.id, err }, 'Failed to record album job for watchlist acquisition');
      }

      this.markAcquired(row.id);
      log.info(
        { id: row.id, album: row.album_title, from: best.username, matchPct: best.matchPct },
        'Watchlist: auto-acquired album',
      );
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
