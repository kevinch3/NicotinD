import { describe, it, expect, afterEach } from 'vitest';
import {
  isNativePlatform,
  getPlatform,
  isIosNative,
  getCapacitorPlugin,
  isElectron,
  isNativeShell,
  serviceWorkerEnabled,
} from './platform';

type CapStub = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
};

function setCapacitor(stub: CapStub | undefined): void {
  (globalThis as { Capacitor?: CapStub }).Capacitor = stub;
}

afterEach(() => {
  delete (globalThis as { Capacitor?: CapStub }).Capacitor;
  delete (globalThis as { window?: unknown }).window;
});

describe('platform helpers', () => {
  it('reports web when Capacitor is absent', () => {
    setCapacitor(undefined);
    expect(isNativePlatform()).toBe(false);
    expect(getPlatform()).toBe('web');
    expect(isIosNative()).toBe(false);
    expect(getCapacitorPlugin('Anything')).toBeNull();
  });

  it('detects native iOS', () => {
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'ios' });
    expect(isIosNative()).toBe(true);
  });

  it('is not iOS-native on Android or in the mobile browser', () => {
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'android' });
    expect(isIosNative()).toBe(false);

    // Browser that somehow exposes getPlatform but is not a native shell.
    setCapacitor({ isNativePlatform: () => false, getPlatform: () => 'ios' });
    expect(isIosNative()).toBe(false);
  });

  it('returns a registered plugin by name', () => {
    const plugin = { setMetadata: () => Promise.resolve() };
    setCapacitor({ Plugins: { NicotindNowPlaying: plugin } });
    expect(getCapacitorPlugin('NicotindNowPlaying')).toBe(plugin);
    expect(getCapacitorPlugin('Missing')).toBeNull();
  });

  it('detects Electron via the injected window.nicotind bridge', () => {
    (globalThis as { window?: unknown }).window = {
      nicotind: { platform: 'electron', pickDirectory: async () => null },
    };
    expect(isElectron()).toBe(true);
    expect(isNativeShell()).toBe(true);
  });

  it('is not Electron when window.nicotind is absent', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(isElectron()).toBe(false);
  });

  it('isNativeShell is true for Capacitor native without Electron', () => {
    (globalThis as { window?: unknown }).window = {};
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'android' });
    expect(isNativeShell()).toBe(true);
  });

  it('isNativeShell is false on plain web', () => {
    (globalThis as { window?: unknown }).window = {};
    setCapacitor(undefined);
    expect(isNativeShell()).toBe(false);
  });

  it('serviceWorkerEnabled: on in prod browser, off in dev, off in any native shell', () => {
    expect(serviceWorkerEnabled(false, false)).toBe(true);
    expect(serviceWorkerEnabled(false, true)).toBe(false);
    expect(serviceWorkerEnabled(true, false)).toBe(false);
  });
});
