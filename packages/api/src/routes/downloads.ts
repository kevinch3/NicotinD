import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import type { Database } from 'bun:sqlite';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import { createLogger } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { albumIdFor } from '../services/library-scanner.js';
import {
  createJob,
  jobMetaForTransfer,
  listJobFeed,
} from '../services/acquisition-job-store.js';

const log = createLogger('downloads');

/**
 * Attach `albumJob` metadata by the STORED transfer keys — the unified
 * acquisition-job replacement for the legacy folder-string matching below.
 * Works for any peer folder (alternate-peer fallbacks included) because the
 * link was recorded at enqueue time, not guessed from the directory name.
 */
export function enrichWithAcquisitionJobs(
  db: Database,
  groups: SlskdUserTransferGroup[],
): SlskdUserTransferGroup[] {
  return groups.map((group) => ({
    ...group,
    directories: group.directories.map((dir) => {
      if (dir.albumJob) return dir;
      for (const file of dir.files) {
        const meta = jobMetaForTransfer(db, group.username, file.filename);
        if (!meta) continue;
        if (!meta.artistName || !meta.albumTitle) return dir;
        return {
          ...dir,
          albumJob: {
            artistName: meta.artistName,
            albumTitle: meta.albumTitle,
            canonicalTrackCount: meta.canonicalTracks?.length ?? 0,
            albumId: albumIdFor(meta.artistName, meta.albumTitle),
          },
        };
      }
      return dir;
    }),
  }));
}

interface ActiveJobRow {
  username: string;
  directory: string;
  artist_name: string | null;
  album_title: string | null;
  canonical_tracks_json: string;
}

/**
 * Attach `albumJob` (canonical artist/album/track-count) to every download
 * directory whose (username, peer directory) matches an active album-hunt job.
 * Pure given the rows — only reads the DB once up front. Direct (non-hunt)
 * downloads are returned unchanged so the UI falls back to folder-name parsing.
 */
export function enrichWithAlbumJobs(
  db: Database,
  groups: SlskdUserTransferGroup[],
): SlskdUserTransferGroup[] {
  const rows = db
    .query<ActiveJobRow, []>(
      `SELECT username, directory, artist_name, album_title, canonical_tracks_json
       FROM album_jobs WHERE state = 'active'`,
    )
    .all();

  const byKey = new Map<
    string,
    { artistName: string; albumTitle: string; canonicalTrackCount: number; albumId: string }
  >();
  for (const r of rows) {
    if (!r.artist_name || !r.album_title) continue;
    let trackCount = 0;
    try {
      const tracks = JSON.parse(r.canonical_tracks_json) as unknown[];
      trackCount = Array.isArray(tracks) ? tracks.length : 0;
    } catch {
      trackCount = 0;
    }
    byKey.set(`${r.username}::${r.directory}`, {
      artistName: r.artist_name,
      albumTitle: r.album_title,
      canonicalTrackCount: trackCount,
      albumId: albumIdFor(r.artist_name, r.album_title),
    });
  }

  if (byKey.size === 0) return groups;

  return groups.map((group) => ({
    ...group,
    directories: group.directories.map((dir) => {
      if (dir.albumJob) return dir; // stored-key enrichment already labelled it
      const meta = byKey.get(`${group.username}::${dir.directory}`);
      return meta ? { ...dir, albumJob: meta } : dir;
    }),
  }));
}

const DownloadFileSchema = z.object({
  filename: z.string(),
  size: z.number(),
});

const EnqueueDownloadRequestSchema = z.object({
  username: z.string().min(1).openapi({ example: 'slsk_user' }),
  files: z.array(DownloadFileSchema).min(1),
});

const DownloadResponseSchema = z
  .object({
    ok: z.boolean(),
    queued: z.number(),
  })
  .openapi('DownloadResponse');

const ErrorSchema = z
  .object({
    error: z.string(),
  })
  .openapi('Error');

const SimpleSuccessSchema = z
  .object({
    ok: z.boolean(),
  })
  .openapi('SimpleSuccess');

export function downloadRoutes(registry: ProviderRegistry, slskdRef: SlskdRef) {
  const app = new OpenAPIHono<AuthEnv>();

  // Guard: if no network provider is available, downloads are unavailable
  app.use('*', async (c, next) => {
    if (!slskdRef.current) {
      return c.json({ error: 'Soulseek is not configured — downloads unavailable' }, 503);
    }
    await next();
  });

  // Enqueue downloads — via network provider
  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      request: {
        body: {
          content: {
            'application/json': {
              schema: EnqueueDownloadRequestSchema,
            },
          },
        },
      },
      responses: {
        201: {
          content: {
            'application/json': {
              schema: DownloadResponseSchema,
            },
          },
          description: 'Download enqueued successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Bad request',
        },
        502: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Bad Gateway (Provider unreachable)',
        },
        503: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Service Unavailable (Soulseek not configured)',
        },
      },
    }),
    async (c) => {
      const { username, files } = c.req.valid('json');

      const networkProviders = registry.getByType('network');
      const provider = networkProviders[0];

      if (!provider?.download) {
        return c.json({ error: 'No download provider available' }, 503);
      }

      try {
        await provider.download(username, files);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('slskd request failed')) {
          return c.json(
            {
              error: `Download failed for user "${username}" — they may be offline or rejecting transfers`,
            },
            502,
          );
        }
        return c.json({ error: 'Soulseek is temporarily unreachable' }, 503);
      }

      // Wrap even raw folder-browser grabs in a lightweight acquisition job so
      // every transfer belongs to a job (uniform feed, stored linkage). No
      // canonical metadata here — artist/album are best-effort display hints
      // parsed from the peer's folder segments. Best-effort: must never fail
      // the enqueue that already succeeded.
      try {
        const segments = (files[0]?.filename ?? '')
          .replace(/\\/g, '/')
          .split('/')
          .filter(Boolean)
          .slice(0, -1); // drop the file basename
        createJob(getDatabase(), {
          kind: 'direct',
          method: 'slskd',
          artistName: segments.length >= 2 ? segments[segments.length - 2] : null,
          albumTitle: segments.length >= 1 ? segments[segments.length - 1] : null,
          sourceRef: username,
          username,
          files,
        });
      } catch (err) {
        log.warn({ username, err }, 'Failed to record acquisition job for direct download');
      }
      return c.json({ ok: true, queued: files.length }, 201);
    },
  );

  // Manually retry failed transfers. Accepts a list so the UI can retry a whole
  // album group or a single file. Looks each transfer up to recover its
  // filename+size, cancels the dead record, re-enqueues (slskd resumes the
  // partial), and clears its auto-retry bookkeeping so it isn't immediately
  // re-frozen.
  app.openapi(
    createRoute({
      method: 'post',
      path: '/retry',
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                items: z
                  .array(z.object({ username: z.string().min(1), id: z.string().min(1) }))
                  .min(1),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            'application/json': { schema: z.object({ ok: z.boolean(), retried: z.number() }) },
          },
          description: 'Transfers re-enqueued',
        },
        503: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Service Unavailable (Soulseek unreachable)',
        },
      },
    }),
    async (c) => {
      const { items } = c.req.valid('json');

      let downloads;
      try {
        downloads = await slskdRef.current!.transfers.getDownloads();
      } catch {
        return c.json({ error: 'Soulseek is temporarily unreachable' }, 503);
      }
      const db = getDatabase();

      // Index every transfer by `${username}:${id}` for O(1) lookup of size/filename.
      const byKey = new Map<string, { filename: string; size: number }>();
      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            byKey.set(`${group.username}:${file.id}`, { filename: file.filename, size: file.size });
          }
        }
      }

      const clearRetry = db.prepare('DELETE FROM transfer_retries WHERE transfer_key = ?');
      const unhide = db.prepare('DELETE FROM hidden_transfers WHERE id = ?');

      let retried = 0;
      for (const { username, id } of items) {
        const file = byKey.get(`${username}:${id}`);
        if (!file) continue;

        await slskdRef.current!.transfers.cancel(username, id).catch(() => {});
        try {
          await slskdRef.current!.transfers.enqueue(username, [
            { filename: file.filename, size: file.size },
          ]);
        } catch {
          continue;
        }
        // Reset auto-retry bookkeeping so a manual retry gets a fresh budget.
        clearRetry.run(`${username}::${file.filename}`);
        unhide.run(id);
        retried++;
      }

      return c.json({ ok: true, retried }, 200);
    },
  );

  // List all downloads (slskd-specific transfer management)
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.array(z.any()),
            },
          },
          description: 'List of active and history downloads',
        },
        503: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Service Unavailable (Soulseek unreachable)',
        },
      },
    }),
    async (c) => {
      let downloads;
      try {
        downloads = await slskdRef.current!.transfers.getDownloads();
      } catch {
        return c.json({ error: 'Soulseek is temporarily unreachable' }, 503);
      }
      const db = getDatabase();

      // Get all hidden IDs
      const hidden = db.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>;
      const hiddenIds = new Set(hidden.map((h) => h.id));

      // Filter out hidden transfers (skip the map entirely when nothing is hidden).
      const visible =
        hiddenIds.size === 0
          ? downloads
          : downloads
              .map((group) => ({
                ...group,
                directories: group.directories
                  .map((dir) => ({
                    ...dir,
                    files: dir.files.filter((file) => !hiddenIds.has(file.id)),
                  }))
                  .filter((dir) => dir.files.length > 0),
              }))
              .filter((group) => group.directories.length > 0);

      // Annotate folders that came from the album-hunt flow with their canonical
      // artist/album/track-count so the UI can show real metadata instead of the
      // peer's noisy folder name. Matched by (username, peer directory).
      // Stored transfer-key enrichment first; the legacy album_jobs folder
      // match remains as fallback for pre-migration active downloads only.
      return c.json(enrichWithAlbumJobs(db, enrichWithAcquisitionJobs(db, visible)), 200);
    },
  );

  // Unified acquisition-job feed: one row per job (any method), newest first,
  // with per-state item progress and a deep-linkable albumId. Read model for
  // the Downloads page's job view.
  app.get('/jobs', (c) => {
    const db = getDatabase();
    const jobs = listJobFeed(db).map((job) => ({
      ...job,
      albumId:
        job.artistName && job.albumTitle ? albumIdFor(job.artistName, job.albumTitle) : null,
    }));
    return c.json(jobs, 200);
  });

  // Cancel/Remove a download
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{username}/{id}',
      request: {
        params: z.object({
          username: z.string(),
          id: z.string(),
        }),
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: SimpleSuccessSchema,
            },
          },
          description: 'Download cancelled or hidden',
        },
      },
    }),
    async (c) => {
      const { username, id } = c.req.valid('param');
      const db = getDatabase();

      // 1. Tell slskd to cancel it (works for in-progress; may fail if already gone)
      try {
        await slskdRef.current!.transfers.cancel(username, id);
      } catch {
        // Transfer may already be gone — not fatal
      }

      // 2. Mark as hidden in our DB (works for completed/cancelled history)
      db.run('INSERT OR IGNORE INTO hidden_transfers (id) VALUES (?)', [id]);

      return c.json({ ok: true }, 200);
    },
  );

  // Clear finished (completed/errored) downloads
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/finished',
      responses: {
        200: {
          content: {
            'application/json': {
              schema: SimpleSuccessSchema,
            },
          },
          description: 'Finished downloads cleared',
        },
        503: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Service Unavailable (Soulseek unreachable)',
        },
      },
    }),
    async (c) => {
      let downloads;
      try {
        downloads = await slskdRef.current!.transfers.getDownloads();
      } catch {
        return c.json({ error: 'Soulseek is temporarily unreachable' }, 503);
      }
      const db = getDatabase();

      const toCancel: Array<{ username: string; id: string }> = [];
      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            if (file.state.startsWith('Completed,')) {
              toCancel.push({ username: group.username, id: file.id });
            }
          }
        }
      }

      await Promise.all(
        toCancel.map(({ username, id }) =>
          slskdRef.current!.transfers.cancel(username, id).catch(() => {}),
        ),
      );

      const stmt = db.prepare('INSERT OR IGNORE INTO hidden_transfers (id) VALUES (?)');
      for (const { id } of toCancel) stmt.run(id);

      return c.json({ ok: true }, 200);
    },
  );

  // Cancel all downloads
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/',
      responses: {
        200: {
          content: {
            'application/json': {
              schema: SimpleSuccessSchema,
            },
          },
          description: 'All downloads cancelled',
        },
        503: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Service Unavailable (Soulseek unreachable)',
        },
      },
    }),
    async (c) => {
      let downloads;
      try {
        downloads = await slskdRef.current!.transfers.getDownloads();
      } catch {
        return c.json({ error: 'Soulseek is temporarily unreachable' }, 503);
      }

      await Promise.all(
        downloads.flatMap((group) =>
          group.directories.flatMap((dir) =>
            dir.files.map((file) =>
              slskdRef.current!.transfers.cancel(group.username, file.id).catch(() => {}),
            ),
          ),
        ),
      );

      // Hide every transfer so they disappear from the UI — don't clear existing hidden IDs
      const db = getDatabase();
      const stmt = db.prepare('INSERT OR IGNORE INTO hidden_transfers (id) VALUES (?)');
      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            stmt.run(file.id);
          }
        }
      }

      return c.json({ ok: true }, 200);
    },
  );

  return app;
}
