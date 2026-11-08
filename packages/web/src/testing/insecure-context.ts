import { vi } from 'vitest';

/**
 * Make `crypto` look like it does on a plain-HTTP LAN origin (#1724):
 * `getRandomValues` exists everywhere, but `randomUUID` exists only in a
 * secure context (HTTPS or localhost). Undo with `vi.unstubAllGlobals()`.
 */
export function stubInsecureCrypto(): void {
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
}
