import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { usersRoutes } from './users.js';
import { ProviderRegistry } from '../services/provider-registry.js';
import { SlskdSearchProvider } from '../services/providers/slskd-provider.js';

function makeRegistry(browseDirs: any[] = [], shouldThrow?: string) {
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
          ? async () => { throw new Error(shouldThrow) }
          : async () => browseDirs,
      },
    },
  } as any;
  const registry = new ProviderRegistry();
  registry.register(new SlskdSearchProvider(slskdRef));
  return registry;
}

describe('users routes', () => {
  it('returns browse directories for a valid username', async () => {
    const dirs = [{ name: 'Music\\Artist', fileCount: 1, files: [{ filename: 'Music\\Artist\\01.mp3', size: 5000 }] }];
    const registry = makeRegistry(dirs);

    const app = new Hono();
    app.route('/', usersRoutes(registry));

    const res = await app.request('/testuser/browse');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(dirs);
  });

  it('returns 501 when no IBrowseProvider is registered', async () => {
    const registry = new ProviderRegistry();

    const app = new Hono();
    app.route('/', usersRoutes(registry));

    const res = await app.request('/testuser/browse');
    expect(res.status).toBe(501);
  });

  it('returns 503 when slskdRef.current is null', async () => {
    const slskdRef = { current: null } as any;
    const registry = new ProviderRegistry();
    registry.register(new SlskdSearchProvider(slskdRef));

    const app = new Hono();
    app.route('/', usersRoutes(registry));

    const res = await app.request('/testuser/browse');
    expect(res.status).toBe(503);
  });
});
