import type { Database } from 'bun:sqlite';
import { mkdirSync, createWriteStream, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AddonContractError, AddonRequestError } from './client.js';
import { MAX_ADDON_FILE_BYTES, safeIncomingPath } from './ingest-path.js';
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
import { materializeAddonPlaylist } from '../addon-playlist.js';
import { PlaylistService } from '../playlist.service.js';

const log = createLogger('addon-job-poller');

/**
 * How long an addon job may sit `active` (unchanged) before the poller re-checks
 * it via getJob. Comfortably longer than a normal single-track resolve so a
 * slow-but-live download is never re-checked needlessly; the getJob 404 — not
 * this timeout — is what actually fails an orphaned job.
 */
const ORPHAN_STALE_MS = 5 * 60_000;

/** Extract the addon-side job id from a `addon:<addonId>:<jobId>` source_ref. */
export function parseAddonJobId(sourceRef: string | null, addonId: string): string | null {
  const prefix = `addon:${addonId}:`;
  return sourceRef && sourceRef.startsWith(prefix) ? sourceRef.slice(prefix.length) : null;
}

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
  url: 'url',
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
  // Trivial to construct (wraps deps.db) — built here rather than threaded
  // through AddonJobPollerDeps so every existing/future construction site
  // doesn't need a new required dependency for the one lane that uses it.
  private readonly playlists: PlaylistService;

  constructor(private deps: AddonJobPollerDeps) {
    this.playlists = new PlaylistService(deps.db);
  }

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
    const handled = new Set<string>();

    for (const job of jobs) {
      maxUpdated = Math.max(maxUpdated, job.updatedAt);
      const coreJobId = this.ensureCoreJob(addonId, job);
      handled.add(coreJobId);
      this.updateJobMeta(coreJobId, job);
      this.mirrorItems(addonId, coreJobId, job);
      recomputeStage(db, coreJobId);
      await this.ingestReadyItems(plugin, coreJobId, job);
      // Ordering is load-bearing: AFTER ingest (so files delivered this tick
      // organize first and a finished job closes `done`, not a false partial)
      // and BEFORE the release, which deletes the addon-side job and with it
      // the only copy of `job.error`.
      this.applyAddonOutcome(coreJobId, job);
      // Playlist-from-acquisition on the addon lane (issue #587): once the
      // addon says the job is closed, any track that landed this tick or a
      // prior one already carries a song_id (ingestReadyItems ran above), so
      // there is nothing left to wait for. Safe to call every tick the job
      // stays closed-but-unreleased — it refreshes the same playlist in place
      // rather than duplicating (see addon-playlist.ts).
      if (job.state !== 'active') materializeAddonPlaylist(db, this.playlists, coreJobId);
      await this.maybeReleaseAddonJob(plugin, coreJobId, job);
    }

    if (maxUpdated > (cursor ?? 0)) this.kvSet(addonId, 'poll_cursor', String(maxUpdated));
    await this.ingestStrandedJobs(plugin, handled);
    await this.reconcileOrphanedJobs(plugin);
  }

  /**
   * Collect files from jobs the cursor has left behind.
   *
   * why: the poll is cursor-based, so a job that stops updating — every job
   * that reaches a terminal state — falls out of `listJobs` as soon as any
   * other job advances the cursor past it. Any file core had not fetched yet
   * goes with it: `ingestReadyItems` only ever runs for jobs the poll returns.
   * Nothing else picks them up, because the two components that could are both
   * behaving correctly — `maybeReleaseAddonJob` keeps the addon job alive
   * *because* those files are still needed, and `reconcileOrphanedJobs` fails
   * only jobs the addon 404s, which this one is not. The files then sit until
   * the 24h idle valve writes them off and the addon's janitor deletes them
   * (issue #725: 11 files measured stranded on prod).
   *
   * Keyed on items with outstanding ingest — never on the job row's
   * `updated_at`, which `recomputeStage` refreshes unconditionally, so a
   * stranded job reads as seconds-idle while its items are hours-idle.
   */
  private async ingestStrandedJobs(
    plugin: RemoteAddonPlugin,
    handledCoreIds: Set<string>,
  ): Promise<void> {
    const { db } = this.deps;
    const addonId = plugin.manifest.id;
    const rows = db
      .query<{ id: string; source_ref: string | null }, [string]>(
        `SELECT DISTINCT j.id, j.source_ref
           FROM acquisition_jobs j
           JOIN acquisition_job_items i ON i.job_id = j.id
          WHERE j.method = ? AND j.state = 'active'
            AND i.state = 'completed' AND i.relative_path IS NULL`,
      )
      .all(addonId);

    for (const row of rows) {
      if (handledCoreIds.has(row.id)) continue; // the poll above already ran it
      const addonJobId = parseAddonJobId(row.source_ref, addonId);
      if (!addonJobId) continue;
      let job: AddonJob;
      try {
        job = await plugin.client.getJob(addonJobId);
      } catch (err) {
        // A definitive 404 means the addon dropped the job and the files with
        // it; anything else is a blip worth retrying next tick.
        if (err instanceof AddonRequestError && err.status === 404) {
          this.failOrphanedJob(row.id, addonId);
        }
        continue;
      }
      log.info(
        { addonId, coreJobId: row.id, addonJobId },
        'ingesting a job the poll cursor moved past',
      );
      await this.ingestReadyItems(plugin, row.id, job);
      this.applyAddonOutcome(row.id, job);
      if (job.state !== 'active') materializeAddonPlaylist(db, this.playlists, row.id);
      await this.maybeReleaseAddonJob(plugin, row.id, job);
    }
  }

  /**
   * Fail active jobs the addon no longer knows about. An addon's job store may be
   * in-memory (the yt-dlp/spotdl addons are), so a restart mid-download drops the
   * job — but core's cursor-based poll only ever *updates* jobs the addon still
   * lists, so a dropped job sits "downloading" until the 24h idle valve. Here we
   * re-check each stale active job via getJob and fail the ones the addon 404s, so
   * a deploy/crash surfaces as a prompt failure instead of a ghost card. The
   * staleness gate leaves a genuinely slow-but-live job (getJob returns it)
   * untouched — only an addon-forgotten job (404) is failed.
   */
  private async reconcileOrphanedJobs(plugin: RemoteAddonPlugin): Promise<void> {
    const { db } = this.deps;
    const addonId = plugin.manifest.id;
    const cutoff = Date.now() - ORPHAN_STALE_MS;
    const rows = db
      .query<{ id: string; source_ref: string | null }, [string, number]>(
        `SELECT id, source_ref FROM acquisition_jobs
         WHERE method = ? AND state = 'active' AND updated_at < ?`,
      )
      .all(addonId, cutoff);
    for (const row of rows) {
      const addonJobId = parseAddonJobId(row.source_ref, addonId);
      if (!addonJobId) continue;
      try {
        await plugin.client.getJob(addonJobId);
        // Still known to the addon — leave it; the normal poll owns its lifecycle.
      } catch (err) {
        // Only a definitive 404 (addon has no such job) fails it; a network blip
        // or other error is left for the next tick.
        if (err instanceof AddonRequestError && err.status === 404) {
          this.failOrphanedJob(row.id, addonId);
        }
      }
    }
  }

  private failOrphanedJob(coreJobId: string, addonId: string): void {
    const now = Date.now();
    const msg = 'The addon no longer has this job (it likely restarted mid-download).';
    // COALESCE, not overwrite: when `applyAddonOutcome` already recorded the
    // addon's own reason ("Unsupported URL: …"), the generic restart guess is
    // strictly worse — and it is what a released terminal job would otherwise
    // end up displaying, since releasing it is what makes getJob 404.
    this.deps.db.run(
      `UPDATE acquisition_jobs SET state = 'failed', stage = 'error',
              error = COALESCE(error, ?), updated_at = ?
       WHERE id = ? AND state = 'active'`,
      [msg, now, coreJobId],
    );
    this.deps.db.run(
      `UPDATE acquisition_job_items SET state = 'unavailable', updated_at = ?
       WHERE job_id = ? AND state NOT IN ('scanned', 'organized')`,
      [now, coreJobId],
    );
    log.info({ addonId, coreJobId }, 'failed an orphaned addon job (addon 404)');
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
      displayTitle: job.title == null ? null : clampAddonText(job.title),
      sourceRef: `addon:${addonId}:${job.id}`,
      files: [],
    });
    this.kvSet(addonId, `jobmap:${job.id}`, coreJobId);
    log.info({ addonId, addonJob: job.id, coreJobId }, 'mirroring addon job into the feed');
    return coreJobId;
  }

  /**
   * Backfill the feed row's artist/album once the addon supplies them. A `url`
   * resolve job is created (route-side, at submit) with no meta; the addon fills
   * `artist`/`album` from `ResolveResult.meta` when its background resolve lands.
   * Without this the tagless-source files (archive.org has no ID3) reach the
   * organizer with no album/artist and land in `unsorted` — the "downloaded but
   * vanished" report. `COALESCE` never overwrites a meta the row already carries.
   *
   * `title` rides along but stays in its own column: it is the card's *display*
   * name (a playlist name), and letting it fall back into `album_title` would
   * mint a phantom album and mis-file every track — which is exactly why the
   * protocol grew a separate field instead of overloading `album`.
   */
  private updateJobMeta(coreJobId: string, job: AddonJob): void {
    const now = Date.now();
    if (job.artist != null || job.album != null) {
      this.deps.db.run(
        `UPDATE acquisition_jobs
           SET artist_name = COALESCE(artist_name, ?), album_title = COALESCE(album_title, ?), updated_at = ?
         WHERE id = ? AND (artist_name IS NULL OR album_title IS NULL)`,
        [job.artist, job.album, now, coreJobId],
      );
    }
    // The display title is the one field that must NOT be first-writer-wins.
    // An addon legitimately refines it: the bundled archive.org addon sets a
    // placeholder from the URL identifier at `createJob` and replaces it with
    // the real item title once its background resolve lands. COALESCE would
    // pin the card to the placeholder forever — the opposite of the upgrade
    // the whole title chain is ordered around. Overwriting is safe precisely
    // because it is display-only and the addon owns it.
    if (job.title != null) {
      this.deps.db.run(
        `UPDATE acquisition_jobs SET display_title = ?, updated_at = ? WHERE id = ?`,
        [clampAddonText(job.title), now, coreJobId],
      );
    }
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

  /**
   * Mirror the addon's **own verdict** — its `state` and `error` — onto the core
   * feed row (issue: a beatport link sat at "Downloading 0 of 0" forever).
   *
   * The poller used to derive the core row's lifecycle purely from mirrored
   * *items*, and read nothing off `AddonJob.state`/`.error` except the release
   * check. That works for a job that produces files and breaks completely for
   * one that does not: `recomputeStage` deliberately no-ops on an item-less job
   * (`counts.size === 0`), and `acquisition_jobs.stage` defaults to
   * `'downloading'` — so a resolve the addon *failed* (yt-dlp has no beatport
   * extractor, and its manifest is the `^https?://` catch-all, so it is handed
   * every unmatched link) left an eternally "downloading" card with no items,
   * no error text and no Remove button. The addon knew; core never asked.
   *
   * Runs after `ingestReadyItems` so files delivered on this same tick are
   * organized/scanned first and a finished job closes as `done`, not a partial.
   */
  private applyAddonOutcome(coreJobId: string, job: AddonJob): void {
    const { db } = this.deps;
    const now = Date.now();

    // Mirror the addon's CURRENT error verbatim — including clearing it when the
    // addon does. A one-way write would let a transient note ("retrying: 429")
    // outlive the condition and then become the job's permanent verdict, since
    // `failOrphanedJob` deliberately COALESCEs rather than overwrites. Scoped to
    // an active row so a reason already recorded for a closed job is never
    // reopened.
    if (job.state === 'active') {
      // While the addon is still working, its word outranks what the items
      // happen to look like. `recomputeStage` derives the stage from items,
      // which is right once the addon is done and wrong before: an addon that
      // reports live can have ONLY `unavailable` items for its first tracks
      // ("Error · 0 of 3" on track 4 of 100) or a few `completed` ones
      // ("Organizing 11 of 22" while 78 more were still to come). A job with
      // items is Downloading until the addon says otherwise; an item-less one
      // keeps its submit stage (`queued`) so a URL the addon has not even
      // resolved yet does not claim to be downloading.
      db.run(
        `UPDATE acquisition_jobs SET state = 'active', stage = 'downloading', updated_at = ?
         WHERE id = ? AND state IN ('active', 'failed')
           AND EXISTS (SELECT 1 FROM acquisition_job_items WHERE job_id = ?)`,
        [now, coreJobId, coreJobId],
      );
      db.run(
        `UPDATE acquisition_jobs SET error = ?, updated_at = ? WHERE id = ? AND state = 'active'`,
        [job.error ? sanitizeAddonError(job.error) : null, now, coreJobId],
      );
      return;
    }

    // Terminal addon-side: anything still in flight is never arriving, so it
    // becomes `unavailable` and the job can close as an honest partial —
    // the same shape the slskd fallback uses when it exhausts its peers.
    // `completed` items are left alone: they are mid-ingest, and
    // `maybeReleaseAddonJob` already treats them as pending.
    db.run(
      `UPDATE acquisition_job_items SET state = 'unavailable', updated_at = ?
       WHERE job_id = ? AND state IN ('downloading', 'queued')`,
      [now, coreJobId],
    );
    const stage = recomputeStage(db, coreJobId);
    // The addon's closing word, for a job that DOES have items — `recomputeStage`
    // sets state/stage but never touches `error`, so a partial's reason would
    // otherwise be lost. When it landed nothing at all, the card states a reason
    // either way: an "Error" row that declines to say why is the worst of both.
    const closingError = job.error
      ? sanitizeAddonError(job.error)
      : stage === 'error'
        ? allItemsFailedMessage(job.state)
        : null;
    db.run(`UPDATE acquisition_jobs SET error = ?, updated_at = ? WHERE id = ?`, [
      closingError,
      now,
      coreJobId,
    ]);

    // An item-less terminal job is the case `recomputeStage` cannot rule on —
    // there is nothing to derive from. It is never a success: the addon either
    // failed outright, or finished having found no downloadable audio.
    const items = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM acquisition_job_items WHERE job_id = ?`,
      )
      .get(coreJobId);
    if ((items?.n ?? 0) > 0) return;
    db.run(
      `UPDATE acquisition_jobs SET state = 'failed', stage = 'error', error = ?, updated_at = ?
       WHERE id = ? AND state != 'superseded'`,
      [job.error ? sanitizeAddonError(job.error) : emptyOutcomeMessage(job.state), now, coreJobId],
    );
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
    // Contain the write to <incoming>/<addon>/<job>/ and reject a traversing
    // filename before opening any handle (§1 Stream 3).
    const local = safeIncomingPath(
      this.deps.incomingDir,
      plugin.manifest.id,
      job.id,
      item.filename,
    );
    mkdirSync(dirname(local), { recursive: true });
    const res = await plugin.client.fetchFile(job.id, item.itemId);
    if (!res.body) throw new Error('empty file response');

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ADDON_FILE_BYTES) {
      throw new AddonContractError(`delivered file ${declared} bytes exceeds cap`);
    }

    // Abort the stream past the byte cap so a hostile addon can't fill the disk
    // with one item (a lying/absent content-length can't bypass this).
    let written = 0;
    const capGuard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.byteLength;
        if (written > MAX_ADDON_FILE_BYTES) {
          cb(new AddonContractError('delivered file exceeds byte cap'));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as never), capGuard, createWriteStream(local));
    } catch (err) {
      rmSync(local, { force: true }); // never leave a partial/oversized file behind
      throw err;
    }
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

/**
 * Addon-supplied prose (an error, a display title) is untrusted third-party
 * output — a yt-dlp stderr dump runs to kilobytes. The card truncates it
 * visually; this bounds what we *store*, so one bad job can't bloat the feed
 * table and every poll that reads it.
 */
export const MAX_ADDON_TEXT_CHARS = 500;

const ANSI_RE = /\u001b\[[0-9;]*m/g;
/** Rich/`traceback` decoration: box-drawing frame + the ❱ current-line marker. */
const BOX_CHARS_RE = /[\u2500-\u257f\u2571\u2771\u276f\u2771]/g;
const EXCEPTION_LINE_RE = /^[A-Za-z_][\w.]*(?:Error|Exception|Warning)\b.*/;

/**
 * What a *person* should read when an addon dies (issue #601).
 *
 * `clampAddonText` only truncates, so whatever the addon sends is what the
 * Downloads card shows — and prod showed a user 500 characters of Rich-formatted
 * Python traceback (`│ /usr/lib/python3.13/json/__init__.py:346 in loads │`)
 * when spotdl's YouTube Music preflight was rate-limited. Core owns the
 * user-facing surface, so it reduces a traceback to the one line that says what
 * went wrong; the addon's own summaries — which are the genuinely useful ones —
 * pass through untouched, so this narrows *formatting*, never *which* error is
 * reported (the mirror-verbatim rule in `applyAddonOutcome` still holds).
 */
export function sanitizeAddonError(raw: string): string {
  const plain = raw.replace(ANSI_RE, '');
  const looksLikeTraceback =
    /Traceback \(most recent call last\)/.test(plain) || /[\u2502\u2570\u256d]/.test(plain);
  if (!looksLikeTraceback) return clampAddonText(plain);

  const lines = plain
    .split('\n')
    .map((l) =>
      l
        .replace(BOX_CHARS_RE, '')
        .replace(/[\u2502\u276f\u2771]/g, '')
        .trim(),
    )
    .filter((l) => l.length > 0);
  // The exception line is last in a Python traceback, so scan from the end.
  const exception = [...lines].reverse().find((l) => EXCEPTION_LINE_RE.test(l));
  const fallback = [...lines]
    .reverse()
    .find((l) => !/^(Traceback|\/|\d+\s|❱)/.test(l) && !l.includes(' in '));
  return clampAddonText(exception ?? fallback ?? lines[lines.length - 1] ?? plain);
}

function clampAddonText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_ADDON_TEXT_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_ADDON_TEXT_CHARS - 1)}…`;
}

/** Why an addon job that delivered nothing at all ended, in the user's terms. */
function emptyOutcomeMessage(state: AddonJob['state']): string {
  switch (state) {
    case 'cancelled':
      return 'The download was cancelled before any file arrived.';
    case 'failed':
      return 'The addon could not download this link.';
    default:
      // `done`/`partial` with zero items: the source resolved, but held no
      // audio this addon can fetch (a store/preview page, a deleted upload).
      return 'No downloadable audio was found at this link.';
  }
}

/** Why a job whose items all failed ended, when the addon closed without a word. */
function allItemsFailedMessage(state: AddonJob['state']): string {
  return state === 'cancelled'
    ? 'The download was cancelled before any file arrived.'
    : 'No file from this source could be downloaded.';
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
