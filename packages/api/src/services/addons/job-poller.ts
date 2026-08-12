import type { Database } from 'bun:sqlite';
import { mkdirSync, createWriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger, type AddonJob, type AddonJobItem } from '@nicotind/core';
import type { PluginRegistry } from '../plugins/registry.js';
import type { CompletedDownloadFile } from '../path-inference.js';
import { RemoteAddonPlugin } from './remote-addon-plugin.js';
import { recordAcquisition } from '../acquisition-store.js';
import {
  createJob,
  markItemsScanned,
  recomputeStage,
  type AcquisitionJobKind,
  type TransferJobMeta,
} from '../acquisition-job-store.js';

const log = createLogger('addon-job-poller');

export interface AddonJobPollerDeps {
  db: Database;
  registry: PluginRegistry;
  /** Private landing area for fetched files (outside musicDir — not indexed). */
  incomingDir: string;
  organizer: { organizeBatch: (files: CompletedDownloadFile[]) => Promise<unknown> };
  scan?: (relPaths: string[]) => Promise<void> | void;
  intervalMs?: number;
  /** Deployment-wide acquisition kill-switch (#235) — ticks no-op when off. */
  isEnabled?: () => boolean;
}

/** Mirror key for an addon item in `acquisition_job_items.transfer_key`. */
export function addonTransferKey(addonId: string, itemId: string): string {
  return `addon:${addonId}:${itemId}`;
}

/**
 * Pre-map an addon job to a core acquisition job (acquireAlbum creates the
 * feed row with hunt metadata; the poller then mirrors items into it instead
 * of minting a bare row).
 */
export function mapAddonJob(
  db: Database,
  addonId: string,
  addonJobId: string,
  coreJobId: string,
): void {
  db.run(
    `INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
    [`addon-poller:${addonId}`, `jobmap:${addonJobId}`, coreJobId],
  );
}

const KIND_BY_INTENT: Record<string, AcquisitionJobKind> = {
  album: 'album-hunt',
  tracks: 'track-search',
  'browse-grab': 'direct',
};

/**
 * The host half of the protocol's job loop (docs/acquisition-addon-protocol.md):
 * polls every enabled remote addon's `GET jobs?since=`, mirrors jobs + items
 * into `acquisition_jobs`/`acquisition_job_items` (keyed `addon:<id>:<itemId>`
 * — stable across fallback repoints, so a repoint is just an upsert with new
 * peer coordinates), fetches fileReady items over HTTP into a private incoming
 * dir, and hands them to the same organize → scan pipeline slskd completions
 * use. Feed continuity is the point: the Downloads UI reads the same tables.
 */
export class AddonJobPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private deps: AddonJobPollerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 5_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll+ingest pass across every enabled remote addon (public for tests). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    if (this.deps.isEnabled && !this.deps.isEnabled()) return;
    this.ticking = true;
    try {
      for (const plugin of this.deps.registry.getEnabled('acquisition')) {
        if (!(plugin instanceof RemoteAddonPlugin)) continue;
        await this.pollAddon(plugin).catch((err) => {
          log.debug({ addon: plugin.manifest.id, err }, 'addon poll failed');
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async pollAddon(plugin: RemoteAddonPlugin): Promise<void> {
    const { db } = this.deps;
    const addonId = plugin.manifest.id;
    const cursor = Number(this.kvGet(addonId, 'poll_cursor') ?? '0') || undefined;
    const jobs = await plugin.client.listJobs(cursor);
    let maxUpdated = cursor ?? 0;

    for (const job of jobs) {
      maxUpdated = Math.max(maxUpdated, job.updatedAt);
      const coreJobId = this.ensureCoreJob(addonId, job);
      this.mirrorItems(addonId, coreJobId, job);
      recomputeStage(db, coreJobId);
      await this.ingestReadyItems(plugin, coreJobId, job);
      await this.maybeReleaseAddonJob(plugin, coreJobId, job);
    }

    if (maxUpdated > (cursor ?? 0)) this.kvSet(addonId, 'poll_cursor', String(maxUpdated));
  }

  /** The core acquisition_jobs row mirroring an addon job (created on first sight). */
  private ensureCoreJob(addonId: string, job: AddonJob): string {
    const mapped = this.kvGet(addonId, `jobmap:${job.id}`);
    if (mapped) return mapped;
    const coreJobId = createJob(this.deps.db, {
      kind: KIND_BY_INTENT[job.intent] ?? 'direct',
      method: addonId,
      artistName: job.artist,
      albumTitle: job.album,
      sourceRef: `addon:${addonId}:${job.id}`,
      files: [],
    });
    this.kvSet(addonId, `jobmap:${job.id}`, coreJobId);
    log.info({ addonId, addonJob: job.id, coreJobId }, 'mirroring addon job into the feed');
    return coreJobId;
  }

  /**
   * Upsert items by mirror key. Post-ingest states (`organized`/`scanned`) are
   * never overwritten — the addon's view stops at `completed`.
   */
  private mirrorItems(addonId: string, coreJobId: string, job: AddonJob): void {
    const { db } = this.deps;
    const now = Date.now();
    for (const item of job.items) {
      const key = addonTransferKey(addonId, item.itemId);
      const state = mapItemState(item);
      const existing = db
        .query<{ id: number; state: string }, [string, string]>(
          `SELECT id, state FROM acquisition_job_items WHERE job_id = ? AND transfer_key = ?`,
        )
        .get(coreJobId, key);
      if (!existing) {
        db.run(
          `INSERT INTO acquisition_job_items
             (job_id, track_title, username, filename, transfer_key, bit_rate_kbps, audio_format, state, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            coreJobId,
            item.title,
            item.username,
            item.filename,
            key,
            item.bitRateKbps ?? null,
            item.audioFormat ?? null,
            state,
            now,
          ],
        );
        continue;
      }
      if (existing.state === 'organized' || existing.state === 'scanned') continue;
      db.run(
        `UPDATE acquisition_job_items
         SET track_title = ?, username = ?, filename = ?, bit_rate_kbps = ?, audio_format = ?, state = ?, updated_at = ?
         WHERE id = ?`,
        [
          item.title,
          item.username,
          item.filename,
          item.bitRateKbps ?? null,
          item.audioFormat ?? null,
          state,
          now,
          existing.id,
        ],
      );
    }
  }

  /** Fetch fileReady completions we haven't ingested yet into the pipeline. */
  private async ingestReadyItems(
    plugin: RemoteAddonPlugin,
    coreJobId: string,
    job: AddonJob,
  ): Promise<void> {
    const { db } = this.deps;
    const addonId = plugin.manifest.id;
    const batch: CompletedDownloadFile[] = [];
    const keys: string[] = [];

    for (const item of job.items) {
      if (!(item.state === 'completed' && item.fileReady)) continue;
      const key = addonTransferKey(addonId, item.itemId);
      const row = db
        .query<{ id: number; state: string; relative_path: string | null }, [string, string]>(
          `SELECT id, state, relative_path FROM acquisition_job_items WHERE job_id = ? AND transfer_key = ?`,
        )
        .get(coreJobId, key);
      if (!row || row.state !== 'completed' || row.relative_path) continue;

      try {
        const localPath = await this.fetchToIncoming(plugin, job, item);
        batch.push({
          username: item.username,
          directory: peerDirOf(item.filename) || `${job.artist ?? 'Unknown'} - ${job.album ?? ''}`,
          filename: localPath, // absolute → organizer's locateOnDisk fast path
          relativePath: null,
          directoryFileCount: job.items.length,
          jobMeta: this.jobMeta(coreJobId),
        });
        keys.push(key);
      } catch (err) {
        log.warn({ addonId, item: item.itemId, err }, 'file fetch from addon failed');
      }
    }

    if (!batch.length) return;
    try {
      await this.deps.organizer.organizeBatch(batch);
    } catch (err) {
      log.warn({ addonId, err }, 'organize step failed for addon batch');
    }

    const acquiredAt = Date.now();
    const relPaths: string[] = [];
    for (const [i, file] of batch.entries()) {
      if (!file.relativePath) continue; // organizer mutates on success
      relPaths.push(file.relativePath);
      this.deps.db.run(
        `UPDATE acquisition_job_items SET state = 'organized', relative_path = ?, updated_at = ?
         WHERE job_id = ? AND transfer_key = ?`,
        [file.relativePath, acquiredAt, coreJobId, keys[i]!],
      );
      recordAcquisition(db, {
        relativePath: file.relativePath,
        method: addonId,
        sourceRef: file.username,
        stage: 'done',
        startedAt: acquiredAt,
        completedAt: acquiredAt,
      });
    }

    if (relPaths.length && this.deps.scan) {
      try {
        await this.deps.scan(relPaths);
        const pathToSongId = new Map<string, string>();
        for (const relPath of relPaths) {
          const row = db
            .query<{ id: string }, [string]>('SELECT id FROM library_songs WHERE path = ?')
            .get(relPath);
          if (row) pathToSongId.set(relPath, row.id);
        }
        if (pathToSongId.size) markItemsScanned(db, pathToSongId);
      } catch (err) {
        log.warn({ addonId, err }, 'scan step failed for addon batch');
      }
    }
    recomputeStage(db, coreJobId);
  }

  /** Delete a fully-ingested terminal job addon-side (the 7-day janitor is the backstop). */
  private async maybeReleaseAddonJob(
    plugin: RemoteAddonPlugin,
    coreJobId: string,
    job: AddonJob,
  ): Promise<void> {
    if (job.state === 'active') return;
    const pending = this.deps.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM acquisition_job_items
         WHERE job_id = ? AND state = 'completed' AND relative_path IS NULL`,
      )
      .get(coreJobId);
    if ((pending?.n ?? 0) > 0) return;
    try {
      await plugin.client.deleteJob(job.id);
      this.kvSet(plugin.manifest.id, `released:${job.id}`, '1');
    } catch {
      // The addon janitor mops up eventually.
    }
  }

  private async fetchToIncoming(
    plugin: RemoteAddonPlugin,
    job: AddonJob,
    item: AddonJobItem,
  ): Promise<string> {
    const dir = join(this.deps.incomingDir, plugin.manifest.id, job.id);
    mkdirSync(dir, { recursive: true });
    const local = join(dir, basename(item.filename.replace(/\\/g, '/')));
    const res = await plugin.client.fetchFile(job.id, item.itemId);
    if (!res.body) throw new Error('empty file response');
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(local));
    return local;
  }

  private jobMeta(coreJobId: string): TransferJobMeta | null {
    const row = this.deps.db
      .query<
        {
          id: string;
          kind: AcquisitionJobKind;
          artist_name: string | null;
          album_title: string | null;
          lidarr_album_id: number | null;
          genres_json: string | null;
          year: number | null;
          canonical_tracks_json: string | null;
        },
        [string]
      >(`SELECT * FROM acquisition_jobs WHERE id = ?`)
      .get(coreJobId);
    if (!row) return null;
    return {
      jobId: row.id,
      kind: row.kind,
      artistName: row.artist_name,
      albumTitle: row.album_title,
      lidarrAlbumId: row.lidarr_album_id,
      genres: row.genres_json ? (JSON.parse(row.genres_json) as string[]) : null,
      year: row.year,
      canonicalTracks: row.canonical_tracks_json
        ? (JSON.parse(row.canonical_tracks_json) as string[])
        : null,
    };
  }

  private kvGet(addonId: string, key: string): string | null {
    const row = this.deps.db
      .query<{ value: string }, [string, string]>(
        `SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?`,
      )
      .get(`addon-poller:${addonId}`, key);
    return row?.value ?? null;
  }

  private kvSet(addonId: string, key: string, value: string): void {
    this.deps.db.run(
      `INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
      [`addon-poller:${addonId}`, key, value],
    );
  }
}

function mapItemState(item: AddonJobItem): string {
  switch (item.state) {
    case 'queued':
    case 'downloading':
      return 'downloading';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'unavailable':
      return 'unavailable';
  }
}

function peerDirOf(filename: string): string {
  const normalized = filename.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx > 0 ? normalized.slice(0, idx) : '';
}
