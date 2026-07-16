import { describe, it, expect, afterEach, vi } from 'vitest';
import { pickDirectory, platformId, setMusicDir } from './native-capabilities';

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

  it('routes setMusicDir to the electron bridge', async () => {
    const setMusicDirMock = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as { window?: unknown }).window = {
      nicotind: { platform: 'electron', pickDirectory: async () => null, setMusicDir: setMusicDirMock },
    };
    await expect(setMusicDir('/music', { restart: true })).resolves.toEqual({ ok: true });
    expect(setMusicDirMock).toHaveBeenCalledWith('/music', { restart: true });
  });

  it('propagates a failed restart result from the electron bridge', async () => {
    const setMusicDirMock = vi.fn().mockResolvedValue({ ok: false, error: 'boom' });
    (globalThis as { window?: unknown }).window = {
      nicotind: { platform: 'electron', pickDirectory: async () => null, setMusicDir: setMusicDirMock },
    };
    await expect(setMusicDir('/music', { restart: true })).resolves.toEqual({
      ok: false,
      error: 'boom',
    });
  });

  it('setMusicDir is a no-op off-Electron', async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(setMusicDir('/music')).resolves.toEqual({ ok: true });
  });
});
