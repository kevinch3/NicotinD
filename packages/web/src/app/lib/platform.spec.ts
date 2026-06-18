import { describe, it, expect, afterEach } from 'vitest';
import { isNativePlatform, getPlatform, isIosNative, getCapacitorPlugin } from './platform';

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
});
