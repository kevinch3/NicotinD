import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import { getDatabase } from '../db.js';

export function downloadRoutes(registry: ProviderRegistry, slskdRef: SlskdRef) {
  const app = new Hono<AuthEnv>();

  // Guard: if no network provider is available, downloads are unavailable
  app.use('*', async (c, next) => {
    if (!slskdRef.current) {
      return c.json({ error: 'Soulseek is not configured — downloads unavailable' }, 503);
    }
    await next();
  });

  // Enqueue downloads — via network provider
  app.post('/', async (c) => {
    const { username, files } = await c.req.json<{
      username: string;
      files: Array<{ filename: string; size: number }>;
    }>();

    if (!username || !files?.length) {
      return c.json({ error: 'username and files are required' }, 400);
    }

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
        return c.json({ error: `Download failed for user "${username}" — they may be offline or rejecting transfers` }, 502);
      }
      throw err;
    }
    return c.json({ ok: true, queued: files.length }, 201);
  });

  // List all downloads (slskd-specific transfer management)
  app.get('/', async (c) => {
    const downloads = await slskdRef.current!.transfers.getDownloads();
    const db = getDatabase();

    // Get all hidden IDs
    const hidden = db.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>;
    const hiddenIds = new Set(hidden.map(h => h.id));

    if (hiddenIds.size === 0) {
      return c.json(downloads);
    }

    // Filter out hidden transfers
    const filtered = downloads.map(group => ({
      ...group,
      directories: group.directories.map(dir => ({
        ...dir,
        files: dir.files.filter(file => !hiddenIds.has(file.id))
      })).filter(dir => dir.files.length > 0)
    })).filter(group => group.directories.length > 0);

    return c.json(filtered);
  });

  // Cancel/Remove a download
  app.delete('/:username/:id', async (c) => {
    const username = c.req.param('username');
    const id = c.req.param('id');
    const db = getDatabase();

    // 1. Tell slskd to cancel it (works for in-progress; may fail if already gone)
    try {
      await slskdRef.current!.transfers.cancel(username, id);
    } catch {
      // Transfer may already be gone — not fatal
    }

    // 2. Mark as hidden in our DB (works for completed/cancelled history)
    db.run('INSERT OR IGNORE INTO hidden_transfers (id) VALUES (?)', [id]);

    return c.json({ ok: true });
  });

  // Cancel all downloads
  app.delete('/', async (c) => {
    await slskdRef.current!.transfers.cancelAll();

    // Also clear our hidden transfers since "Cancel All" usually means "Clean state"
    const db = getDatabase();
    db.run('DELETE FROM hidden_transfers');

    return c.json({ ok: true });
  });

  return app;
}
