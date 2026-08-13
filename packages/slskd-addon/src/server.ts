import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { Slskd } from '@nicotind/slskd-client';
import { createLogger, type AddonHealth, type AddonStatusRow } from '@nicotind/addon-sdk';
import { buildManifest } from './manifest.js';
import { storeConfig } from './config.js';
import { createProtocolRoutes, type ProtocolRouteDeps } from './routes.js';

const log = createLogger('slskd-addon');

export interface AddonServerDeps {
  db: Database;
  /** Live slskd client (reconstructed by the caller when config changes). */
  slskdRef: { current: Slskd };
  /** Bearer the host must present on authenticated routes. */
  token: string;
  /** Called after a config push so the caller can rebuild clients. */
  onConfigChanged?: () => void;
  /** Overridable status source (upgraded once slskd-status moves in). */
  statusRows?: () => Promise<AddonStatusRow[]>;
  /**
   * The engine half (search/albums-search/jobs/files/browse/notify). Absent in
   * minimal deployments/tests — the manage/observe surface still works.
   */
  engine?: Pick<ProtocolRouteDeps, 'hunter' | 'trackHunter' | 'downloadsDir'>;
}

/**
 * The addon's Hono app (acquisition addon protocol v1 — see
 * docs/acquisition-addon-protocol.md). Only `manifest` and `health` are
 * unauthenticated; everything else requires the deployment's bearer token.
 */
export function createAddonApp(deps: AddonServerDeps): Hono {
  const app = new Hono();
  const v1 = new Hono();

  v1.get('/manifest', (c) => c.json(buildManifest()));

  v1.get('/health', async (c) => {
    let ready = false;
    let detail: string | undefined;
    try {
      await deps.slskdRef.current.server.getState();
      ready = true;
    } catch (err) {
      detail = err instanceof Error ? err.message : 'slskd unreachable';
    }
    const health: AddonHealth = { ok: true, ready, detail };
    return c.json(health);
  });

  // Bearer guard for everything below.
  v1.use('*', async (c, next) => {
    const auth = c.req.header('authorization');
    if (!deps.token || auth !== `Bearer ${deps.token}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  v1.get('/status', async (c) => {
    try {
      const rows = deps.statusRows ? await deps.statusRows() : await defaultStatusRows(deps);
      return c.json(rows);
    } catch (err) {
      log.warn({ err }, 'status probe failed');
      return c.json([] satisfies AddonStatusRow[]);
    }
  });

  v1.put('/config', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    storeConfig(deps.db, body);
    deps.onConfigChanged?.();
    return c.body(null, 204);
  });

  if (deps.engine) {
    v1.route('/', createProtocolRoutes({ db: deps.db, slskdRef: deps.slskdRef, ...deps.engine }));
  }

  app.route('/addon/v1', v1);
  return app;
}

async function defaultStatusRows(deps: AddonServerDeps): Promise<AddonStatusRow[]> {
  const state = await deps.slskdRef.current.server.getState().catch(() => null);
  const connection =
    state && (state as { isConnected?: boolean }).isConnected ? 'Connected' : 'Disconnected';
  return [{ key: 'connection', label: 'Connection', value: connection }];
}
