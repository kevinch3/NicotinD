import { describe, it, expect, vi } from 'vitest';
import {
  buildPairingPayload,
  parsePairingPayload,
  probeCandidates,
  claimPairing,
} from './pairing';

describe('buildPairingPayload / parsePairingPayload', () => {
  it('round-trips a payload', () => {
    const raw = buildPairingPayload({
      name: 'desk',
      urls: ['https://desk.tail1234.ts.net'],
      token: 'tok123',
    });
    expect(parsePairingPayload(raw)).toEqual({
      v: 1,
      kind: 'nicotind-pair',
      name: 'desk',
      urls: ['https://desk.tail1234.ts.net'],
      token: 'tok123',
    });
  });

  it('rejects non-NicotinD QR content softly', () => {
    expect(parsePairingPayload('https://some-random-site.example')).toBeNull();
    expect(parsePairingPayload('not json at all')).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ kind: 'other', v: 1, token: 'x' }))).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ kind: 'nicotind-pair', v: 2, token: 'x' }))).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ kind: 'nicotind-pair', v: 1 }))).toBeNull();
  });

  it('drops non-http candidate URLs but keeps the payload', () => {
    const parsed = parsePairingPayload(
      JSON.stringify({
        kind: 'nicotind-pair',
        v: 1,
        token: 'tok',
        urls: ['javascript:alert(1)', 'https://ok.example', 42],
      }),
    );
    expect(parsed?.urls).toEqual(['https://ok.example']);
  });
});

describe('probeCandidates', () => {
  const healthy = () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as Response);
  const unhealthy = () =>
    Promise.resolve({ ok: false, json: () => Promise.resolve(null) } as Response);

  it('returns the first healthy candidate, in order', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(unhealthy)
      .mockImplementationOnce(healthy);
    const url = await probeCandidates(['https://a.example', 'https://b.example'], fetchImpl);
    expect(url).toBe('https://b.example');
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://a.example/api/health', expect.anything());
  });

  it('treats a rejecting fetch as unreachable and moves on', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => Promise.reject(new Error('offline')))
      .mockImplementationOnce(healthy);
    expect(await probeCandidates(['https://a.example', 'https://b.example'], fetchImpl)).toBe(
      'https://b.example',
    );
  });

  it('returns null when nothing answers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(unhealthy);
    expect(await probeCandidates(['https://a.example'], fetchImpl)).toBeNull();
  });
});

describe('claimPairing', () => {
  it('POSTs the credential and returns token + user', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ token: 'jwt', user: { id: 'u1', username: 'alice', role: 'user' } }),
    } as Response);
    const result = await claimPairing('https://desk.example', { token: 'tok' }, fetchImpl);
    expect(result.token).toBe('jwt');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://desk.example/api/devices/claim',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws the server error message on failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Pairing code has expired' }),
    } as Response);
    await expect(claimPairing('https://desk.example', { code: 'ABC234' }, fetchImpl)).rejects.toThrow(
      'Pairing code has expired',
    );
  });
});
