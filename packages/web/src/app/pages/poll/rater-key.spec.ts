import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubInsecureCrypto } from '../../../testing/insecure-context';
import { getRaterKey } from './rater-key';

describe('getRaterKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('mints and keeps a key on a plain-HTTP origin (no crypto.randomUUID)', () => {
    stubInsecureCrypto();
    const key = getRaterKey();
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(getRaterKey()).toBe(key);
  });
});
