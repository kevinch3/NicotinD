import { describe, expect, it } from 'bun:test';
import { ADDON_PROTOCOL_VERSION, type AddonManifest } from '@nicotind/core';
import {
  AddonClient,
  AddonContractError,
  AddonRequestError,
  MAX_ADDON_RESPONSE_BYTES,
} from './client.js';

const MANIFEST: AddonManifest = {
  id: 'fixture-addon',
  name: 'Fixture Addon',
  description: 'test',
  version: '0.1.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['search'],
};

interface Captured {
  url: string;
  method: string;
  auth: string | null;
  body: string | null;
}

function stubFetch(
  respond: (req: Captured) => Response,
  captured: Captured[] = [],
): { fetchFn: typeof fetch; captured: Captured[] } {
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    captured.push(req);
    return respond(req);
  }) as typeof fetch;
  return { fetchFn, captured };
}

describe('AddonClient', () => {
  it('fetches the manifest without an auth header and normalizes the base url', async () => {
    const { fetchFn, captured } = stubFetch(() => Response.json(MANIFEST));
    const client = new AddonClient({ baseUrl: 'http://addon:9999/', token: 'tok', fetchFn });
    const manifest = await client.getManifest();
    expect(manifest.id).toBe('fixture-addon');
    expect(captured[0]!.url).toBe('http://addon:9999/addon/v1/manifest');
    expect(captured[0]!.auth).toBeNull();
  });

  it('sends the bearer token on status', async () => {
    const { fetchFn, captured } = stubFetch(() =>
      Response.json([{ key: 'peers', label: 'Peers', value: '42' }]),
    );
    const client = new AddonClient({ baseUrl: 'http://addon:9999', token: 'tok', fetchFn });
    const rows = await client.getStatus();
    expect(rows[0]!.value).toBe('42');
    expect(captured[0]!.auth).toBe('Bearer tok');
  });

  it('PUTs config with the bearer token', async () => {
    const { fetchFn, captured } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new AddonClient({ baseUrl: 'http://addon:9999', token: 'tok', fetchFn });
    await client.putConfig({ username: 'kevin' });
    expect(captured[0]!.method).toBe('PUT');
    expect(captured[0]!.url).toBe('http://addon:9999/addon/v1/config');
    expect(JSON.parse(captured[0]!.body!)).toEqual({ username: 'kevin' });
  });

  it('throws AddonRequestError with the status on a non-2xx', async () => {
    const { fetchFn } = stubFetch(() => new Response('nope', { status: 401 }));
    const client = new AddonClient({ baseUrl: 'http://addon:9999', token: 'bad', fetchFn });
    try {
      await client.getStatus();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AddonRequestError);
      expect((err as AddonRequestError).status).toBe(401);
    }
  });

  it('rejects a malformed manifest body', async () => {
    const { fetchFn } = stubFetch(() => Response.json({ id: 'x' }));
    const client = new AddonClient({ baseUrl: 'http://addon:9999', token: 'tok', fetchFn });
    // A malformed manifest is a contract violation, not a transport error.
    await expect(client.getManifest()).rejects.toBeInstanceOf(AddonContractError);
  });

  it('parses health', async () => {
    const { fetchFn } = stubFetch(() =>
      Response.json({ ok: true, ready: false, detail: 'warming' }),
    );
    const client = new AddonClient({ baseUrl: 'http://addon:9999', token: 'tok', fetchFn });
    const health = await client.getHealth();
    expect(health.ready).toBe(false);
  });
});

describe('AddonClient engine surface', () => {
  it('creates a job with an idempotency key and unwraps the body', async () => {
    const { fetchFn, captured } = stubFetch(() =>
      Response.json({ job: { id: 'j1', intent: 'album', items: [] } }),
    );
    const client = new AddonClient({ baseUrl: 'http://addon:9999', token: 'tok', fetchFn });
    const job = await client.createJob({ intent: 'album', artist: 'A', album: 'B' }, 'key-1');
    expect(job.id).toBe('j1');
    expect(captured[0]!.url).toBe('http://addon:9999/addon/v1/jobs');
    expect(captured[0]!.auth).toBe('Bearer tok');
  });

  it('lists jobs since a cursor', async () => {
    const { fetchFn, captured } = stubFetch(() => Response.json({ jobs: [{ id: 'j1' }] }));
    const client = new AddonClient({ baseUrl: 'http://addon:9999', token: 'tok', fetchFn });
    const jobs = await client.listJobs(123);
    expect(jobs).toHaveLength(1);
    expect(captured[0]!.url).toBe('http://addon:9999/addon/v1/jobs?since=123');
  });

  it('fetchFile returns the raw response and throws on non-2xx', async () => {
    const ok = new AddonClient({
      baseUrl: 'http://addon:9999',
      token: 'tok',
      fetchFn: stubFetch(() => new Response('bytes')).fetchFn,
    });
    const res = await ok.fetchFile('j1', 't:song one');
    expect(await res.text()).toBe('bytes');

    const gone = new AddonClient({
      baseUrl: 'http://addon:9999',
      token: 'tok',
      fetchFn: stubFetch(() => new Response('x', { status: 410 })).fetchFn,
    });
    await expect(gone.fetchFile('j1', 't:x')).rejects.toBeInstanceOf(AddonRequestError);
  });
});

describe('AddonClient response hardening (§1 Stream 1)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };

  it('rejects a JSON response larger than the size cap with AddonContractError', async () => {
    const huge = JSON.stringify({ pad: 'x'.repeat(MAX_ADDON_RESPONSE_BYTES + 100) });
    const client = new AddonClient({
      baseUrl: 'http://addon:9999',
      token: 'tok',
      fetchFn: stubFetch(() => new Response(huge, { headers: jsonHeaders })).fetchFn,
    });
    await expect(client.getStatus()).rejects.toBeInstanceOf(AddonContractError);
  });

  it('rejects a body whose content-length claims it is over the cap, before reading it', async () => {
    const client = new AddonClient({
      baseUrl: 'http://addon:9999',
      token: 'tok',
      fetchFn: stubFetch(
        () =>
          new Response('{}', {
            headers: { ...jsonHeaders, 'content-length': String(MAX_ADDON_RESPONSE_BYTES + 1) },
          }),
      ).fetchFn,
    });
    await expect(client.getStatus()).rejects.toBeInstanceOf(AddonContractError);
  });

  it('rejects a non-JSON body (e.g. an HTML error page) with AddonContractError', async () => {
    const client = new AddonClient({
      baseUrl: 'http://addon:9999',
      token: 'tok',
      fetchFn: stubFetch(
        () => new Response('<html>nope</html>', { headers: { 'content-type': 'text/html' } }),
      ).fetchFn,
    });
    await expect(client.getStatus()).rejects.toBeInstanceOf(AddonContractError);
  });

  it('rejects malformed JSON with AddonContractError', async () => {
    const client = new AddonClient({
      baseUrl: 'http://addon:9999',
      token: 'tok',
      fetchFn: stubFetch(() => new Response('{not json', { headers: jsonHeaders })).fetchFn,
    });
    await expect(client.getStatus()).rejects.toBeInstanceOf(AddonContractError);
  });

  it('a void endpoint returning an empty 200 body still resolves', async () => {
    const client = new AddonClient({
      baseUrl: 'http://addon:9999',
      token: 'tok',
      fetchFn: stubFetch(() => new Response('', { status: 200 })).fetchFn,
    });
    await expect(client.notifyLibraryChanged()).resolves.toBeUndefined();
  });

  it('a well-formed JSON response under the cap passes through', async () => {
    const client = new AddonClient({
      baseUrl: 'http://addon:9999',
      token: 'tok',
      fetchFn: stubFetch(
        () =>
          new Response(JSON.stringify([{ key: 'k', label: 'L', value: 'v' }]), {
            headers: jsonHeaders,
          }),
      ).fetchFn,
    });
    expect(await client.getStatus()).toHaveLength(1);
  });
});

describe('AddonClient outcome hook (§4 circuit-breaker feed)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  function withOutcomes(respond: () => Response) {
    const outcomes: string[] = [];
    const client = new AddonClient({
      baseUrl: 'http://addon:9999',
      token: 'tok',
      fetchFn: stubFetch(respond).fetchFn,
      onOutcome: (o) => outcomes.push(o),
    });
    return { client, outcomes };
  }

  it("reports 'ok' on a clean call", async () => {
    const { client, outcomes } = withOutcomes(() => new Response('[]', { headers: jsonHeaders }));
    await client.getStatus();
    expect(outcomes).toEqual(['ok']);
  });

  it("reports 'contract-violation' on a bad-shape/non-JSON body", async () => {
    const { client, outcomes } = withOutcomes(
      () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(client.getStatus()).rejects.toBeInstanceOf(AddonContractError);
    expect(outcomes).toEqual(['contract-violation']);
  });

  it("reports 'transient' on a 5xx", async () => {
    const { client, outcomes } = withOutcomes(() => new Response('err', { status: 503 }));
    await expect(client.getStatus()).rejects.toBeInstanceOf(AddonRequestError);
    expect(outcomes).toEqual(['transient']);
  });
});
