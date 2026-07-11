import { describe, expect, it } from 'bun:test';
import { AudioFeaturesClient, AudioFileRejectedError } from './audio-features-client.js';

const GOOD_PAYLOAD = {
  embedding: { model: 'discogs-effnet-bs64-1', dim: 3, values: [0.1, 0.2, 0.3] },
  features: {
    danceability: 0.8,
    valence: 0.4,
    acousticness: 0.1,
    instrumental: 0.9,
    mood: 'relaxed',
  },
  modelVersions: { embedding: 'discogs-effnet-bs64-1' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  healthTtlMs = 60_000,
): AudioFeaturesClient {
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
  return new AudioFeaturesClient({ baseUrl: 'http://analysis:8000/', fetchFn, healthTtlMs });
}

describe('AudioFeaturesClient.healthy', () => {
  it('true only when the sidecar reports status ok', async () => {
    const c = clientWith(() => jsonResponse({ status: 'ok', modelVersions: {} }));
    expect(await c.healthy()).toBe(true);

    const down = clientWith(() => jsonResponse({ status: 'unavailable' }));
    expect(await down.healthy()).toBe(false);
  });

  it('false when the request throws (unreachable)', async () => {
    const c = clientWith(() => {
      throw new Error('ECONNREFUSED');
    });
    expect(await c.healthy()).toBe(false);
  });

  it('caches the probe result within the TTL', async () => {
    let calls = 0;
    const c = clientWith(() => {
      calls++;
      return jsonResponse({ status: 'ok' });
    });
    await c.healthy();
    await c.healthy();
    await c.healthy();
    expect(calls).toBe(1);
  });

  it('healthySnapshot returns last-known state synchronously', async () => {
    const c = clientWith(() => jsonResponse({ status: 'ok' }));
    expect(c.healthySnapshot()).toBe(false); // pre-probe default
    await c.healthy();
    expect(c.healthySnapshot()).toBe(true);
  });
});

describe('AudioFeaturesClient.analyze', () => {
  it('returns the validated payload and strips the trailing base-url slash', async () => {
    let calledUrl = '';
    let sentBody = '';
    const c = clientWith((url, init) => {
      calledUrl = url;
      sentBody = String(init?.body);
      return jsonResponse(GOOD_PAYLOAD);
    });
    const res = await c.analyze('Artist/Album/song.opus');
    expect(calledUrl).toBe('http://analysis:8000/analyze');
    expect(JSON.parse(sentBody)).toEqual({ relPath: 'Artist/Album/song.opus' });
    expect(res).toEqual(GOOD_PAYLOAD);
  });

  it('returns null on non-OK statuses and marks unhealthy on 503', async () => {
    const c = clientWith(() => jsonResponse({ detail: 'models not loaded' }, 503));
    expect(await c.analyze('x.opus')).toBeNull();
    expect(c.healthySnapshot()).toBe(false);

    const notFound = clientWith(() => jsonResponse({ detail: 'nope' }, 404));
    expect(await notFound.analyze('x.opus')).toBeNull();
  });

  it('returns null when the request throws', async () => {
    const c = clientWith(() => {
      throw new Error('socket hang up');
    });
    expect(await c.analyze('x.opus')).toBeNull();
  });

  it('throws AudioFileRejectedError on 422 (un-decodable file) without flipping health', async () => {
    const c = clientWith((url) =>
      url.endsWith('/health')
        ? jsonResponse({ status: 'ok' })
        : jsonResponse({ detail: 'decoded audio too short' }, 422),
    );
    await c.healthy(); // prime cached health = true
    try {
      await c.analyze('bad.opus');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AudioFileRejectedError);
      expect((err as AudioFileRejectedError).message).toContain('too short');
      expect((err as AudioFileRejectedError).status).toBe(422);
    }
    // 422 is a per-file failure, not an outage: health stays healthy.
    expect(c.healthySnapshot()).toBe(true);
  });

  it('returns null (does not throw) on 404 so an env mount mismatch never gets ledgered', async () => {
    const c = clientWith(() => jsonResponse({ detail: 'nope' }, 404));
    expect(await c.analyze('missing.opus')).toBeNull();
  });

  it('rejects payloads with out-of-vocab mood', async () => {
    const bad = structuredClone(GOOD_PAYLOAD);
    bad.features.mood = 'euphoric';
    const c = clientWith(() => jsonResponse(bad));
    expect(await c.analyze('x.opus')).toBeNull();
  });

  it('rejects payloads whose embedding length mismatches dim', async () => {
    const bad = structuredClone(GOOD_PAYLOAD);
    bad.embedding.values = [0.1];
    const c = clientWith(() => jsonResponse(bad));
    expect(await c.analyze('x.opus')).toBeNull();
  });

  it('clamps out-of-range scores instead of rejecting', async () => {
    const noisy = structuredClone(GOOD_PAYLOAD);
    noisy.features.danceability = 1.4;
    const c = clientWith(() => jsonResponse(noisy));
    const res = await c.analyze('x.opus');
    expect(res?.features.danceability).toBe(1);
  });
});

describe('AudioFeaturesClient.rhythm', () => {
  it('returns the validated rhythm payload', async () => {
    let calledUrl = '';
    let sentBody = '';
    const c = clientWith((url, init) => {
      calledUrl = url;
      sentBody = String(init?.body);
      return jsonResponse({ bpm: 142.0, confidence: 2.92, method: 'multifeature' });
    });
    const res = await c.rhythm('AC DC/song.opus');
    expect(calledUrl).toBe('http://analysis:8000/rhythm');
    expect(JSON.parse(sentBody)).toEqual({ relPath: 'AC DC/song.opus' });
    expect(res).toEqual({ bpm: 142.0, confidence: 2.92 });
  });

  it('throws AudioFileRejectedError on 422 (un-decodable file)', async () => {
    const c = clientWith(() => jsonResponse({ detail: 'rhythm analysis failed' }, 422));
    await expect(c.rhythm('x.opus')).rejects.toBeInstanceOf(AudioFileRejectedError);
  });

  it('returns null on 503/404 and transport errors (environmental, not per-file)', async () => {
    expect(await clientWith(() => jsonResponse({}, 503)).rhythm('x.opus')).toBeNull();
    expect(await clientWith(() => jsonResponse({}, 404)).rhythm('x.opus')).toBeNull();
    const throwing = clientWith(() => {
      throw new Error('ECONNREFUSED');
    });
    expect(await throwing.rhythm('x.opus')).toBeNull();
  });

  it('rejects non-positive or non-finite bpm payloads', async () => {
    expect(await clientWith(() => jsonResponse({ bpm: 0, confidence: 1 })).rhythm('x')).toBeNull();
    expect(
      await clientWith(() => jsonResponse({ bpm: 'fast', confidence: 1 })).rhythm('x'),
    ).toBeNull();
  });

  it('defaults a missing confidence to 0', async () => {
    const c = clientWith(() => jsonResponse({ bpm: 120.4 }));
    expect(await c.rhythm('x.opus')).toEqual({ bpm: 120.4, confidence: 0 });
  });
});
