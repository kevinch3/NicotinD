import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import { getDatabase } from '../db.js';

const DownloadFileSchema = z.object({
  filename: z.string(),
  size: z.number(),
});

const EnqueueDownloadRequestSchema = z.object({
  username: z.string().min(1).openapi({ example: 'slsk_user' }),
  files: z.array(DownloadFileSchema).min(1),
});

const DownloadResponseSchema = z.object({
  ok: z.boolean(),
  queued: z.number(),
}).openapi('DownloadResponse');

const ErrorSchema = z.object({
  error: z.string(),
}).openapi('Error');

const SimpleSuccessSchema = z.object({
  ok: z.boolean(),
}).openapi('SimpleSuccess');

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
            { error: `Download failed for user "${username}" — they may be offline or rejecting transfers` },
            502,
          );
        }
        throw err;
      }
      return c.json({ ok: true, queued: files.length }, 201);
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
      },
    }),
    async (c) => {
      const downloads = await slskdRef.current!.transfers.getDownloads();
      const db = getDatabase();

      // Get all hidden IDs
      const hidden = db.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>;
      const hiddenIds = new Set(hidden.map((h) => h.id));

      if (hiddenIds.size === 0) {
        return c.json(downloads, 200);
      }

      // Filter out hidden transfers
      const filtered = downloads
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

      return c.json(filtered, 200);
    },
  );

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
      },
    }),
    async (c) => {
      const downloads = await slskdRef.current!.transfers.getDownloads();
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
      },
    }),
    async (c) => {
      await slskdRef.current!.transfers.cancelAll();

      // Also clear our hidden transfers since "Cancel All" usually means "Clean state"
      const db = getDatabase();
      db.run('DELETE FROM hidden_transfers');

      return c.json({ ok: true }, 200);
    },
  );

  return app;
}
