import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import type { Role } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { searchRoutes } from './search.js';
import { ProviderRegistry } from '../services/provider-registry.js';
import { LibrarySearchProvider } from '../services/providers/library-provider.js';
import { SlskdSearchProvider } from '../services/providers/slskd-provider.js';
import { applySchema } from '../db.js';

describe('search routes', () => {
  it('enriches network results with inferred metadata from filenames', async () => {
    const libraryDb = new Database(':memory:');
    applySchema(libraryDb);

    const slskdRef = {
      current: {
        searches: {
          create: async () => ({ id: 'slskd-search-1' }),
          get: async () => ({ state: 'InProgress', responseCount: 1 }),
          getResponses: async () => [
            {
              username: 'alice',
              freeUploadSlots: true,
              uploadSpeed: 1_700_000,
              files: [
                {
                  filename: 'Luke Evans - A Song for You.mp3',
                  size: 6_100_000,
                  bitRate: 192,
                  length: 196,
                  code: 'mp3',
                },
              ],
            },
          ],
          list: async () => [],
          delete: async () => undefined,
          cancel: async () => undefined,
        },
      },
    } as unknown as ConstructorParameters<typeof SlskdSearchProvider>[0];

    const registry = new ProviderRegistry();
    registry.register(new LibrarySearchProvider(libraryDb));
    registry.register(new SlskdSearchProvider(slskdRef));

    const app = new Hono();
    app.route('/', searchRoutes(registry));

    const searchRes = await app.request('/?q=Luke%20Evans');
    expect(searchRes.status).toBe(200);

    const searchBody = await searchRes.json();
    const networkRes = await app.request(`/${searchBody.searchId}/network`);
    expect(networkRes.status).toBe(200);

    const networkBody = await networkRes.json();
    const file = networkBody.results[0].files[0];

    expect(file.title).toBe('A Song for You');
    expect(file.artist).toBe('Luke Evans');
    expect(file.album).toBeUndefined();
  });

  it('suppresses the network fan-out for a listener (library-only search)', async () => {
    const libraryDb = new Database(':memory:');
    applySchema(libraryDb);

    let networkCreated = false;
    const slskdRef = {
      current: {
        searches: {
          create: async () => {
            networkCreated = true;
            return { id: 'slskd-search-1' };
          },
          get: async () => ({ state: 'InProgress', responseCount: 0 }),
          getResponses: async () => [],
          list: async () => [],
          delete: async () => undefined,
          cancel: async () => undefined,
        },
      },
    } as unknown as ConstructorParameters<typeof SlskdSearchProvider>[0];

    const registry = new ProviderRegistry();
    registry.register(new LibrarySearchProvider(libraryDb));
    registry.register(new SlskdSearchProvider(slskdRef));

    const appFor = (role: Role) => {
      const a = new Hono<AuthEnv>();
      a.use('*', (c, next) => {
        c.set('user', { sub: 'u', role, iat: 0, exp: 9999999999 });
        return next();
      });
      a.route('/', searchRoutes(registry));
      return a;
    };

    const listenerRes = await appFor('listener').request('/?q=test');
    expect(listenerRes.status).toBe(200);
    const listenerBody = await listenerRes.json();
    expect(listenerBody.networkAvailable).toBe(false);
    expect(networkCreated).toBe(false);

    // A user triggers the network provider.
    await appFor('user').request('/?q=test');
    expect(networkCreated).toBe(true);
  });

  it('poll response includes canBrowse: true when provider supports browsing', async () => {
    const slskdRef = {
      current: {
        searches: {
          create: async () => ({ id: 'slskd-search-1' }),
          get: async () => ({ state: 'InProgress', responseCount: 0 }),
          getResponses: async () => [],
          list: async () => [],
          delete: async () => undefined,
          cancel: async () => undefined,
        },
        users: {
          browseUser: async () => [],
        },
      },
    } as unknown as ConstructorParameters<typeof SlskdSearchProvider>[0];

    const registry = new ProviderRegistry();
    registry.register(new SlskdSearchProvider(slskdRef));

    const app = new Hono();
    app.route('/', searchRoutes(registry));

    const searchRes = await app.request('/?q=test');
    const { searchId } = await searchRes.json();

    const pollRes = await app.request(`/${searchId}/network`);
    const body = await pollRes.json();

    expect(body.canBrowse).toBe(true);
  });
});
