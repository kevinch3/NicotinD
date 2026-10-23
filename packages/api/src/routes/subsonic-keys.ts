import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import {
  listSubsonicKeys,
  mintSubsonicKey,
  revokeSubsonicKey,
  TooManySubsonicKeysError,
} from '../services/subsonic-keys.js';

const MAX_NAME_LEN = 100;

/**
 * Self-service OpenSubsonic API keys (docs/opensubsonic.md). Any signed-in user
 * manages their own: a key only ever acts as its owner, so there is no role to
 * gate. Share sessions are already read-only at the auth middleware.
 */
export function subsonicKeysRoutes(getDb: () => Database) {
  const app = new Hono<AuthEnv>();

  app.get('/', (c) => c.json({ keys: listSubsonicKeys(getDb(), c.var.user.sub) }));

  app.post('/', async (c) => {
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LEN) {
      return c.json({ error: `name is required (max ${MAX_NAME_LEN} chars)` }, 400);
    }
    try {
      const { id, key } = mintSubsonicKey(getDb(), c.var.user.sub, name);
      // The raw key is shown exactly once; only its hash is stored.
      return c.json({ id, name, key }, 201);
    } catch (err) {
      if (err instanceof TooManySubsonicKeysError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  app.delete('/:id', (c) => {
    const ok = revokeSubsonicKey(getDb(), c.var.user.sub, c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  return app;
}
