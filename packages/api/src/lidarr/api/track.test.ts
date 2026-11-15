import { afterEach, describe, expect, it, mock } from 'bun:test';
import { TrackApi } from './track.js';
import { LidarrClient } from '../client.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('TrackApi.listByRelease', () => {
  it("asks for one release's tracks, which the album listing cannot give for an unmonitored one", async () => {
    const fetchMock = mock(
      async (_url: string) =>
        new Response(JSON.stringify([{ id: 1, title: 'Airportman' }]), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = new TrackApi(new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k' }));

    const tracks = await api.listByRelease(8972);

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v1/track?albumReleaseId=8972');
    expect(tracks.map((t) => t.title)).toEqual(['Airportman']);
  });
});
