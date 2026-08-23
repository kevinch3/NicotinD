import { describe, expect, it } from 'bun:test';
import { AudioFeaturesClient, AudioFileRejectedError } from './audio-features-client.js';

const PAYLOAD = {
  version: 1,
  features: { mfcc_0: -665.7, spectral_centroid: 1138.7, swing_ratio: null, bpm: 150.0 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): AudioFeaturesClient {
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
  return new AudioFeaturesClient({
    baseUrl: 'http://analysis:8000/',
    fetchFn,
    healthTtlMs: 60_000,
  });
}

describe('AudioFeaturesClient.descriptors', () => {
  it('posts the relative path and returns version + raw features (nulls kept)', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const c = clientWith((url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse(PAYLOAD);
    });
    const res = await c.descriptors('Artist/Album/song.opus');
    expect(res).toEqual(PAYLOAD);
    expect(calls).toEqual([
      { url: 'http://analysis:8000/descriptors', body: { relPath: 'Artist/Album/song.opus' } },
    ]);
  });

  it('rejects a payload with a non-finite or non-numeric value', async () => {
    const bad = clientWith(() =>
      jsonResponse({ version: 1, features: { ...PAYLOAD.features, bpm: 'fast' } }),
    );
    expect(await bad.descriptors('x.opus')).toBeNull();
    // (NaN/Infinity can't be tested over JSON — they serialise to null, which
    // is the legitimate "undefined stat" value. A boolean is the nearest
    // structurally-wrong shape a misbehaving sidecar could emit.)
    const bool = clientWith(() =>
      jsonResponse({ version: 1, features: { ...PAYLOAD.features, mfcc_0: true } }),
    );
    expect(await bool.descriptors('x.opus')).toBeNull();
  });

  it('rejects a payload without a numeric version or with no features', async () => {
    expect(
      await clientWith(() => jsonResponse({ features: PAYLOAD.features })).descriptors('x.opus'),
    ).toBeNull();
    expect(
      await clientWith(() => jsonResponse({ version: 1, features: {} })).descriptors('x.opus'),
    ).toBeNull();
  });

  it('throws AudioFileRejectedError on 422 so the file is ledgered', async () => {
    const c = clientWith(() => jsonResponse({ detail: 'descriptor analysis failed' }, 422));
    await expect(c.descriptors('x.opus')).rejects.toBeInstanceOf(AudioFileRejectedError);
  });

  it('returns null (never throws) on 404 / 503 / transport failure', async () => {
    expect(await clientWith(() => jsonResponse({}, 404)).descriptors('x.opus')).toBeNull();
    expect(await clientWith(() => jsonResponse({}, 503)).descriptors('x.opus')).toBeNull();
    expect(
      await clientWith(() => {
        throw new Error('ECONNREFUSED');
      }).descriptors('x.opus'),
    ).toBeNull();
  });
});

describe('AudioFeaturesClient.descriptorsSnapshot', () => {
  it('reflects the health probe’s descriptors flag, independent of model status', async () => {
    // A models-less build reports status "unavailable" yet still serves
    // /descriptors — the task must gate on this flag, not on `healthy()`.
    const c = clientWith(() => jsonResponse({ status: 'unavailable', descriptors: true }));
    await c.healthy();
    expect(c.descriptorsSnapshot()).toBe(true);

    const without = clientWith(() => jsonResponse({ status: 'ok', descriptors: false }));
    await without.healthy();
    expect(without.descriptorsSnapshot()).toBe(false);

    const old = clientWith(() => jsonResponse({ status: 'ok' })); // pre-descriptor sidecar
    await old.healthy();
    expect(old.descriptorsSnapshot()).toBe(false);
  });
});
