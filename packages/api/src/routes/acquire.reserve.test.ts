import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { Role } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { applySchema } from '../db.js';
import { PluginRegistry } from '../services/plugins/registry.js';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import { LocalAddonTransport } from '../services/addons/local-transport.js';
import type { BundledAddon } from '../services/addons/bundled/types.js';
import type { AcquireWatcher } from '../services/acquire-watcher.js';
import { acquireRoutes } from './acquire.js';

/**
 * #714: `startAddonUrlJob` used to read the in-flight guard, `await` the addon
 * (prod measured 46 s for a playlist), and only then write the row — so every
 * click in that window passed the guard and started another download of the
 * same album. Three concurrent jobs for one Spotify URL were measured on prod.
 *
 * The fix reserves the row *before* the addon call, in the `resolving` stage
 * the same window needed a name for (#711). These tests hold the addon call
 * open so the race window is explicit rather than timing-dependent.
 */

/** An addon whose createJob blocks until the test releases it. */
function gatedAddon(): {
  addon: BundledAddon;
  release: (id: string) => void;
  calls: () => number;
} {
  let calls = 0;
  let resolveCreate: ((id: string) => void) | null = null;
  return {
    calls: () => calls,
    release: (id: string) => resolveCreate?.(id),
    addon: {
      manifest: {
        id: 'gated',
        name: 'Gated',
        description: 'test',
        version: '1.0.0',
        protocolVersion: '1.0.0',
        kind: 'acquisition',
        capabilities: ['resolve'],
        urlPatterns: ['^https?://'],
        priority: -10,
        compliance: { disclaimer: 'test', requiresConsent: false },
      },
      createJob: async () => {
        calls += 1;
        const id = await new Promise<string>((res) => {
          resolveCreate = res;
        });
        return { id, state: 'queued', items: [] } as never;
      },
      getJob: async () => {
        throw new Error('not used');
      },
      listJobs: async () => [],
      cancelJob: async () => {},
      filePath: async () => '/tmp/x',
    },
  };
}

const URL_UNDER_TEST = 'https://open.spotify.com/album/0ihuYyUx2aPvzKqcDkvjYo';

let db: Database;
let app: Hono<AuthEnv>;
let gate: ReturnType<typeof gatedAddon>;

async function makeApp(role: Role = 'user'): Promise<Hono<AuthEnv>> {
  const a = new Hono<AuthEnv>();
  a.onError(errorHandler);
  a.use('*', (c, next) => {
    c.set('user', { sub: 'user1', role, iat: 0, exp: 9999999999 });
    return next();
  });
  const registry = new PluginRegistry({ db, dataDir: '/tmp/nic-reserve-test' });
  registry.register(
    new RemoteAddonPlugin(gate.addon.manifest, new LocalAddonTransport(gate.addon)),
  );
  // Acquisition plugins are default-off; without this the route falls through
  // to the in-process watcher and never reaches `startAddonUrlJob`.
  await registry.enable('gated', 'test-user');
  const watcher = { submit: async () => 'never' } as unknown as AcquireWatcher;
  a.route('/', acquireRoutes(watcher, registry, db));
  return a;
}

async function submit(): Promise<Response> {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: URL_UNDER_TEST }),
  });
}

function jobRows(): { id: string; stage: string; state: string; source_ref: string | null }[] {
  return db
    .query<{ id: string; stage: string; state: string; source_ref: string | null }, []>(
      `SELECT id, stage, state, source_ref FROM acquisition_jobs WHERE kind = 'url'`,
    )
    .all();
}

beforeEach(async () => {
  db = new Database(':memory:');
  applySchema(db);
  gate = gatedAddon();
  app = await makeApp();
});

describe('the row is reserved before the addon is called (#711, #714)', () => {
  it('writes a resolving row that the in-flight guard can already see', async () => {
    const inFlight = submit();
    // The addon has not answered yet — but the row must already exist, because
    // the guard is a DB read and this is the whole window the race lived in.
    await Bun.sleep(20);
    const [row] = jobRows();
    expect(row).toBeDefined();
    expect(row.stage).toBe('resolving');
    expect(row.state).toBe('active');
    expect(row.source_ref).toBeNull();

    gate.release('addon-job-1');
    await inFlight;
  });

  it('collapses concurrent submits of one link onto a single addon job', async () => {
    const first = submit();
    await Bun.sleep(20);
    // Three more clicks land squarely inside the resolve window.
    const rest = [submit(), submit(), submit()];
    const reused = await Promise.all(rest);

    expect(jobRows()).toHaveLength(1);
    expect(gate.calls()).toBe(1);
    for (const res of reused) {
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ reused: true });
    }

    gate.release('addon-job-1');
    await first;
  });

  it('attaches the addon ref and leaves resolving once the addon answers', async () => {
    const inFlight = submit();
    await Bun.sleep(20);
    gate.release('addon-job-7');
    const res = await inFlight;
    expect(res.status).toBe(201);

    const [row] = jobRows();
    expect(row.stage).toBe('queued');
    expect(row.source_ref).toBe('addon:gated:addon-job-7');
  });
});
