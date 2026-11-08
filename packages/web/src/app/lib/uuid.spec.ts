import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubInsecureCrypto } from '../../testing/insecure-context';
import { randomUuid } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a v4 UUID in a secure context', () => {
    expect(randomUuid()).toMatch(V4);
  });

  // Plain-HTTP LAN origins are how most self-hosters first connect; there
  // crypto.randomUUID is undefined and calling it throws.
  it('still returns a v4 UUID when crypto.randomUUID is missing', () => {
    stubInsecureCrypto();
    expect(typeof (crypto as Partial<Crypto>).randomUUID).toBe('undefined');
    expect(randomUuid()).toMatch(V4);
  });

  it('does not repeat itself in the fallback', () => {
    stubInsecureCrypto();
    const ids = new Set(Array.from({ length: 500 }, () => randomUuid()));
    expect(ids.size).toBe(500);
  });
});
