import { describe, it, expect, vi } from 'vitest';
import {
  buildPairingPayload,
  buildPairingLink,
  parsePairingParams,
  parsePairingPayload,
  probeCandidates,
  claimPairing,
} from './pairing';

describe('buildPairingLink / parsePairingPayload (URL form)', () => {
  it('round-trips a link through the scanner parse path', () => {
    const link = buildPairingLink({
      name: 'desk',
      urls: ['https://desk.tail1234.ts.net', 'https://music.example.com'],
      token: 'tok123',
    });
    expect(link).toBe(
      'https://desk.tail1234.ts.net/pair#t=tok123&u=https%3A%2F%2Fmusic.example.com&n=desk',
    );
    expect(parsePairingPayload(link)).toEqual({
      v: 1,
      kind: 'nicotind-pair',
      name: 'desk',
      urls: ['https://desk.tail1234.ts.net', 'https://music.example.com'],
      token: 'tok123',
    });
  });

  it('keeps the token in the fragment, never the query', () => {
    const link = buildPairingLink({ urls: ['https://a.example'], token: 'secret' });
    expect(new URL(link).search).toBe('');
    expect(new URL(link).hash).toContain('t=secret');
  });

  it('rejects a URL that is not a /pair link', () => {
    expect(parsePairingPayload('https://a.example/?t=tok')).toBeNull();
    expect(parsePairingPayload('https://a.example/pair')).toBeNull(); // no token
  });
});

describe('parsePairingParams', () => {
  it('parses a fragment string with origin as the primary candidate', () => {
    expect(parsePairingParams('#t=tok&u=https%3A%2F%2Fb.example', 'https://a.example')).toEqual({
      token: 'tok',
      urls: ['https://a.example', 'https://b.example'],
      name: undefined,
    });
  });

  it('parses query form and returns null without a token', () => {
    expect(parsePairingParams('?t=tok&n=desk')?.name).toBe('desk');
    expect(parsePairingParams('#n=desk')).toBeNull();
    expect(parsePairingParams('')).toBeNull();
  });

  it('drops non-http extra candidates', () => {
    expect(parsePairingParams('#t=tok&u=javascript%3Aalert(1)', 'https://a.example')?.urls).toEqual([
      'https://a.example',
    ]);
  });
});

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
