import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  classifyScanError,
  pickDirectory,
  platformId,
  scanBarcode,
  setMusicDir,
} from './native-capabilities';

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

describe('scanBarcode', () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  function withScannerPlugin(impl: (options: unknown) => Promise<{ ScanResult?: string }>) {
    const scanMock = vi.fn(impl);
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: { CapacitorBarcodeScanner: { scanBarcode: scanMock } },
    };
    return scanMock;
  }

  it('passes every option the raw bridge requires (iOS rejects sparse calls)', async () => {
    const scanMock = withScannerPlugin(async () => ({ ScanResult: 'payload' }));
    await expect(scanBarcode()).resolves.toEqual({ status: 'ok', value: 'payload' });
    expect(scanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: 0,
        scanInstructions: expect.any(String),
        scanButton: false,
        scanText: expect.any(String),
        cameraDirection: 1,
        scanOrientation: 3,
      }),
    );
  });

  it('is unavailable off-native', async () => {
    await expect(scanBarcode()).resolves.toEqual({ status: 'unavailable' });
  });

  it('maps an empty result to cancelled and rejections to typed outcomes', async () => {
    withScannerPlugin(async () => ({}));
    await expect(scanBarcode()).resolves.toEqual({ status: 'cancelled' });
    withScannerPlugin(async () => Promise.reject(new Error('Scanning cancelled')));
    await expect(scanBarcode()).resolves.toEqual({ status: 'cancelled' });
    withScannerPlugin(async () => Promise.reject(new Error('Camera access denied')));
    await expect(scanBarcode()).resolves.toEqual({ status: 'denied' });
  });

  it('classifyScanError falls through to error with the message', () => {
    expect(classifyScanError('boom')).toEqual({ status: 'error', message: 'boom' });
    expect(classifyScanError('OS-PLUG-BARC-0007 permission missing')).toEqual({
      status: 'denied',
    });
  });
});
