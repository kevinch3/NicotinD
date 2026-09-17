import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import {
  SwUpdate,
  UnrecoverableStateEvent,
  VersionEvent,
  VersionReadyEvent,
} from '@angular/service-worker';
import { APP_VERSION } from '../app.config';
import { UpdateService } from './update.service';

function makeSwStub(
  isEnabled: boolean,
  checkForUpdateResult: 'true' | 'false' | 'reject' = 'false',
) {
  const stub = {
    isEnabled,
    versionUpdates: new Subject<VersionEvent>(),
    unrecoverable: new Subject<UnrecoverableStateEvent>(),
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

/**
 * `checkForUpdate` falls back to `GET /api/health` when the worker says no, so
 * every browser-path test needs a served version. Default: the same version the
 * app is running, i.e. "the server agrees you are current".
 */
function stubHealth(servedVersion: string | null = '0.1.300'): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true, version: servedVersion ?? 'unknown' }), {
      status: 200,
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function provide(sw: ReturnType<typeof makeSwStub>, servedVersion: string | null = '0.1.300') {
  stubHealth(servedVersion);
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

    /**
     * #1168: one APK now serves both channels, so who installed the app decides
     * whether the in-app updater appears — a runtime question where it used to
     * be a build flavor.
     */
    function provideNativeWithInstaller(installer: string | null) {
      downloadAndInstall = vi.fn().mockResolvedValue(undefined);
      (globalThis as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {
          NicotindApkUpdate: {
            downloadAndInstall,
            addListener: vi.fn(),
            getInstallerPackage: vi.fn().mockResolvedValue({ installer }),
          },
        },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ tag_name: 'v0.1.305' }))),
      );
      TestBed.configureTestingModule({
        providers: [
          { provide: SwUpdate, useValue: makeSwStub(false) },
          { provide: APP_VERSION, useValue: '0.1.300' },
        ],
      });
      return TestBed.inject(UpdateService);
    }

    it('hides itself when F-Droid installed the app — F-Droid updates it', async () => {
      const service = provideNativeWithInstaller('org.fdroid.fdroid');
      // Starts enabled and disables on the answer: the check is a native
      // round-trip, so the initial render must not block on it.
      expect(service.enabled()).toBe(true);
      await vi.waitFor(() => expect(service.enabled()).toBe(false));
    });

    it('stays enabled for a sideload, where it is the only update path', async () => {
      const service = provideNativeWithInstaller(null);
      await vi.waitFor(() =>
        expect(
          (
            globalThis as {
              Capacitor?: {
                Plugins: {
                  NicotindApkUpdate: { getInstallerPackage: { mock: { calls: unknown[] } } };
                };
              };
            }
          ).Capacitor!.Plugins.NicotindApkUpdate.getInstallerPackage.mock.calls.length,
        ).toBe(1),
      );
      expect(service.enabled()).toBe(true);
    });

    it('stays enabled in a shell too old to answer', async () => {
      // The web bundle can be newer than the APK shell serving it; an absent
      // method must not take the only update path away from a sideload.
      const service = provideNative();
      await Promise.resolve();
      expect(service.enabled()).toBe(true);
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

  describe('a staged update must never report "up to date" (#1126)', () => {
    it('reports available for a version already staged, without re-asking the worker', async () => {
      // The driver answers `false` for a hash it has already set up, so the
      // second press of "Check for updates" used to say "you're on the latest
      // version" while the new build sat downloaded and waiting.
      const sw = makeSwStub(true, 'false');
      const service = provide(sw);
      sw.versionUpdates.next(versionReady);

      expect(await service.checkForUpdate()).toBe('available');
      expect(sw.checkForUpdate).not.toHaveBeenCalled();
    });

    it('believes the server over a worker that reports no new version', async () => {
      const sw = makeSwStub(true, 'false');
      const service = provide(sw, '0.1.301');

      expect(await service.checkForUpdate()).toBe('available');
      expect(service.updateAvailable()).toBe(true);
    });

    it('stays up-to-date when the worker and the server both agree', async () => {
      const sw = makeSwStub(true, 'false');
      const service = provide(sw, '0.1.300');

      expect(await service.checkForUpdate()).toBe('up-to-date');
      expect(service.updateAvailable()).toBe(false);
    });

    it('ignores an older or unknown server version', async () => {
      const older = provide(makeSwStub(true, 'false'), '0.1.299');
      expect(await older.checkForUpdate()).toBe('up-to-date');

      TestBed.resetTestingModule();
      const unknown = provide(makeSwStub(true, 'false'), null);
      expect(await unknown.checkForUpdate()).toBe('up-to-date');
    });

    it('survives an unreachable server rather than reporting an update', async () => {
      const sw = makeSwStub(true, 'false');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      TestBed.configureTestingModule({
        providers: [
          { provide: SwUpdate, useValue: sw },
          { provide: APP_VERSION, useValue: '0.1.300' },
        ],
      });
      const service = TestBed.inject(UpdateService);

      expect(await service.checkForUpdate()).toBe('up-to-date');
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
