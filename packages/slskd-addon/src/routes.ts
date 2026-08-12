import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import {
  addonAlbumSearchRequestSchema,
  addonJobRequestSchema,
  addonSearchRequestSchema,
  baseQueries,
  buildSkewedQueries,
  createLogger,
  type AddonAlbumSearchResponse,
  type AddonSearchResult,
} from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { AlbumHunterService } from './services/album-hunter.service.js';
import type { TrackHunterService } from './services/track-hunter.service.js';
import {
  candidateCache,
  executeJobRequest,
  JobConflictError,
  JobRequestError,
} from './services/job-engine.js';
import {
  deleteAddonJob,
  getAddonJob,
  listAddonJobs,
  setJobState,
  syncItemStatesFromTransfers,
} from './services/job-store.js';

const log = createLogger('addon-routes');

const SEARCH_POLL_MS = 2_000;
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
  '.m4a',
  '.aac',
  '.wav',
  '.aiff',
  '.wma',
  '.ape',
  '.wv',
]);

export interface ProtocolRouteDeps {
  db: Database;
  slskdRef: { current: Slskd };
  hunter: () => AlbumHunterService;
  trackHunter: () => TrackHunterService;
  /** Where slskd lands completed files (file serving root). */
  downloadsDir: () => string;
}

/**
 * The engine half of the addon protocol v1: search, album hunt, jobs, file
 * delivery, browse, share-rescan notify. Mounted behind the server's bearer
 * guard (see createAddonApp).
 */
export function createProtocolRoutes(deps: ProtocolRouteDeps): Hono {
  const app = new Hono();
  const candidates = candidateCache();
  // Lost-response retry safety: an Idempotency-Key maps to the job it created.
  const idempotency = new Map<string, { jobId: string; expires: number }>();
  let rescanTimer: ReturnType<typeof setTimeout> | null = null;

  app.post('/search', async (c) => {
    const parsed = addonSearchRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid search request' }, 400);
    const { query, waitMs } = parsed.data;
    const slskd = deps.slskdRef.current;

    let search: { id: string };
    try {
      search = await slskd.searches.create(query);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'search failed' }, 502);
    }
    let complete = false;
    try {
      const deadline = Date.now() + (waitMs ?? 20_000);
      while (Date.now() < deadline) {
        const state = await slskd.searches.get(search.id).catch(() => null);
        if (!state || state.state !== 'InProgress') {
          complete = true;
          break;
        }
        await new Promise((r) => setTimeout(r, SEARCH_POLL_MS));
      }
      const responses = await slskd.searches.getResponses(search.id).catch(() => []);
      const results: AddonSearchResult[] = [];
      for (const response of responses) {
        const byDir = new Map<string, typeof response.files>();
        for (const file of response.files) {
          const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
          if (!AUDIO_EXTENSIONS.has(ext)) continue;
          const dir = dirOf(file.filename);
          const list = byDir.get(dir) ?? [];
          list.push(file);
          byDir.set(dir, list);
          results.push({
            kind: 'song',
            title: basenameOf(file.filename),
            username: response.username,
            directory: dir,
            filename: file.filename,
            size: file.size,
            bitRateKbps: file.bitRate,
            freeUploadSlots: response.freeUploadSlots,
            queueLength: response.queueLength,
            uploadSpeed: response.uploadSpeed,
          });
        }
        for (const [dir, files] of byDir) {
          if (files.length < 2) continue;
          results.push({
            kind: 'folder',
            title: dir.split(/[\\/]/).pop() ?? dir,
            username: response.username,
            directory: dir,
            files: files.map((f) => ({
              filename: f.filename,
              size: f.size,
              bitRateKbps: f.bitRate,
            })),
            freeUploadSlots: response.freeUploadSlots,
            queueLength: response.queueLength,
            uploadSpeed: response.uploadSpeed,
          });
        }
      }
      return c.json({ results, complete });
    } finally {
      await slskd.searches.delete(search.id).catch(() => {});
    }
  });

  app.post('/albums/search', async (c) => {
    const parsed = addonAlbumSearchRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid albums/search request' }, 400);
    const { artist, album, canonicalTracks, skew } = parsed.data;
    const hunter = deps.hunter();
    try {
      const base = await hunter.huntBase(artist, album, canonicalTracks, { skewSearch: true });
      let folderCandidates = base.candidates;
      const skewRan = skew === true || base.skewNeeded;
      if (skewRan) {
        folderCandidates = await hunter.hunt(artist, album, canonicalTracks, { skewSearch: true });
      }
      const queries = [
        ...baseQueries(artist, album),
        ...(skewRan ? buildSkewedQueries(artist, album, baseQueries(artist, album)) : []),
      ];
      const body: AddonAlbumSearchResponse = {
        candidates: candidates.put(folderCandidates),
        queries,
        skewNeeded: base.skewNeeded,
      };
      return c.json(body);
    } catch (err) {
      log.warn({ err }, 'albums/search failed');
      return c.json({ error: err instanceof Error ? err.message : 'hunt failed' }, 502);
    }
  });

  app.post('/jobs', async (c) => {
    const parsed = addonJobRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid job request' }, 400);

    const idemKey = c.req.header('idempotency-key');
    if (idemKey) {
      const prior = idempotency.get(idemKey);
      if (prior && prior.expires > Date.now()) {
        return c.json({ job: getAddonJob(deps.db, prior.jobId) }, 201);
      }
    }

    try {
      const jobId = await executeJobRequest(
        {
          db: deps.db,
          slskd: deps.slskdRef.current,
          hunter: deps.hunter(),
          trackHunter: deps.trackHunter(),
          resolveCandidate: (ref) => candidates.resolve(ref),
        },
        parsed.data,
      );
      if (idemKey) idempotency.set(idemKey, { jobId, expires: Date.now() + 3_600_000 });
      return c.json({ job: getAddonJob(deps.db, jobId) }, 201);
    } catch (err) {
      if (err instanceof JobConflictError) {
        return c.json({ error: err.message, existingJobId: err.existingJobId }, 409);
      }
      if (err instanceof JobRequestError) {
        return c.json({ error: err.message }, 400);
      }
      log.warn({ err }, 'job request failed');
      return c.json({ error: err instanceof Error ? err.message : 'job failed' }, 502);
    }
  });

  app.get('/jobs', async (c) => {
    const since = Number(c.req.query('since') ?? '') || undefined;
    await syncFromLiveTransfers(deps);
    return c.json({ jobs: listAddonJobs(deps.db, since) });
  });

  app.get('/jobs/:id', async (c) => {
    await syncFromLiveTransfers(deps);
    const job = getAddonJob(deps.db, c.req.param('id'));
    if (!job) return c.json({ error: 'job not found' }, 404);
    return c.json({ job });
  });

  app.post('/jobs/:id/cancel', async (c) => {
    const job = getAddonJob(deps.db, c.req.param('id'));
    if (!job) return c.json({ error: 'job not found' }, 404);
    // Best-effort: find the live transfer ids for the job's pending items.
    const slskd = deps.slskdRef.current;
    try {
      const downloads = await slskd.transfers.getDownloads();
      const pending = new Set(
        job.items
          .filter((i) => i.state === 'queued' || i.state === 'downloading')
          .map((i) => `${i.username}::${i.filename}`),
      );
      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            if (!pending.has(`${group.username}::${file.filename}`)) continue;
            if (typeof file.id === 'string' && file.id) {
              await slskd.transfers
                .cancel(group.username, file.id, { remove: true })
                .catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      log.debug({ err }, 'cancel: transfer sweep failed (continuing)');
    }
    deps.db.run(
      `UPDATE addon_job_items SET state = 'failed', updated_at = ? WHERE job_id = ? AND state IN ('queued','downloading')`,
      [Date.now(), job.id],
    );
    setJobState(deps.db, job.id, 'cancelled');
    return c.json({ job: getAddonJob(deps.db, job.id) });
  });

  app.delete('/jobs/:id', (c) => {
    const job = getAddonJob(deps.db, c.req.param('id'));
    if (!job) return c.json({ error: 'job not found' }, 404);
    deleteAddonJob(deps.db, job.id);
    return c.json({ ok: true });
  });

  app.get('/jobs/:id/files/:itemId', (c) => {
    const job = getAddonJob(deps.db, c.req.param('id'));
    const item = job?.items.find((i) => i.itemId === c.req.param('itemId'));
    if (!job || !item) return c.json({ error: 'item not found' }, 404);
    if (!item.fileReady) return c.json({ error: 'file not ready' }, 409);
    const row = deps.db
      .query<{ relative_path: string | null }, [string, string]>(
        `SELECT relative_path FROM completed_downloads WHERE username = ? AND filename = ?`,
      )
      .get(item.username, item.filename);
    if (!row?.relative_path) return c.json({ error: 'file not resolved on disk' }, 409);
    const abs = join(deps.downloadsDir(), row.relative_path);
    if (!existsSync(abs)) return c.json({ error: 'file missing on disk' }, 410);
    const stat = statSync(abs);
    return new Response(Bun.file(abs), {
      headers: {
        'Content-Length': String(stat.size),
        'Content-Type': 'application/octet-stream',
        ETag: `"${stat.size}-${Math.floor(stat.mtimeMs)}"`,
      },
    });
  });

  app.get('/browse', async (c) => {
    const user = c.req.query('user');
    if (!user) return c.json({ error: 'user is required' }, 400);
    try {
      const directories = await deps.slskdRef.current.users.browseUser(user);
      return c.json({ directories });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'browse failed' }, 502);
    }
  });

  app.post('/notify/library-changed', (c) => {
    // Debounced: bulk deletes fire many notifies; one rescan covers them all.
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      deps.slskdRef.current.shares.rescan().catch((err) => {
        log.warn({ err }, 'share rescan failed');
      });
    }, 5_000);
    return c.json({ ok: true });
  });

  return app;
}

async function syncFromLiveTransfers(deps: ProtocolRouteDeps): Promise<void> {
  try {
    const downloads = await deps.slskdRef.current.transfers.getDownloads();
    syncItemStatesFromTransfers(deps.db, downloads);
  } catch {
    // slskd down — serve the last persisted states.
  }
}

function dirOf(filename: string): string {
  const normalized = filename.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx > 0 ? normalized.slice(0, idx) : '';
}

function basenameOf(filename: string): string {
  return filename.replace(/\\/g, '/').split('/').pop() ?? filename;
}
