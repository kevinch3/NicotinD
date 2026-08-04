import { describe, it, expect, afterEach } from 'vitest';
import {
  isNativePlatform,
  getPlatform,
  isIosNative,
  getCapacitorPlugin,
  isElectron,
  isNativeShell,
  serviceWorkerEnabled,
  isCoarsePointer,
  isTvBuild,
  isTvUi,
  applyTvBuildClass,
  resolveTvDefaultedPreference,
} from './platform';
import { environment } from '../../environments/environment';

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

  it('isTvBuild reads environment.tvBuild', () => {
    const original = environment.tvBuild;
    try {
      (environment as { tvBuild: boolean }).tvBuild = true;
      expect(isTvBuild()).toBe(true);
      (environment as { tvBuild: boolean }).tvBuild = false;
      expect(isTvBuild()).toBe(false);
    } finally {
      (environment as { tvBuild: boolean }).tvBuild = original;
    }
  });

  describe('applyTvBuildClass', () => {
    it('adds the tv-build class on a TV build (idempotently)', () => {
      const el = document.createElement('html');
      applyTvBuildClass(el, true);
      applyTvBuildClass(el, true);
      expect(el.classList.contains('tv-build')).toBe(true);
      expect(el.className).toBe('tv-build');
    });

    it('leaves the element untouched on a non-TV build', () => {
      const el = document.createElement('html');
      applyTvBuildClass(el, false);
      expect(el.classList.contains('tv-build')).toBe(false);
    });
  });

  describe('isTvUi', () => {
    afterEach(() => document.documentElement.classList.remove('tv-build'));

    it('is true iff the document root carries the tv-build class', () => {
      expect(isTvUi()).toBe(false);
      document.documentElement.classList.add('tv-build');
      expect(isTvUi()).toBe(true);
    });
  });

  describe('resolveTvDefaultedPreference', () => {
    it('defaults to true on a TV build with no stored preference', () => {
      expect(resolveTvDefaultedPreference(null, true)).toBe(true);
    });

    it('does not default on a non-TV build with no stored preference', () => {
      expect(resolveTvDefaultedPreference(null, false)).toBe(false);
    });

    it('an explicit stored "false" always wins over a TV-build default', () => {
      expect(resolveTvDefaultedPreference('false', true)).toBe(false);
    });

    it('an explicit stored "true" wins on a non-TV build too', () => {
      expect(resolveTvDefaultedPreference('true', false)).toBe(true);
    });
  });
});

describe('isCoarsePointer', () => {
  afterEach(() => {
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  it('is false when matchMedia is unavailable (jsdom, SSR)', () => {
    expect(isCoarsePointer()).toBe(false);
  });

  it('reflects the (pointer: coarse) media query', () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({
      matches: q === '(pointer: coarse)',
    });
    expect(isCoarsePointer()).toBe(true);
  });
});
