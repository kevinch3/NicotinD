import { describe, expect, it, mock, afterEach } from 'bun:test';
import { AlbumApi } from './album.js';
import { LidarrClient } from '../client.js';

function stubFetch(payload: unknown): ReturnType<typeof mock> {
  const fetchMock = mock(async () => new Response(JSON.stringify(payload), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('AlbumApi.wantedMissing', () => {
  const client = new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k' });
  const api = new AlbumApi(client);

  it('requests the paged, monitored missing list with the artist included', async () => {
    const fetchMock = stubFetch({ records: [{ id: 1, title: 'X' }] });

    const records = await api.wantedMissing(2, 5);

    const url = (fetchMock.mock.calls[0]![0] as string) ?? '';
    expect(url).toContain('/api/v1/wanted/missing');
    expect(url).toContain('page=2');
    expect(url).toContain('pageSize=5');
    expect(url).toContain('monitored=true');
    expect(url).toContain('includeArtist=true');
    expect(records).toHaveLength(1);
  });

  it('returns an empty array when Lidarr omits records', async () => {
    stubFetch({});
    expect(await api.wantedMissing()).toEqual([]);
  });
});
