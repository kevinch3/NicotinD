import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { searchRoutes } from './search.js';

describe('search routes', () => {
  it('enriches network results with inferred metadata from filenames', async () => {
    const navidromeMock = {
      search: {
        search3: async () => ({ artist: [], album: [], song: [] }),
      },
    } as any;

    const slskdMock = {
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
    } as any;

    const app = new Hono();
    app.route('/', searchRoutes(slskdMock, navidromeMock));

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
});
