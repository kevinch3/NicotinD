import { describe, it, expect } from 'vitest';
import {
  applyOverscan,
  loadOverscanPreset,
  setOverscanPreset,
  OVERSCAN_STORAGE_KEY,
} from './tv-overscan';

describe('tv-overscan presets', () => {
  it('defaults to standard on no/invalid/throwing storage', () => {
    expect(loadOverscanPreset({ getItem: () => null })).toBe('standard');
    expect(loadOverscanPreset({ getItem: () => 'bogus' })).toBe('standard');
    expect(
      loadOverscanPreset({
        getItem: () => {
          throw new Error('denied');
        },
      }),
    ).toBe('standard');
  });

  it('round-trips a stored preset', () => {
    let stored: string | null = null;
    const el = document.createElement('html');
    setOverscanPreset('extra', el, { setItem: (_k, v) => (stored = v) });
    expect(stored).toBe('extra');
    expect(loadOverscanPreset({ getItem: () => stored })).toBe('extra');
  });

  it('applies preset values as inline custom properties (off zeroes the insets)', () => {
    const el = document.createElement('html');
    applyOverscan('off', el);
    expect(el.style.getPropertyValue('--tv-overscan-x')).toBe('0px');
    expect(el.style.getPropertyValue('--tv-overscan-y')).toBe('0px');
    applyOverscan('extra', el);
    expect(el.style.getPropertyValue('--tv-overscan-x')).toBe('6vw');
  });

  it('a failing storage write still applies for the session', () => {
    const el = document.createElement('html');
    setOverscanPreset('extra', el, {
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(el.style.getPropertyValue('--tv-overscan-x')).toBe('6vw');
  });

  it('uses the stable storage key', () => {
    expect(OVERSCAN_STORAGE_KEY).toBe('nicotind-tv-overscan');
  });
});
