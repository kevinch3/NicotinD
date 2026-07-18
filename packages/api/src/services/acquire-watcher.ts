import { rmSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { classifyAcquireUrl, createLogger } from '@nicotind/core';
import type { AcquireJob, AcquisitionMethod, Plugin } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { PluginRegistry } from './plugins/registry.js';
import { pluginStagingDir } from './plugins/host-context.js';
import type { CompletedDownloadFile } from './path-inference.js';
import { createJob, type TransferJobMeta } from './acquisition-job-store.js';
import { recordAcquisition } from './acquisition-store.js';
import { deriveAcquireAlbum, type AcquireAlbumDestination } from './acquire-album.js';
import { PlaylistService } from './playlist.service.js';
import {
  resolveAcquireJobTracks,
  type AcquireJobTrackRow,
} from './acquire-playlist.js';

/** Map an acquisition plugin id to an AcquisitionMethod; unknown ids → 'unknown'. */
function methodForBackend(backend: string): AcquisitionMethod {
  return backend === 'ytdlp' || backend === 'spotdl' || backend === 'archive'
    ? backend
    : 'unknown';
}

const log = createLogger('acquire-watcher');

export class NoAcquisitionPluginError extends Error {
  constructor(url: string) {
    super(`No enabled acquisition plugin can handle "${url}"`);
    this.name = 'NoAcquisitionPluginError';
  }
}

export class PluginUnavailableError extends Error {
  constructor(pluginId: string) {
    super(`Acquisition plugin "${pluginId}" is enabled but not available (binary missing?)`);
    this.name = 'PluginUnavailableError';
  }
}

export interface AcquireWatcherOptions {
  db: Database;
  /** Expanded (no `~`) data dir — staging lives under it. */
  dataDir: string;
  /** Resolves which enabled plugin handles a URL + drives its resolve capability. */
  registry: PluginRegistry;
  /** organizeBatch mutates file.relativePath in-place to the post-move path. */
  organizeBatch: (files: CompletedDownloadFile[]) => Promise<unknown>;
  scanIncremental: (relPaths: string[]) => Promise<void>;
  /**
   * Optional best-effort enrichment of loose singles/EPs (Lidarr/MusicBrainz
   * release type + artwork) run after the incremental scan, then a reclassify.
   */
  enrichSingles?: (relPaths: string[]) => Promise<void>;
}

export type { AcquireJob } from '@nicotind/core';

export interface AcquireJobSubmitOptions {
  /** Optional user id of the submitter — required when the URL is a playlist. */
  userId?: string;
  /**
   * Override the URL classifier. Only honored for archive.org items (which
   * don't expose a playlist signal at the URL level); other sources use the
   * classifier's verdict directly. `'album'` forces the legacy single-item
   * acquire flow even for archive items the user would have liked as a
   * playlist.
   */
  as?: 'playlist' | 'album';
}

interface AcquireJobRow {
  id: string;
  backend: string;
  url: string;
  label: string | null;
  state: string;
  stage: string | null;
  storage_path: string | null;
  dest_albums_json: string | null;
  progress: string | null;
  tracks_json: string | null;
  is_playlist: number | null;
  playlist_id: string | null;
  error: string | null;
  created_at: number;
}

/**
 * Host-side driver for URL-based acquisition. It owns the `acquire_jobs` records
 * and the post-download ingest (organize → scan → enrich); the actual download
 * is delegated to whichever enabled `resolve`-capable plugin handles the URL
 * (`registry.getEnabledForUrl`). The plugin stages files + emits progress; this
 * class never knows about yt-dlp/spotdl specifics.
 */
export class AcquireWatcher {
  private db: Database;
  /** jobId → the plugin running it, for cancel. */
  private active = new Map<string, Plugin>();

  constructor(private options: AcquireWatcherOptions) {
    this.db = options.db;
    // Jobs left 'queued'/'running' by a previous process are orphans — their
    // downloader child process died with the server, so nothing will ever
    // advance them. Without this they sit as stuck-forever "running" rows in
    // the Downloads feed after every restart/redeploy.
    this.db.run(
      `UPDATE acquisition_jobs SET state = 'failed', stage = 'error', updated_at = unixepoch() * 1000
       WHERE kind = 'url' AND state = 'active'
         AND id IN (SELECT id FROM acquire_jobs WHERE state IN ('queued', 'running'))`,
    );
    this.db.run(
      `UPDATE acquire_jobs SET state = 'failed', stage = 'error',
         error = 'Interrupted by a server restart — use Retry to run it again'
       WHERE state IN ('queued', 'running')`,
    );
    // Prune done/failed jobs older than 7 days so the list stays bounded, and
    // sweep their staging dirs too — they now survive failed jobs (see run()),
    // so nothing else will ever clean them up once the row is gone.
    const stale = this.db
      .query<
        { id: string; backend: string },
        []
      >(`SELECT id, backend FROM acquire_jobs WHERE state IN ('done', 'failed') AND created_at < unixepoch() - 604800`)
      .all();
    this.db.run(
      `DELETE FROM acquire_jobs WHERE state IN ('done', 'failed') AND created_at < unixepoch() - 604800`,
    );
    for (const row of stale) {
      this.cleanupStaging(pluginStagingDir(this.options.dataDir, row.backend, row.id));
    }
  }

  /** Plugin that would handle this URL right now (enabled + canHandle), if any. */
  pluginForUrl(url: string): Plugin | undefined {
    return this.options.registry.getEnabledForUrl(url);
  }

  /**
   * Create + start an acquire job. Throws `NoAcquisitionPluginError` when no
   * enabled plugin handles the URL, or `PluginUnavailableError` when the chosen
   * plugin's binary is missing.
   *
   * `opts.userId` is the submitter — required for playlist generation to fire
   * (the generated playlist is owned by this user). `opts.as` lets archive.org
   * callers force `playlist` since the URL pattern doesn't carry that signal.
   */
  async submit(url: string, label?: string, opts: AcquireJobSubmitOptions = {}): Promise<string> {
    // Idempotency guard mirroring the slskd hunt path's "one album = one
    // download": without this, every re-paste/re-click of a URL whose job is
    // still in flight queues a brand-new row, so the list grows unbounded for
    // the same link instead of just tracking the one job already working on it.
    const existing = this.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM acquire_jobs WHERE url = ? AND state IN ('queued', 'running') LIMIT 1`,
      )
      .get(url);
    if (existing) return existing.id;

    const plugin = this.pluginForUrl(url);
    if (!plugin?.resolve) throw new NoAcquisitionPluginError(url);
    if (!(await plugin.isAvailable())) throw new PluginUnavailableError(plugin.manifest.id);

    // Classifier-driven playlist flag. Spotify / YouTube playlist URLs
    // auto-detect. Archive items default to 'album' (the submitter can opt
    // into 'playlist' via the link-intent toggle on the web); the `as`
    // override is honored for archive items AND for any URL the classifier
    // doesn't recognize (a custom share link the user knows is a playlist).
    // `as: 'album'` explicitly downgrades a Spotify/YouTube playlist URL
    // to a single-item acquire — edge case, but consistent.
    const cls = classifyAcquireUrl(url);
    let isPlaylist = cls.kind === 'playlist';
    if (cls.kind !== 'playlist' && opts.as === 'playlist') isPlaylist = true;
    if (cls.kind === 'playlist' && opts.as === 'album') isPlaylist = false;
    if (isPlaylist && !opts.userId) {
      // Server-side guard: a playlist URL without a submitter can't be owned.
      // The web always sends userId (it's the auth subject); this branch
      // catches direct / scripted callers that forgot the field.
      log.warn({ url }, 'Playlist URL submitted without a userId; skipping playlist generation');
      isPlaylist = false;
    }

    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, label, state, stage, is_playlist)
       VALUES (?, ?, ?, ?, 'queued', 'queued', ?)`,
      [id, plugin.manifest.id, url, label ?? null, isPlaylist ? 1 : 0],
    );
    // Mirror into the unified acquisition_jobs table (same uuid; acquire_jobs
    // stays authoritative for the URL engine). Best-effort.
    try {
      createJob(this.db, {
        id,
        kind: 'url',
        method: plugin.manifest.id,
        albumTitle: label ?? null,
        sourceRef: url,
      });
      this.db.run(`UPDATE acquisition_jobs SET stage = 'queued' WHERE id = ?`, [id]);
    } catch (err) {
      log.warn({ id, err }, 'Failed to mirror acquire job into acquisition_jobs');
    }

    void this.run(plugin, id, url, opts.userId);
    return id;
  }

  private async run(
    plugin: Plugin,
    id: string,
    url: string,
    userId: string | undefined,
  ): Promise<void> {
    this.active.set(id, plugin);
    this.updateState(id, 'running');
    this.setStage(id, 'downloading');
    log.info({ id, plugin: plugin.manifest.id, url }, 'Starting acquire job');
    try {
      // A plugin may return bare paths (files carry embedded tags) or a
      // { paths, meta } result (source knows the canonical artist/album but the
      // staged files are untagged, e.g. archive.org). Normalize both here.
      const resolved = await plugin.resolve!.resolve(url, id);
      const paths = Array.isArray(resolved) ? resolved : resolved.paths;
      const resolveMeta = Array.isArray(resolved) ? undefined : resolved.meta;
      // With --ignore-errors a partly-unavailable playlist still resolves; only
      // a download that produced nothing at all is a real failure.
      if (paths.length === 0) {
        this.updateState(id, 'failed', 'Download produced no audio files');
        this.setStage(id, 'error');
        return;
      }
      // The plugin's return value only carries the files that landed, not the
      // total the source reported (e.g. spotdl's "Found 16 songs"). Compare
      // against the last progress the plugin emitted so a truncated result
      // (1 of 16) still surfaces a warning instead of silently reading as a
      // full success — this is what was landing as an unexplained "Done".
      const progress = this.getProgress(id);
      const partialWarning =
        progress && progress.total > paths.length
          ? `Downloaded ${paths.length} of ${progress.total} tracks — the rest failed or were skipped.`
          : undefined;
      // Keep state='running' through ingest — only mark done once the full
      // pipeline (organize → scan → enrich) completes.
      await this.ingest(id, plugin.manifest.id, url, paths, partialWarning, resolveMeta, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ id, err: msg }, 'Acquire job failed');
      this.updateState(id, 'failed', msg);
      this.setStage(id, 'error');
    } finally {
      this.active.delete(id);
    }
  }

  private async ingest(
    id: string,
    pluginId: string,
    url: string,
    paths: string[],
    partialWarning: string | undefined,
    resolveMeta: { artist?: string | null; album?: string | null } | undefined,
    userId: string | undefined,
  ): Promise<void> {
    if (paths.length === 0) {
      log.warn({ id }, 'Acquire job produced no audio files');
      return;
    }
    const stagingDir = pluginStagingDir(this.options.dataDir, pluginId, id);
    // Sources whose staged files carry no embedded tags (archive.org) hand us
    // the canonical artist/album via `resolveMeta`; pass it to the organizer as
    // jobMeta so it files them into <musicDir>/<artist>/<album> instead of the
    // unsorted bucket (applyJobCanonicalName in library-organizer.ts). Tagged
    // sources (yt-dlp/spotdl) send no meta and keep tag-based filing.
    const jobMeta: TransferJobMeta | null =
      resolveMeta && (resolveMeta.artist || resolveMeta.album)
        ? {
            jobId: id,
            kind: 'url',
            artistName: resolveMeta.artist ?? null,
            albumTitle: resolveMeta.album ?? null,
            lidarrAlbumId: null,
            genres: null,
            year: null,
            canonicalTracks: null,
          }
        : null;
    // Map staged absolute paths to the organizer's contract: `directory` is the
    // path relative to the job staging dir so LibraryOrganizer can infer
    // artist/album from the downloader's output template.
    const files: CompletedDownloadFile[] = paths.map((p) => ({
      username: `acquire:${id}`,
      directory: relative(stagingDir, dirname(p)) || '.',
      filename: p,
      jobMeta,
    }));
    try {
      this.setStage(id, 'organizing');
      await this.options.organizeBatch(files);
      const relPaths = files.map((f) => f.relativePath).filter((p): p is string => Boolean(p));
      // Record acquisition provenance + the landing dir, keyed on the final path.
      const acquiredAt = Date.now();
      const method = methodForBackend(pluginId);
      for (const relPath of relPaths) {
        recordAcquisition(this.db, {
          relativePath: relPath,
          method,
          sourceRef: url,
          stage: 'done',
          startedAt: acquiredAt,
          completedAt: acquiredAt,
        });
      }
      if (relPaths.length > 0) {
        this.setStoragePath(id, dirname(relPaths[0]!));
        // Distinct destination albums across every file the job landed, not
        // just the first — a job (e.g. a large spotdl playlist) can span many
        // albums, and only tracking the first meant every other album's
        // "Open in Library" link silently pointed at the wrong place.
        const destDirs = [...new Set(relPaths.map((p) => dirname(p)))];
        const destAlbums = destDirs
          .map((dir) => deriveAcquireAlbum(dir))
          .filter((d): d is AcquireAlbumDestination => d !== null);
        this.setDestAlbums(id, destAlbums);
        this.setStage(id, 'scanning');
        await this.options.scanIncremental(relPaths);
        if (this.options.enrichSingles) await this.options.enrichSingles(relPaths);
      }
      this.setStage(id, 'done');
      // Files were downloaded (paths.length > 0) but none were filed into the
      // library (all landed in the unsorted bucket for lack of artist/album
      // metadata, or were dup-skipped). Without this the job reads as a clean
      // green "Done" while nothing actually reached the library — the exact
      // "succeeds but vanishes" report. Surface it instead of swallowing it.
      const unfiledWarning =
        relPaths.length === 0
          ? 'Downloaded, but no tracks were added to your library — they may already exist or lack the artist/album metadata needed to file them.'
          : undefined;
      // A partial-download warning rides in the (state='done') job's `error`
      // field — it's still a success worth keeping (files did land), but the
      // user needs to see *why* the track count is short instead of it
      // reading as a clean, unqualified "Done".
      this.updateState(id, 'done', partialWarning ?? unfiledWarning);
      // Only a fully-succeeded job's staging dir is disposable — a failed one
      // is left in place so Retry can resume it (see retryJob()).
      this.cleanupStaging(stagingDir);
      // Playlist generation: a successful playlist-classified job materializes
      // a per-user native playlist from the `acquire_job_tracks` rows in
      // download order. Runs after the scan so `acquisitions`/`library_songs`
      // joins can resolve every emitted track. Failures here never break the
      // job — the files are already in the library.
      if (this.getIsPlaylist(id) && userId) {
        try {
          await this.materializePlaylist(id, url, userId);
        } catch (err) {
          log.warn({ id, err }, 'Playlist materialization failed (job still succeeded)');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ id, err: msg }, 'Organize/scan after acquire failed');
      this.setStage(id, 'error');
      this.updateState(id, 'failed', msg);
    }
  }

  /**
   * Build the per-user native playlist for a playlist-classified job. Reads
   * `acquire_job_tracks` in position order, joins each entry against the
   * post-scan library via `acquisitions` (so only landed tracks make it in),
   * and persists the result. The job's `playlist_id` column carries the new
   * playlist id so the Downloads card can deep-link straight to it.
   */
  private async materializePlaylist(jobId: string, jobUrl: string, userId: string): Promise<void> {
    const rows = this.db
      .query<AcquireJobTrackRow, [string]>(
        `SELECT position, title, status, path FROM acquire_job_tracks WHERE job_id = ? ORDER BY position ASC`,
      )
      .all(jobId);
    const songIds = resolveAcquireJobTracks(this.db, jobId, jobUrl, rows);
    if (songIds.length === 0) {
      log.info({ jobId }, 'No landed tracks — skipping playlist materialization');
      return;
    }
    const labelRow = this.db
      .query<{ label: string | null }, [string]>(`SELECT label FROM acquire_jobs WHERE id = ?`)
      .get(jobId);
    const name = labelRow?.label?.trim() || 'Imported playlist';
    const playlist = new PlaylistService(this.db).create(userId, { name, songIds });
    this.db.run(`UPDATE acquire_jobs SET playlist_id = ? WHERE id = ?`, [playlist.id, jobId]);
    log.info(
      { jobId, playlistId: playlist.id, songs: songIds.length },
      'Generated playlist from acquire job',
    );
  }

  private getIsPlaylist(jobId: string): boolean {
    const row = this.db
      .query<{ is_playlist: number | null }, [string]>(
        `SELECT is_playlist FROM acquire_jobs WHERE id = ?`,
      )
      .get(jobId);
    return Boolean(row?.is_playlist);
  }

  cancel(jobId: string): boolean {
    const plugin = this.active.get(jobId);
    return plugin?.resolve?.cancel?.(jobId) ?? false;
  }

  /** Best-effort staging-dir removal; safe to call on a path that no longer exists. */
  private cleanupStaging(stagingDir: string): void {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Non-fatal; nothing downstream depends on staging dirs being gone.
    }
  }

  /** Remove a done or failed job from the DB (and its staging dir, if any). */
  deleteJob(jobId: string): boolean {
    const row = this.db
      .query<{ backend: string }, [string]>(
        `SELECT backend FROM acquire_jobs WHERE id = ? AND state IN ('done', 'failed')`,
      )
      .get(jobId);
    if (!row) return false;
    this.db.run(`DELETE FROM acquire_jobs WHERE id = ?`, [jobId]);
    this.cleanupStaging(pluginStagingDir(this.options.dataDir, row.backend, jobId));
    return true;
  }

  /**
   * Resume a failed (or done) job in place — same job id, same staging dir.
   * A truncated spotdl run (server restart, crash, etc.) leaves its
   * downloaded files under that staging dir (Task 1); reusing the id means
   * the plugin resolves into the same directory and can pick up where it
   * left off instead of re-downloading everything.
   */
  async retryJob(jobId: string, opts: AcquireJobSubmitOptions = {}): Promise<string | null> {
    const row = this.db
      .query<AcquireJobRow, [string]>(`SELECT * FROM acquire_jobs WHERE id = ?`)
      .get(jobId);
    if (!row) return null;
    // Already in flight — don't double-start (mirrors submit()'s dedupe guard).
    if (row.state === 'queued' || row.state === 'running') return jobId;
    const plugin = this.pluginForUrl(row.url);
    if (!plugin?.resolve) throw new NoAcquisitionPluginError(row.url);
    if (!(await plugin.isAvailable())) throw new PluginUnavailableError(plugin.manifest.id);
    this.db.run(
      `UPDATE acquire_jobs SET backend = ?, state = 'queued', stage = 'queued', error = NULL, progress = NULL, storage_path = NULL, dest_albums_json = NULL WHERE id = ?`,
      [plugin.manifest.id, jobId],
    );
    // Retry reuses the existing userId when the original submitter is still
    // known — the playlist (if any) was owned by that user, and we want
    // ownership to stay consistent across retries. Falls back to a fresh
    // submitter id when the caller didn't pass one (e.g. a CLI retry that
    // forgot the field); the new playlist is then owned by that caller.
    void this.run(plugin, jobId, row.url, opts.userId);
    return jobId;
  }

  getJob(jobId: string): AcquireJob | null {
    const row = this.db
      .query<AcquireJobRow, [string]>(`SELECT * FROM acquire_jobs WHERE id = ?`)
      .get(jobId);
    return row ? this.mapRow(row) : null;
  }

  listJobs(limit = 50): AcquireJob[] {
    const rows = this.db
      .query<AcquireJobRow, [number]>(`SELECT * FROM acquire_jobs ORDER BY created_at DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => this.mapRow(r));
  }

  updateLabel(jobId: string, label: string): void {
    try {
      this.db.run(`UPDATE acquire_jobs SET label = ? WHERE id = ?`, [label, jobId]);
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs label');
    }
  }

  private updateState(jobId: string, state: string, error?: string): void {
    try {
      this.db.run(`UPDATE acquire_jobs SET state = ?, error = ? WHERE id = ?`, [
        state,
        error ?? null,
        jobId,
      ]);
      // Mirror into acquisition_jobs: the URL engine's queued/running collapse
      // to the unified 'active'.
      const mirrored = state === 'queued' || state === 'running' ? 'active' : state;
      this.db.run(
        `UPDATE acquisition_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?`,
        [mirrored, error ?? null, Date.now(), jobId],
      );
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs state');
    }
  }

  /** Set the fine-grained pipeline stage (queued → downloading → … → done/error). */
  private setStage(jobId: string, stage: string): void {
    try {
      this.db.run(`UPDATE acquire_jobs SET stage = ? WHERE id = ?`, [stage, jobId]);
      this.db.run(`UPDATE acquisition_jobs SET stage = ?, updated_at = ? WHERE id = ?`, [
        stage,
        Date.now(),
        jobId,
      ]);
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs stage');
    }
  }

  /** Read the last progress the plugin emitted for this job, if any. */
  private getProgress(jobId: string): { done: number; total: number } | null {
    const row = this.db
      .query<{ progress: string | null }, [string]>(
        `SELECT progress FROM acquire_jobs WHERE id = ?`,
      )
      .get(jobId);
    if (!row?.progress) return null;
    try {
      return JSON.parse(row.progress);
    } catch {
      return null;
    }
  }

  /** Record the canonical album dir the job's files landed in. */
  private setStoragePath(jobId: string, storagePath: string): void {
    try {
      this.db.run(`UPDATE acquire_jobs SET storage_path = ? WHERE id = ?`, [storagePath, jobId]);
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs storage_path');
    }
  }

  /** Record the distinct set of destination albums the job's files landed in. */
  private setDestAlbums(jobId: string, albums: AcquireAlbumDestination[]): void {
    try {
      this.db.run(`UPDATE acquire_jobs SET dest_albums_json = ? WHERE id = ?`, [
        JSON.stringify(albums),
        jobId,
      ]);
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs dest_albums_json');
    }
  }

  private mapRow(row: AcquireJobRow): AcquireJob {
    let progress: { done: number; total: number } | null = null;
    if (row.progress) {
      try {
        progress = JSON.parse(row.progress);
      } catch {
        /* ignore */
      }
    }
    let destinationAlbums: AcquireAlbumDestination[] = [];
    if (row.dest_albums_json) {
      try {
        destinationAlbums = JSON.parse(row.dest_albums_json);
      } catch {
        /* ignore */
      }
    }
    // Singular fields are the single-album convenience case; a multi-album job
    // (or a pre-migration/not-yet-ingested row with an empty set) degrades
    // safely to null here rather than pointing at a possibly-wrong album.
    const single = destinationAlbums.length === 1 ? destinationAlbums[0]! : null;
    let tracks: AcquireJob['tracks'] = [];
    if (row.tracks_json) {
      try {
        tracks = JSON.parse(row.tracks_json);
      } catch {
        /* ignore */
      }
    }
    return {
      id: row.id,
      backend: row.backend as AcquireJob['backend'],
      url: row.url,
      label: row.label,
      state: row.state as AcquireJob['state'],
      stage: (row.stage as AcquireJob['stage']) ?? null,
      storage_path: row.storage_path ?? null,
      albumId: single?.albumId ?? null,
      albumArtist: single?.albumArtist ?? null,
      albumTitle: single?.albumTitle ?? null,
      destinationAlbums,
      progress,
      tracks,
      isPlaylist: Boolean(row.is_playlist),
      playlistId: row.playlist_id ?? null,
      error: row.error,
      created_at: row.created_at,
    };
  }
}
