import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { SwUpdate, VersionEvent, VersionReadyEvent } from '@angular/service-worker';
import { APP_VERSION } from '../app.config';
import { UpdateService } from './update.service';

function makeSwStub(
  isEnabled: boolean,
  checkForUpdateResult: 'true' | 'false' | 'reject' = 'false',
) {
  const stub = {
    isEnabled,
    versionUpdates: new Subject<VersionEvent>(),
    activateUpdate: vi.fn().mockResolvedValue(true),
    checkForUpdate: vi.fn(),
  };
  if (checkForUpdateResult === 'true') {
    stub.checkForUpdate.mockResolvedValue(true);
  } else if (checkForUpdateResult === 'reject') {
    stub.checkForUpdate.mockRejectedValue(new Error('network'));
  } else {
    stub.checkForUpdate.mockResolvedValue(false);
  }
  return stub;
}

function provide(sw: ReturnType<typeof makeSwStub>) {
  TestBed.configureTestingModule({
    providers: [
      { provide: SwUpdate, useValue: sw },
      { provide: APP_VERSION, useValue: '0.1.300' },
    ],
  });
  return TestBed.inject(UpdateService);
}

const versionReady = {
  type: 'VERSION_READY',
  currentVersion: { hash: 'a' },
  latestVersion: { hash: 'b' },
} as VersionReadyEvent;

describe('UpdateService', () => {
  it('flips updateAvailable to true on a VERSION_READY event', () => {
    const sw = makeSwStub(true);
    const service = provide(sw);
    expect(service.updateAvailable()).toBe(false);

    sw.versionUpdates.next(versionReady);

    expect(service.updateAvailable()).toBe(true);
  });

  it('ignores non-VERSION_READY events', () => {
    const sw = makeSwStub(true);
    const service = provide(sw);

    sw.versionUpdates.next({ type: 'VERSION_DETECTED', version: { hash: 'b' } } as VersionEvent);

    expect(service.updateAvailable()).toBe(false);
  });

  it('stays false when the service worker is disabled', () => {
    const sw = makeSwStub(false);
    const service = provide(sw);

    expect(service.updateAvailable()).toBe(false);
    expect(service.enabled()).toBe(false);
    expect(service.checkAvailable()).toBe(false);
  });

  it('exposes enabled + checkAvailable when the service worker is enabled', () => {
    const sw = makeSwStub(true);
    const service = provide(sw);

    expect(service.enabled()).toBe(true);
    expect(service.checkAvailable()).toBe(true);
  });

  it('hides the manual checker once an update is already staged', () => {
    const sw = makeSwStub(true);
    const service = provide(sw);

    sw.versionUpdates.next(versionReady);

    expect(service.checkAvailable()).toBe(false);
  });

  it('checkForUpdate reports up-to-date when no new version is found', async () => {
    const sw = makeSwStub(true, 'false');
    const service = provide(sw);

    const result = await service.checkForUpdate();

    expect(result).toBe('up-to-date');
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(service.searching()).toBe(false);
  });

  it('checkForUpdate reports available when the SW staged a new version', async () => {
    const sw = makeSwStub(true, 'true');
    const service = provide(sw);

    const result = await service.checkForUpdate();

    expect(result).toBe('available');
    expect(service.searching()).toBe(false);
  });

  it('checkForUpdate returns unavailable without calling the SW when disabled', async () => {
    const sw = makeSwStub(false);
    const service = provide(sw);

    const result = await service.checkForUpdate();

    expect(result).toBe('unavailable');
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
  });

  it('checkForUpdate rejects and clears searching when the SW throws', async () => {
    const sw = makeSwStub(true, 'reject');
    const service = provide(sw);

    await expect(service.checkForUpdate()).rejects.toThrow('network');
    expect(service.searching()).toBe(false);
  });

  it('checkForUpdate is reentrant-safe while a previous check is in flight', async () => {
    let resolveCheck!: (found: boolean) => void;
    const sw = makeSwStub(true);
    sw.checkForUpdate.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const service = provide(sw);

    const first = service.checkForUpdate();
    expect(service.searching()).toBe(true);
    const second = await service.checkForUpdate();

    expect(second).toBe('unavailable');
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);

    resolveCheck(false);
    const firstResult = await first;

    expect(firstResult).toBe('up-to-date');
    expect(service.searching()).toBe(false);
  });

  describe('native APK path (sideloaded Android/TV app)', () => {
    let downloadAndInstall: ReturnType<typeof vi.fn>;
    let fetchMock: ReturnType<typeof vi.fn>;

    function provideNative(currentVersion = '0.1.300', latestTag = 'v0.1.305') {
      downloadAndInstall = vi.fn().mockResolvedValue(undefined);
      (globalThis as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: { NicotindApkUpdate: { downloadAndInstall, addListener: vi.fn() } },
      };
      fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ tag_name: latestTag }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      TestBed.configureTestingModule({
        providers: [
          { provide: SwUpdate, useValue: makeSwStub(false) },
          { provide: APP_VERSION, useValue: currentVersion },
        ],
      });
      return TestBed.inject(UpdateService);
    }

    afterEach(() => {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
      vi.unstubAllGlobals();
      document.documentElement.classList.remove('tv-build');
    });

    it('enables the manual checker on native Android even without a service worker', () => {
      const service = provideNative();
      expect(service.enabled()).toBe(true);
      expect(service.checkAvailable()).toBe(true);
    });

    it('checkForUpdate reads the latest GitHub release and reports available on a newer tag', async () => {
      const service = provideNative('0.1.300', 'v0.1.305');
      const result = await service.checkForUpdate();
      expect(result).toBe('available');
      expect(fetchMock.mock.calls[0][0]).toContain('/releases/latest');
      expect(service.pendingApkVersion()).toBe('0.1.305');
    });

    it('checkForUpdate reports up-to-date when the release matches the running version', async () => {
      const service = provideNative('0.1.305', 'v0.1.305');
      expect(await service.checkForUpdate()).toBe('up-to-date');
      expect(service.pendingApkVersion()).toBeNull();
    });

    it('checkForUpdate rejects on a GitHub API failure and clears searching', async () => {
      const service = provideNative();
      fetchMock.mockResolvedValue(new Response('rate limited', { status: 403 }));
      await expect(service.checkForUpdate()).rejects.toThrow();
      expect(service.searching()).toBe(false);
    });

    it('applyUpdate downloads the phone APK asset via the native plugin', async () => {
      const service = provideNative('0.1.300', 'v0.1.305');
      await service.checkForUpdate();
      await service.applyUpdate();
      expect(downloadAndInstall).toHaveBeenCalledWith({
        url: 'https://github.com/kevinch3/NicotinD/releases/download/v0.1.305/NicotinD-0.1.305.apk',
        fileName: 'NicotinD-0.1.305.apk',
      });
    });

    it('applyUpdate picks the TV APK asset on a tv build', async () => {
      document.documentElement.classList.add('tv-build');
      const service = provideNative('0.1.300', 'v0.1.305');
      await service.checkForUpdate();
      await service.applyUpdate();
      expect(downloadAndInstall).toHaveBeenCalledWith({
        url: 'https://github.com/kevinch3/NicotinD/releases/download/v0.1.305/NicotinD-TV-0.1.305.apk',
        fileName: 'NicotinD-TV-0.1.305.apk',
      });
    });

    it('applyUpdate without a pending version is a no-op (never a blind download)', async () => {
      const service = provideNative();
      await service.applyUpdate();
      expect(downloadAndInstall).not.toHaveBeenCalled();
    });
  });

  it('applyUpdate activates the SW and reloads the document', async () => {
    const sw = makeSwStub(true);
    let activated = false;
    const activateDeferred = new Promise<void>((resolve) => {
      sw.activateUpdate.mockImplementation(async () => {
        activated = true;
        resolve();
        return true;
      });
    });
    const service = provide(sw);
    const inFlight = service.applyUpdate();
    await activateDeferred;
    expect(activated).toBe(true);
    await inFlight;
    expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
  });
});
