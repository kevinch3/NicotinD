import { describe, it, expect } from 'bun:test';
import { resolvePort } from './config.js';

describe('resolvePort', () => {
  it('returns file value when env value is undefined', () => {
    expect(resolvePort(undefined, 8484)).toBe(8484);
  });

  it('returns 0 when env value is "0" (ephemeral port regression case)', () => {
    expect(resolvePort('0', 8484)).toBe(0);
  });

  it('returns parsed env value when env value is a valid port string', () => {
    expect(resolvePort('9000', 8484)).toBe(9000);
  });
});
