import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { usersRoutes } from './users.js';
import { ProviderRegistry } from '../services/provider-registry.js';
import { SlskdSearchProvider } from '../services/providers/slskd-provider.js';
import { BrowseUnavailableError } from '@nicotind/core';

function makeRegistry(browseDirs: any[] = [], shouldThrow?: Error) {
  const slskdRef = {
    current: {
      searches: {
        create: async () => ({ id: 'x' }),
        get: async () => ({ state: 'InProgress', responseCount: 0 }),
        getResponses: async () => [],
        list: async () => [],
        delete: async () => undefined,
        cancel: async () => undefined,
      },
      users: {
        browseUser: shouldThrow
          ? async () => { throw shouldThrow; }
          : async () => browseDirs,
      },
    },
  } as any;
  const registry = new ProviderRegistry();
  registry.register(new SlskdSearchProvider(slskdRef));
  return registry;
}

/** Poll until the job is no longer pending, or throw after maxAttempts */
async function pollUntilDone(app: Hono, username: string, jobId: string, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const res = await app.request(`/${username}/browse/${jobId}`);
    const body = await res.json() as any;
    if (body.state !== 'pending') return { res, body };
  }
  throw new Error('Browse job never completed within test timeout');
}

describe('users routes', () => {
  it('starts a browse job and returns dirs on poll', async () => {
    const dirs = [{ name: 'Music\\Artist', fileCount: 1, files: [{ filename: 'Music\\Artist\\01.mp3', size: 5000 }] }];
    const registry = makeRegistry(dirs);
    const app = new Hono();
    app.route('/', usersRoutes(registry));

    const startRes = await app.request('/testuser/browse');
    expect(startRes.status).toBe(202);
    const { jobId, state } = await startRes.json() as any;
    expect(state).toBe('pending');
    expect(typeof jobId).toBe('string');

    const { res, body } = await pollUntilDone(app, 'testuser', jobId);
    expect(res.status).toBe(200);
    expect(body.state).toBe('complete');
    // dirs are filtered to only mp3/ogg by the provider; mp3 should survive
    expect(body.dirs).toEqual(dirs);
  });

  it('returns 501 when no IBrowseProvider is registered', async () => {
    const registry = new ProviderRegistry();
    const app = new Hono();
    app.route('/', usersRoutes(registry));

    const res = await app.request('/testuser/browse');
    expect(res.status).toBe(501);
  });

  it('returns error state when slskdRef.current is null (BrowseUnavailableError)', async () => {
    const slskdRef = { current: null } as any;
    const registry = new ProviderRegistry();
    registry.register(new SlskdSearchProvider(slskdRef));
    const app = new Hono();
    app.route('/', usersRoutes(registry));

    const startRes = await app.request('/testuser/browse');
    expect(startRes.status).toBe(202);
    const { jobId } = await startRes.json() as any;

    const { res, body } = await pollUntilDone(app, 'testuser', jobId);
    expect(res.status).toBe(200);
    expect(body.state).toBe('error');
    expect(body.error).toContain('Browse provider not available');
  });

  it('returns error state when the provider throws a generic error', async () => {
    const registry = makeRegistry([], new Error('peer not reachable'));
    const app = new Hono();
    app.route('/', usersRoutes(registry));

    const startRes = await app.request('/testuser/browse');
    expect(startRes.status).toBe(202);
    const { jobId } = await startRes.json() as any;

    const { res, body } = await pollUntilDone(app, 'testuser', jobId);
    expect(res.status).toBe(200);
    expect(body.state).toBe('error');
    expect(body.error).toContain('peer not reachable');
  });

  it('returns 404 for an unknown jobId', async () => {
    const registry = makeRegistry([]);
    const app = new Hono();
    app.route('/', usersRoutes(registry));

    const res = await app.request('/testuser/browse/non-existent-job-id');
    expect(res.status).toBe(404);
  });
});
