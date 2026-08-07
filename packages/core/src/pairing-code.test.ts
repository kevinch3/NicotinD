import { describe, expect, it } from 'bun:test';
import { CODE_ALPHABET, CODE_LENGTH, isPairingCodeShape } from './pairing-code.js';

describe('pairing code alphabet', () => {
  it('excludes the characters a human confuses (0/O/1/I)', () => {
    for (const ambiguous of ['0', 'O', '1', 'I']) {
      expect(CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('is 32 symbols — the entropy the TTL + rate limiter are sized against', () => {
    expect(CODE_ALPHABET.length).toBe(32);
    expect(new Set(CODE_ALPHABET).size).toBe(32);
  });
});

describe('isPairingCodeShape', () => {
  it('accepts a well-formed code', () => {
    expect(isPairingCodeShape('ABC234')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isPairingCodeShape('  abc234 ')).toBe(true);
  });

  it('rejects the excluded ambiguous characters', () => {
    expect(isPairingCodeShape('ABC2O4')).toBe(false);
    expect(isPairingCodeShape('ABC2I4')).toBe(false);
  });

  it('rejects wrong lengths', () => {
    expect(isPairingCodeShape('ABC23')).toBe(false);
    expect(isPairingCodeShape('ABC2345')).toBe(false);
    expect(isPairingCodeShape('')).toBe(false);
  });

  it('accepts every symbol the alphabet actually mints', () => {
    for (const ch of CODE_ALPHABET) {
      expect(isPairingCodeShape(ch.repeat(CODE_LENGTH))).toBe(true);
    }
  });
});
