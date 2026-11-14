import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADDON_PROTOCOL_VERSION,
  createLogger,
  type AddonManifest,
  type AddonJob,
  type AddonJobItem,
  type AddonJobRequest,
} from '@nicotind/core';
import { BundledJobNotFoundError, type BundledAddon } from '../types.js';
import {
  resolveArchive,
  parseArchiveIdentifier,
  ARCHIVE_URL_PATTERN,
  ARCHIVE_DISCLAIMER,
  type ArchiveEngineOpts,
} from './engine.js';
import { humanizeSlug } from '@nicotind/core';

const log = createLogger('bundled:archive');

export interface ArchiveBundledDeps {
  /** Base staging dir; each job downloads under `<stagingDir>/<hash of jobId>/`. */
  stagingDir: string;
  preferredFormats?: string[];
  fetchFn?: ArchiveEngineOpts['fetchFn'];
  downloadFile?: ArchiveEngineOpts['downloadFile'];
}

/** The registry id of the archive.org addon: the one plugin that enables
 *  archive.org, for resolve AND the search/hunt lanes (#1728). */
export const BUNDLED_ARCHIVE_ID = 'bundled-archive';

const MANIFEST: AddonManifest = {
  id: BUNDLED_ARCHIVE_ID,
  name: 'archive.org',
  description: 'Download audio from an archive.org item by URL (Internet Archive).',
  version: '1.0.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['resolve'],
  urlPatterns: [ARCHIVE_URL_PATTERN],
  compliance: { disclaimer: ARCHIVE_DISCLAIMER, requiresConsent: true },
};

interface JobEntry {
  job: AddonJob;
  paths: Map<string, string>;
}

/**
 * The bundled archive.org addon (Approach A). `createJob` returns an active job
 * immediately and resolves the URL in the background — the acquire route never
 * blocks on the download, and the poller observes the job flip to `done` with
 * `fileReady` items. Files stage under `<stagingDir>/<jobId>/`; `filePath` hands
 * the poller the local path for in-process delivery.
 */
export function makeArchiveBundledAddon(deps: ArchiveBundledDeps): BundledAddon {
  const jobs = new Map<string, JobEntry>();
  const controllers = new Map<string, AbortController>();
  const now = (): number => Date.now();

  // why: a job id is the caller's idempotency key — often the item URL — so it
  // cannot be a path segment as-is.
  const jobDir = (id: string): string =>
    join(deps.stagingDir, createHash('sha256').update(id).digest('hex').slice(0, 16));

  function touch(entry: JobEntry, item?: AddonJobItem): void {
    const t = now();
    if (item) item.updatedAt = t;
    entry.job.updatedAt = t;
  }

  async function runResolve(id: string, url: string, entry: JobEntry): Promise<void> {
    const controller = new AbortController();
    controllers.set(id, controller);
    const { job } = entry;
    try {
      await resolveArchive(url, {
        stagingDir: jobDir(id),
        preferredFormats: deps.preferredFormats ?? ['MP3', 'FLAC'],
        fetchFn: deps.fetchFn,
        downloadFile: deps.downloadFile,
        signal: controller.signal,
        // Every file is listed the moment the metadata names it, so the card
        // counts "n of N" and shows bytes instead of "Queued · 0" for a whole
        // multi-hour item (#1892).
        onPlan: (plan) => {
          job.artist = plan.artist;
          job.album = plan.album;
          // The real item title, replacing the identifier-derived placeholder.
          job.title = plan.album;
          job.items = plan.files.map((f, i): AddonJobItem => ({
            itemId: `${id}:${i}`,
            title: f.title,
            username: 'bundled:archive',
            filename: f.filename,
            size: f.size,
            state: 'downloading',
            bytesTransferred: 0,
            fileReady: false,
            updatedAt: now(),
          }));
          touch(entry);
        },
        onProgress: (i, bytes) => {
          const item = job.items[i];
          if (!item) return;
          item.bytesTransferred = bytes;
          touch(entry, item);
        },
        // Each file is deliverable as it lands; the poller ingests it while
        // the rest of the item still downloads.
        onFileDone: (i, f) => {
          const item = job.items[i];
          if (!item) return;
          entry.paths.set(item.itemId, f.path);
          item.size = f.size;
          item.bytesTransferred = f.size;
          item.state = 'completed';
          item.fileReady = true;
          touch(entry, item);
        },
      });
      job.state = 'done';
      touch(entry);
    } catch (err) {
      job.state = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      // Files that landed stay deliverable; only the unfinished ones failed.
      for (const item of job.items) {
        if (item.state !== 'completed') {
          item.state = 'failed';
          touch(entry, item);
        }
      }
      touch(entry);
      log.warn({ id, err: job.error }, 'archive resolve failed');
    } finally {
      controllers.delete(id);
    }
  }

  return {
    manifest: MANIFEST,

    async createJob(req: AddonJobRequest, idempotencyKey?: string): Promise<AddonJob> {
      if (req.intent !== 'url' || !req.url) {
        throw new Error('bundled:archive only handles url jobs with a url');
      }
      const id = idempotencyKey ?? randomUUID();
      const existing = jobs.get(id);
      if (existing) return existing.job;

      const identifier = parseArchiveIdentifier(req.url);
      const job: AddonJob = {
        id,
        intent: 'url',
        artist: null,
        album: null,
        // Display-only, and available immediately: `runResolve` is async, so
        // without this the card reads "archive.org download" until it lands.
        title: identifier ? humanizeSlug(identifier) : null,
        state: 'active',
        error: null,
        items: [],
        createdAt: now(),
        updatedAt: now(),
      };
      const entry: JobEntry = { job, paths: new Map() };
      jobs.set(id, entry);
      void runResolve(id, req.url, entry);
      return job;
    },

    async getJob(id: string): Promise<AddonJob> {
      const entry = jobs.get(id);
      if (!entry) throw new BundledJobNotFoundError(BUNDLED_ARCHIVE_ID, id);
      return entry.job;
    },

    async listJobs(sinceMs?: number): Promise<AddonJob[]> {
      return [...jobs.values()]
        .map((e) => e.job)
        .filter((j) => sinceMs === undefined || j.updatedAt >= sinceMs);
    },

    async cancelJob(id: string): Promise<void> {
      controllers.get(id)?.abort();
    },

    // The poller releases a job once every file is fetched (or its card was
    // removed): drop it and its staged copies, which nothing reads again.
    async deleteJob(id: string): Promise<void> {
      controllers.get(id)?.abort();
      jobs.delete(id);
      rmSync(jobDir(id), { recursive: true, force: true });
    },

    async filePath(jobId: string, itemId: string): Promise<string> {
      const path = jobs.get(jobId)?.paths.get(itemId);
      if (!path) throw new Error(`bundled:archive: no file for ${jobId}/${itemId}`);
      return path;
    },
  };
}
