import { beforeEach, describe, expect, it } from 'bun:test';
import { providerHealthSnapshot, resetProviderHealth } from '@nicotind/core';
import {
  LidarrClient,
  LidarrTimeoutError,
  LidarrUnavailableError,
  TIMEOUT_LOCAL_MS,
  TIMEOUT_LOOKUP_MS,
  TIMEOUT_PROVISION_MS,
} from './client.js';
import { AlbumApi } from './api/album.js';
import { ArtistApi } from './api/artist.js';

/**
 * There was no timeout at all. `request<T>()` is the single path behind 13
 * methods and 43 non-test call sites, and 21 of those already swallow failures
 * into `[]`/`null` — so a hung Lidarr held them open forever, and a budget that
 * is too tight degrades silently instead of erroring. These pin the tiers and
 * the error mapping rather than the happy path.
 */

/** Records what the client asked for, without touching the network. */
function recordingFetch(): { fetchFn: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Never resolves on its own — only the signal ends it. */
const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // hangs forever, which is the pre-fix behaviour
    signal.addEventListener('abort', () => reject(signal.reason));
  })) as unknown as typeof fetch;

describe('timeout budgets', () => {
  it('orders the three tiers by how much work Lidarr does', () => {
    expect(TIMEOUT_LOCAL_MS).toBeLessThan(TIMEOUT_LOOKUP_MS);
    expect(TIMEOUT_LOOKUP_MS).toBeLessThan(TIMEOUT_PROVISION_MS);
  });

  it('caps lookup below the 30s the web client aborts at', () => {
    // A budget longer than the caller's own would never fire — decorative.
    expect(TIMEOUT_LOOKUP_MS).toBeLessThan(30_000);
  });

  it('always attaches a signal, so no call can hang forever', async () => {
    const { fetchFn, calls } = recordingFetch();
    const client = new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k', fetchFn });
    await client.request('/api/v1/artist');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('lets an explicit caller signal win — the budget is a default, not a ceiling', async () => {
    const { fetchFn, calls } = recordingFetch();
    const client = new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k', fetchFn });
    const mine = new AbortController().signal;
    await client.request('/api/v1/artist', { signal: mine });
    expect(calls[0]?.signal).toBe(mine);
  });

  it('reports a timeout as a timeout, not a bare DOMException', async () => {
    // 21 call sites swallow this into `[]`/`null`, so the message is the only
    // place "Lidarr never answered" stays distinguishable from "Lidarr said no".
    const client = new LidarrClient({
      baseUrl: 'http://lidarr:8686',
      apiKey: 'k',
      fetchFn: hangingFetch,
    });
    await expect(client.request('/api/v1/artist', {}, 10)).rejects.toThrow(
      /timed out after 10ms: \/api\/v1\/artist/,
    );
  });

  it('throws the typed LidarrTimeoutError so callers can branch on timeout-vs-fast-failure', async () => {
    // CatalogService must not retry a timeout (the first attempt already burned
    // 20s of the web's 30s GET budget) but should retry a fast failure once.
    const client = new LidarrClient({
      baseUrl: 'http://lidarr:8686',
      apiKey: 'k',
      fetchFn: hangingFetch,
    });
    await expect(client.request('/api/v1/artist', {}, 10)).rejects.toBeInstanceOf(
      LidarrTimeoutError,
    );
  });
});

describe('per-method tiers', () => {
  /**
   * Spy on `request` itself rather than trying to read the signal's deadline,
   * which is not observable. An earlier version of this raced a hanging fetch
   * and skipped its assertion when nothing rejected in time — a test that can
   * quietly assert nothing, which is the exact shape this backlog exists to
   * remove.
   */
  function spyBudgets(client: LidarrClient): number[] {
    const seen: number[] = [];
    const original = client.request.bind(client);
    client.request = ((path: string, init?: RequestInit, timeoutMs?: number) => {
      seen.push(timeoutMs ?? TIMEOUT_LOCAL_MS);
      return original(path, init, timeoutMs);
    }) as typeof client.request;
    return seen;
  }

  function client(): LidarrClient {
    const { fetchFn } = recordingFetch();
    return new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k', fetchFn });
  }

  it('sends local queries on the short budget', async () => {
    const c = client();
    const seen = spyBudgets(c);
    await new AlbumApi(c).get(1);
    await new AlbumApi(c).listByArtist(1);
    expect(seen).toEqual([TIMEOUT_LOCAL_MS, TIMEOUT_LOCAL_MS]);
  });

  it('gives both lookups the metadata-proxy budget', async () => {
    const c = client();
    const seen = spyBudgets(c);
    await new AlbumApi(c).lookup('x');
    await new ArtistApi(c).lookup('x');
    expect(seen).toEqual([TIMEOUT_LOOKUP_MS, TIMEOUT_LOOKUP_MS]);
  });

  it('gives artist.add the provisioning budget — it imports a discography', async () => {
    const c = client();
    const seen = spyBudgets(c);
    await new ArtistApi(c).add({ id: 1 } as never, 1, '/music', 1);
    expect(seen).toEqual([TIMEOUT_PROVISION_MS]);
  });
});

describe('root-folder bookkeeping (#1580)', () => {
  it('resolves a void Lidarr action that answers 200 with an empty body', async () => {
    const fetchFn = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const c = new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k', fetchFn });
    await expect(new ArtistApi(c).deleteRootFolder(3)).resolves.toBeUndefined();
  });

  it('reassigns a root folder without ever asking Lidarr to move files', async () => {
    const { fetchFn, calls } = recordingFetch();
    const c = new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k', fetchFn });
    await new ArtistApi(c).reassignRootFolder([1, 2], '/config/nicotind-metadata');
    expect(calls[0]?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      artistIds: [1, 2],
      rootFolderPath: '/config/nicotind-metadata',
      moveFiles: false,
    });
  });
});

/**
 * Issue #670. Every outcome was observed once, as a log line, and then swallowed
 * into `[]`/`null` by ~20 call sites — so `GET /api/admin/review` could not tell
 * a metadata outage from a quiet library. `request()` is the one seam that sees
 * all of them, so it is the one place that can count them.
 */
describe('provider-health counters', () => {
  beforeEach(() => resetProviderHealth());

  function clientWith(fetchFn: typeof fetch): LidarrClient {
    return new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k', fetchFn });
  }

  it('counts a success', async () => {
    const { fetchFn } = recordingFetch();
    await clientWith(fetchFn).request('/api/v1/artist');
    expect(providerHealthSnapshot().lidarr).toMatchObject({ ok: 1, failed: 0 });
  });

  it('records a timeout as a timeout, with no status', async () => {
    await expect(clientWith(hangingFetch).request('/api/v1/artist', {}, 10)).rejects.toThrow();
    const h = providerHealthSnapshot().lidarr;
    expect(h).toMatchObject({ ok: 0, failed: 1, timedOut: 1, lastFailureKind: 'timeout' });
    expect(h.lastFailureStatus).toBeNull();
  });

  it('records a non-ok response as an http failure carrying the status', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(clientWith(failing).request('/api/v1/artist')).rejects.toThrow();
    expect(providerHealthSnapshot().lidarr).toMatchObject({
      failed: 1,
      timedOut: 0,
      lastFailureKind: 'http',
      lastFailureStatus: 500,
    });
  });

  it('records a dropped connection as a network failure, not a timeout', async () => {
    const dead = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    await expect(clientWith(dead).request('/api/v1/artist')).rejects.toThrow(/ECONNREFUSED/);
    expect(providerHealthSnapshot().lidarr).toMatchObject({
      failed: 1,
      timedOut: 0,
      lastFailureKind: 'network',
    });
  });

  it('leaves MusicBrainz alone', async () => {
    const { fetchFn } = recordingFetch();
    await clientWith(fetchFn).request('/api/v1/artist');
    expect(providerHealthSnapshot().musicbrainz).toMatchObject({ ok: 0, failed: 0 });
  });
});

/**
 * Issue #1581. While Lidarr was out of memory, background enrichment kept
 * sending it 10-20 s requests. The breaker counts every call's outcome; only the
 * background view is refused while it is open, so a person's request still goes
 * out — and its answer is what re-closes the breaker.
 */
describe('circuit breaker', () => {
  function counting(status: number): { fetchFn: typeof fetch; count: () => number } {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return new Response('[]', { status });
    }) as unknown as typeof fetch;
    return { fetchFn, count: () => n };
  }

  it('opens after repeated 5xx, then the background view fails fast without calling Lidarr', async () => {
    const { fetchFn, count } = counting(503);
    const client = new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k', fetchFn });
    const background = client.background();
    for (let i = 0; i < 3; i++)
      await expect(background.request('/api/v1/artist')).rejects.toThrow();
    expect(client.circuit.isOpen).toBe(true);

    await expect(background.request('/api/v1/artist')).rejects.toBeInstanceOf(
      LidarrUnavailableError,
    );
    expect(count()).toBe(3);
  });

  it('never refuses an interactive call, and its answer closes the breaker', async () => {
    let status = 503;
    const fetchFn = (async () => new Response('[]', { status })) as unknown as typeof fetch;
    const client = new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k', fetchFn });
    for (let i = 0; i < 3; i++) await expect(client.request('/api/v1/artist')).rejects.toThrow();
    expect(client.circuit.isOpen).toBe(true);

    status = 200;
    await expect(client.request('/api/v1/artist')).resolves.toEqual([]);
    expect(client.circuit.isOpen).toBe(false);
    await expect(client.background().request('/api/v1/artist')).resolves.toEqual([]);
  });

  it('treats a 4xx as an answer, not a failure', async () => {
    const { fetchFn } = counting(404);
    const client = new LidarrClient({ baseUrl: 'http://lidarr:8686', apiKey: 'k', fetchFn });
    for (let i = 0; i < 5; i++) await expect(client.request('/api/v1/album/9')).rejects.toThrow();
    expect(client.circuit.isOpen).toBe(false);
  });

  it('counts timeouts toward opening', async () => {
    const client = new LidarrClient({
      baseUrl: 'http://lidarr:8686',
      apiKey: 'k',
      fetchFn: hangingFetch,
    });
    for (let i = 0; i < 3; i++)
      await expect(client.request('/api/v1/artist', {}, 5)).rejects.toThrow();
    expect(client.circuit.isOpen).toBe(true);
  });
});
