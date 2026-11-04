import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import {
  SwUpdate,
  UnrecoverableStateEvent,
  VersionEvent,
  VersionReadyEvent,
} from '@angular/service-worker';
import { APP_BUILD_INFO, APP_VERSION } from '../app.config';
import { resolveBuildInfo } from '../lib/build-info';
import { PENDING_UPDATE_KEY, readPendingUpdate } from '../lib/update-check';
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
    // The worker is asked once the server probe has answered.
    await vi.waitFor(() => expect(sw.checkForUpdate).toHaveBeenCalledTimes(1));

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

    // #1503: root/Shizuku installs of F-Droid clients report these.
    for (const installer of ['com.android.shell', null]) {
      it(`hides itself for installer ${installer} — not a sideload`, async () => {
        const service = provideNativeWithInstaller(installer);
        await vi.waitFor(() => expect(service.enabled()).toBe(false));
      });
    }

    it('stays enabled for a sideload, where it is the only update path', async () => {
      const service = provideNativeWithInstaller('com.google.android.packageinstaller');
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

    it('reports an unreachable server as offline — never as up to date', async () => {
      const sw = makeSwStub(true, 'false');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      TestBed.configureTestingModule({
        providers: [
          { provide: SwUpdate, useValue: sw },
          { provide: APP_VERSION, useValue: '0.1.300' },
        ],
      });
      const service = TestBed.inject(UpdateService);

      // "Up to date" here is how a phone with no route to the server reported
      // its old build as current: nothing was checked, so say that.
      expect(await service.checkForUpdate()).toBe('offline');
      expect(service.updateAvailable()).toBe(false);
      // The worker's manifest fetch would fail the same way: not asked.
      expect(sw.checkForUpdate).not.toHaveBeenCalled();
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

  describe('the build decides, not the version string', () => {
    const RUNNING = 'b591028d0885ed50e49ef38c9d3852a029f8431a';
    const SERVED = '37eae47aaba5e5233efdd2abd49b49305385cdc5';

    function provideBuild(
      sw: ReturnType<typeof makeSwStub>,
      health: { status?: number; version?: string; commit?: string | null } = {},
    ) {
      const fetchMock = vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              version: health.version ?? '0.1.300',
              commit: health.commit === undefined ? SERVED : health.commit,
            }),
            { status: health.status ?? 200 },
          ),
      );
      vi.stubGlobal('fetch', fetchMock);
      TestBed.configureTestingModule({
        providers: [
          { provide: SwUpdate, useValue: sw },
          { provide: APP_VERSION, useValue: '0.1.300' },
          { provide: APP_BUILD_INFO, useValue: resolveBuildInfo(RUNNING) },
        ],
      });
      return { service: TestBed.inject(UpdateService), fetchMock };
    }

    beforeEach(() => localStorage.removeItem(PENDING_UPDATE_KEY));

    it('reports an edge build of the same version as an update', async () => {
      // The reported case: server on 37eae47, phone on b591028, both "0.8.119",
      // and a worker that says there is nothing new.
      const sw = makeSwStub(true, 'false');
      const { service } = provideBuild(sw);

      expect(await service.checkForUpdate()).toBe('available');
      expect(service.updateAvailable()).toBe(true);
    });

    it('is up to date when the server serves this very build', async () => {
      const sw = makeSwStub(true, 'false');
      const { service } = provideBuild(sw, { commit: RUNNING.slice(0, 7) });

      expect(await service.checkForUpdate()).toBe('up-to-date');
      // Same build, so the worker is still asked about a staged newer one.
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    });

    it('treats a health endpoint that errors as offline', async () => {
      const { service } = provideBuild(makeSwStub(true, 'false'), { status: 502 });
      expect(await service.checkForUpdate()).toBe('offline');
    });

    it('applying a server-found update makes the worker fetch it before reloading', async () => {
      const sw = makeSwStub(true, 'false');
      const { service } = provideBuild(sw);
      await service.checkForUpdate();
      sw.checkForUpdate.mockClear();

      await service.applyUpdate();

      expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(sw.checkForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        sw.activateUpdate.mock.invocationCallOrder[0],
      );
      expect(readPendingUpdate(localStorage)).toEqual(
        expect.objectContaining({ commit: SERVED, attempts: 1 }),
      );
    });

    describe('verifying the reload landed', () => {
      let unregister: ReturnType<typeof vi.fn>;
      let deleteCache: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        unregister = vi.fn().mockResolvedValue(true);
        deleteCache = vi.fn().mockResolvedValue(true);
        vi.stubGlobal('caches', {
          keys: vi.fn().mockResolvedValue(['ngsw:/:1:assets:app:cache', 'other-cache']),
          delete: deleteCache,
        });
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          value: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
        });
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      });

      const pending = (commit: string, attempts: number) =>
        localStorage.setItem(
          PENDING_UPDATE_KEY,
          JSON.stringify({ commit, attempts, at: Date.now() }),
        );

      it('forgets the record once the reload landed on the target build', async () => {
        pending(RUNNING, 1);
        const { service } = provideBuild(makeSwStub(true, 'false'), { commit: RUNNING });
        service.start();

        await vi.waitFor(() => expect(readPendingUpdate(localStorage)).toBeNull());
        expect(unregister).not.toHaveBeenCalled();
      });

      it('resets the worker once when the reload came back on the old build', async () => {
        pending(SERVED, 1);
        const { service } = provideBuild(makeSwStub(true, 'false'));
        service.start();

        await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(1));
        // Only the worker's own caches: offline downloads are IndexedDB.
        await vi.waitFor(() =>
          expect(deleteCache).toHaveBeenCalledWith('ngsw:/:1:assets:app:cache'),
        );
        expect(deleteCache).not.toHaveBeenCalledWith('other-cache');
        expect(readPendingUpdate(localStorage)).toEqual(
          expect.objectContaining({ commit: SERVED, attempts: 2 }),
        );
      });

      it('never resets the worker while offline — the record waits for a later boot', async () => {
        pending(SERVED, 1);
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
        const { service } = provideBuild(makeSwStub(true, 'false'));
        service.start();
        await new Promise((r) => setTimeout(r, 0));

        expect(unregister).not.toHaveBeenCalled();
        expect(readPendingUpdate(localStorage)).not.toBeNull();
      });

      it('gives up after the reset attempt instead of reloading forever', async () => {
        pending(SERVED, 2);
        const { service } = provideBuild(makeSwStub(true, 'false'));
        service.start();

        await vi.waitFor(() => expect(readPendingUpdate(localStorage)).toBeNull());
        expect(unregister).not.toHaveBeenCalled();
      });
    });
  });
});
