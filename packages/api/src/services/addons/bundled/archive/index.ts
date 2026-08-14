import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ADDON_PROTOCOL_VERSION,
  createLogger,
  type AddonManifest,
  type AddonJob,
  type AddonJobItem,
  type AddonJobRequest,
} from '@nicotind/core';
import type { BundledAddon } from '../types.js';
import {
  resolveArchive,
  ARCHIVE_URL_PATTERN,
  ARCHIVE_DISCLAIMER,
  type ArchiveEngineOpts,
} from './engine.js';

const log = createLogger('bundled:archive');

export interface ArchiveBundledDeps {
  /** Base staging dir; each job downloads under `<stagingDir>/<jobId>/`. */
  stagingDir: string;
  preferredFormats?: string[];
  fetchFn?: ArchiveEngineOpts['fetchFn'];
  downloadFile?: ArchiveEngineOpts['downloadFile'];
}

const MANIFEST: AddonManifest = {
  id: 'bundled:archive',
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

  async function runResolve(id: string, url: string, entry: JobEntry): Promise<void> {
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const resolved = await resolveArchive(url, {
        stagingDir: join(deps.stagingDir, id),
        preferredFormats: deps.preferredFormats ?? ['MP3', 'FLAC'],
        fetchFn: deps.fetchFn,
        downloadFile: deps.downloadFile,
        signal: controller.signal,
      });
      entry.job.artist = resolved.artist;
      entry.job.album = resolved.album;
      entry.job.items = resolved.files.map((f, i): AddonJobItem => {
        const itemId = `${id}:${i}`;
        entry.paths.set(itemId, f.path);
        return {
          itemId,
          title: f.title,
          username: 'bundled:archive',
          filename: f.filename,
          size: f.size,
          state: 'completed',
          fileReady: true,
          updatedAt: now(),
        };
      });
      entry.job.state = 'done';
      entry.job.updatedAt = now();
    } catch (err) {
      entry.job.state = 'failed';
      entry.job.error = err instanceof Error ? err.message : String(err);
      entry.job.updatedAt = now();
      log.warn({ id, err: entry.job.error }, 'archive resolve failed');
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

      const job: AddonJob = {
        id,
        intent: 'url',
        artist: null,
        album: null,
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
      if (!entry) throw new Error(`bundled:archive: unknown job ${id}`);
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

    async filePath(jobId: string, itemId: string): Promise<string> {
      const path = jobs.get(jobId)?.paths.get(itemId);
      if (!path) throw new Error(`bundled:archive: no file for ${jobId}/${itemId}`);
      return path;
    },
  };
}
