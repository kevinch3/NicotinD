import { describe, it, expect, afterEach } from 'vitest';
import { pickDirectory, platformId } from './native-capabilities';

describe('native-capabilities', () => {
  afterEach(() => {
    delete (globalThis as { nicotind?: unknown }).nicotind;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('routes pickDirectory to the electron bridge', async () => {
    (globalThis as { window?: unknown }).window = {
      nicotind: { platform: 'electron', pickDirectory: async () => '/music' },
    };
    await expect(pickDirectory()).resolves.toBe('/music');
    expect(platformId()).toBe('electron');
  });

  it('returns null off-Electron', async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(pickDirectory()).resolves.toBeNull();
  });

  it('returns null for Capacitor (no native dir picker yet)', async () => {
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    };
    await expect(pickDirectory()).resolves.toBeNull();
    expect(platformId()).toBe('android');
  });

  it('reports web platformId when neither Electron nor Capacitor is present', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(platformId()).toBe('web');
  });
});
