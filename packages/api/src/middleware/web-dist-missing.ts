import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Env, Hono } from 'hono';

/** Whether the built web UI is there to serve (its index.html, not just the folder). */
export function webUiBuilt(webDistPath: string): boolean {
  return existsSync(join(webDistPath, 'index.html'));
}

const HINT =
  'NicotinD web UI not built. From the repository root run `bun run build`, then restart. ' +
  'The API under /api works without it.';

/**
 * Stand-in for the web UI when its build is missing (#1732). A source checkout
 * started without `bun run build` used to answer `/` with a bare 404 and log
 * nothing; now it warns once at startup and every non-API page says what to do.
 */
export function mountWebUiMissing<E extends Env>(
  app: Hono<E>,
  webDistPath: string,
  log: { warn: (fields: Record<string, unknown>, msg: string) => void },
): void {
  log.warn({ webDistPath }, `web UI not built — run \`bun run build\` (looked in ${webDistPath})`);
  app.get('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/doc' || path === '/openapi.json' || path.startsWith('/api/')) return next();
    return c.text(HINT, 503);
  });
}
