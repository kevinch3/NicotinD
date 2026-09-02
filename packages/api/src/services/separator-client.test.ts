import { describe, it, expect } from 'bun:test';
import {
  SeparationRejectedError,
  SeparationUnavailableError,
  SeparatorClient,
} from './separator-client.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function flac(): Response {
  return new Response(new Uint8Array([0x66, 0x4c, 0x61, 0x43]), {
    status: 200,
    headers: { 'content-type': 'audio/flac', 'x-source-duration-sec': '30.0' },
  });
}

describe('SeparatorClient health', () => {
  it('reports ok even when cold (loaded=false), caches for the TTL and shares one probe', async () => {
    let calls = 0;
    const client = new SeparatorClient({
      baseUrl: 'http://sep:8000/',
      healthTtlMs: 60_000,
      fetchFn: async () => {
        calls += 1;
        return json({ status: 'ok', loaded: false, device: 'cuda' });
      },
    });
    const [a, b] = await Promise.all([client.healthy(), client.healthy()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(await client.healthy()).toBe(true);
    expect(calls).toBe(1);
    expect(client.healthySnapshot()).toBe(true);
  });

  it('is unhealthy on status unavailable and on a transport failure', async () => {
    const down = new SeparatorClient({
      baseUrl: 'http://sep',
      fetchFn: async () => json({ status: 'unavailable', reason: 'no-cuda' }),
    });
    expect(await down.healthy()).toBe(false);
    const gone = new SeparatorClient({
      baseUrl: 'http://sep',
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await gone.healthy()).toBe(false);
  });
});

describe('SeparatorClient.separate', () => {
  it('posts the relPath and hands back the FLAC response', async () => {
    let seen: { url: string; body: string } | null = null;
    const client = new SeparatorClient({
      baseUrl: 'http://sep',
      fetchFn: async (url, init) => {
        seen = { url: String(url), body: String(init?.body) };
        return flac();
      },
    });
    const res = await client.separate('Artist/Album/01.mp3', { timeoutMs: 5_000 });
    expect(res.headers.get('content-type')).toBe('audio/flac');
    expect(seen!.url).toBe('http://sep/separate');
    expect(JSON.parse(seen!.body)).toEqual({ relPath: 'Artist/Album/01.mp3' });
  });

  it('422 is a verdict on the file: SeparationRejectedError carrying the detail', async () => {
    const client = new SeparatorClient({
      baseUrl: 'http://sep',
      fetchFn: async () => json({ detail: 'track length 0.5s outside [1.0, 900.0]' }, 422),
    });
    await expect(client.separate('x.mp3', { timeoutMs: 1_000 })).rejects.toBeInstanceOf(
      SeparationRejectedError,
    );
    await expect(client.separate('x.mp3', { timeoutMs: 1_000 })).rejects.toThrow(/0\.5s/);
  });

  it('503, a transport error and a non-FLAC body are environmental, and poison cached health', async () => {
    for (const fetchFn of [
      async () => json({ detail: 'worker died' }, 503),
      async () => {
        throw new Error('socket hang up');
      },
      async () => json({ oops: true }, 200),
    ]) {
      const client = new SeparatorClient({ baseUrl: 'http://sep', fetchFn, healthTtlMs: 60_000 });
      await expect(client.separate('x.mp3', { timeoutMs: 1_000 })).rejects.toBeInstanceOf(
        SeparationUnavailableError,
      );
      expect(client.healthySnapshot()).toBe(false);
    }
  });

  it('a timeout is environmental too', async () => {
    const client = new SeparatorClient({
      baseUrl: 'http://sep',
      fetchFn: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    await expect(client.separate('x.mp3', { timeoutMs: 20 })).rejects.toBeInstanceOf(
      SeparationUnavailableError,
    );
  });
});
