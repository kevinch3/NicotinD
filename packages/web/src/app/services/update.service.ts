import {
  DestroyRef,
  Injectable,
  Injector,
  NgZone,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { APP_VERSION } from '../app.config';
import {
  apkAssetUrl,
  apkFileName,
  isStoreManagedInstaller,
  parseLatestRelease,
  RELEASES_LATEST_URL,
} from '../lib/apk-update';
import { getCapacitorPlugin, getPlatform, isNativePlatform, isTvUi } from '../lib/platform';
import { createVisibilityPoller, type VisibilityPoller } from '../lib/visibility-poller';
import { canApplyUpdateNow } from '../lib/update-policy';
import { compareVersions } from '@nicotind/core';
import { PlayerService } from './player.service';
import { ServerConfigService } from './server-config.service';

export type CheckUpdateOutcome = 'unavailable' | 'available' | 'up-to-date';

/** How often a foregrounded tab re-asks. Paused while hidden — a resume fires
 *  its own check, which is the only "navigation" an installed PWA has. */
const CHECK_INTERVAL_MS = 30 * 60_000;

/** `@nicotind/capacitor-apk-update`'s native plugin (Capacitor global, no
 *  `@capacitor/*` import in the web bundle — the native-capabilities pattern). */
interface ApkUpdatePlugin {
  downloadAndInstall(options: { url: string; fileName: string }): Promise<void>;
  addListener(event: 'apkDownloadProgress', cb: (data: { percent: number }) => void): unknown;
  /** Optional: absent in an older shell than the web bundle it serves. */
  getInstallerPackage?(): Promise<{ installer: string | null }>;
}

@Injectable({ providedIn: 'root' })
export class UpdateService {
  private sw = inject(SwUpdate);
  private version = inject(APP_VERSION);
  private zone = inject(NgZone);
  private player = inject(PlayerService);
  private serverConfig = inject(ServerConfigService);
  private destroyRef = inject(DestroyRef);
  // `start()` is called from the root component, outside this service's own
  // injection context, so the effect below needs the injector explicitly.
  private injector = inject(Injector);

  /** Sideloaded Android/TV shell: no store channel and no service worker, so
   *  "update" means fetching the newer release APK and handing it to the
   *  system installer (the `NicotindApkUpdate` plugin). */
  private readonly nativeApk = isNativePlatform() && getPlatform() === 'android';

  /** False on dev builds and browsers without SW support — unless the native
   * APK path applies, which needs neither. */
  readonly enabled = signal(this.sw.isEnabled || this.nativeApk);

  /** True while a manual `checkForUpdate()` is in flight. Gates duplicate clicks. */
  readonly searching = signal(false);

  /** Newer release found by the native check; what `applyUpdate` will install. */
  readonly pendingApkVersion = signal<string | null>(null);

  /** APK download progress (0–100) while the native plugin streams it, else null. */
  readonly downloadProgress = signal<number | null>(null);

  /**
   * Sticky "an update is ready" flag.
   *
   * Written from three places, because no single one of them is reliable: the
   * `VERSION_READY` event, the resolved value of a `checkForUpdate()` that
   * found something, and the server-version comparison. `versionUpdates` is a
   * plain multicast stream with no replay, so a `VERSION_READY` emitted before
   * this service was first injected — or in a previous app session — is never
   * seen by this one, which is half of why a staged update could sit
   * indefinitely behind a banner that never appeared (#1126).
   */
  private readonly ready = signal(false);
  readonly updateAvailable = this.ready.asReadonly();

  /** True from the moment `applyUpdate` starts until the reload replaces us. */
  readonly applying = signal(false);

  /** Convenience for templates that want to render the manual control. */
  readonly checkAvailable = computed(() => this.enabled() && !this.updateAvailable());

  private poller: VisibilityPoller | null = null;
  private started = false;

  constructor() {
    // Subscribed here, not in `start()`: a VERSION_READY that arrives before
    // the root component has started the loop must still be recorded, and
    // `versionUpdates` has no replay to recover it from afterwards.
    if (this.sw.isEnabled) {
      this.sw.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => {
          this.ready.set(true);
          this.maybeAutoApply();
        });

      // A cache the worker cannot recover from serves a broken app forever. A
      // reload re-registers from scratch, which is the documented way out.
      this.sw.unrecoverable.subscribe(() => this.reload());
    }

    if (this.nativeApk) {
      // zone.run: native callbacks arrive outside Angular's zone (the
      // tv-channels pattern), so the signal write must re-enter it to render.
      getCapacitorPlugin<ApkUpdatePlugin>('NicotindApkUpdate')?.addListener(
        'apkDownloadProgress',
        ({ percent }) => this.zone.run(() => this.downloadProgress.set(percent)),
      );
      void this.hideWhenStoreManaged();
    }
  }

  /**
   * Hide the in-app updater when a store installed this app and will update it
   * itself (#1168).
   *
   * Since there is one APK for both channels, this is a RUNTIME question where
   * it used to be a build flavor: the same binary is sideloaded from GitHub —
   * where self-update is the only path — and installed from our F-Droid
   * repository, where F-Droid is the updater and a second prompt beside it is
   * confusing at best.
   *
   * Starts enabled and disables on the answer rather than waiting for it: the
   * check is a native round-trip, and a settings page that renders nothing
   * until it returns is worse than one whose update row disappears a frame
   * later. Any failure leaves self-update available — the failure mode of
   * guessing wrong the other way is a user stranded on an old build.
   */
  private async hideWhenStoreManaged(): Promise<void> {
    const plugin = getCapacitorPlugin<ApkUpdatePlugin>('NicotindApkUpdate');
    // Optional-chained: a shell older than the web bundle it serves has no such
    // method, and that shell is a sideload anyway.
    if (!plugin?.getInstallerPackage) return;
    try {
      const { installer } = await plugin.getInstallerPackage();
      if (isStoreManagedInstaller(installer)) {
        // zone.run for the same reason as the progress listener above.
        this.zone.run(() => this.enabled.set(false));
      }
    } catch {
      // Unknown installer: leave the in-app path alone.
    }
  }

  /**
   * Start the background update loop. Called once from the root component; a
   * no-op wherever the service worker is disabled (dev, Capacitor, Electron).
   *
   * The Angular service worker checks for updates **only on a navigation
   * request** (`ngsw-worker.js`, `handleFetch`). An installed home-screen app
   * is resumed rather than navigated, and the SPA router handles every route
   * change in-process, so a standalone PWA can run for weeks without a single
   * check. These triggers are the navigations it does not make.
   */
  start(): void {
    if (this.started || !this.sw.isEnabled) return;
    this.started = true;

    this.poller = createVisibilityPoller({
      poll: () => this.backgroundCheck(),
      delayMs: () => CHECK_INTERVAL_MS,
      // Paused while hidden: an iOS standalone app is suspended anyway, and the
      // resume below is worth more than a timer that never fires.
      hiddenDelayMs: () => null,
      pollOnResume: true,
    });
    this.poller.start();

    // Hidden is when an update may actually apply (the rules are in
    // lib/update-policy.ts), so the same transition that pauses the poller is
    // the one that lands the update.
    const onVisibility = (): void => this.maybeAutoApply();
    document.addEventListener('visibilitychange', onVisibility);
    // A bfcache restore can bring the app back with no visibility transition.
    const onPageShow = (): void => void this.backgroundCheck();
    window.addEventListener('pageshow', onPageShow);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      this.poller?.stop();
    });

    // Playback stopping is the other moment a deferred update becomes safe.
    effect(
      () => {
        if (this.player.isPlaying()) return;
        this.maybeAutoApply();
      },
      { injector: this.injector },
    );
  }

  async checkForUpdate(): Promise<CheckUpdateOutcome> {
    if (!this.enabled()) return 'unavailable';
    if (this.searching()) return 'unavailable';
    this.searching.set(true);
    try {
      if (this.nativeApk) return await this.checkGithubRelease();
      // A version already staged is available — full stop. The driver answers
      // `false` for a hash it has already set up (`if (this.versions.has(hash))
      // … return false`), so asking it again about an update it is already
      // holding reports "you're on the latest version" (#1126).
      if (this.ready()) return 'available';
      if (await this.sw.checkForUpdate()) {
        this.ready.set(true);
        return 'available';
      }
      // The worker said no. It can be wrong — a wedged or stale-manifest worker
      // says no forever — and the server knows what it is actually serving.
      if (await this.serverIsNewer()) {
        this.ready.set(true);
        return 'available';
      }
      return 'up-to-date';
    } finally {
      this.searching.set(false);
    }
  }

  private async checkGithubRelease(): Promise<CheckUpdateOutcome> {
    const res = await fetch(RELEASES_LATEST_URL, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub releases API ${res.status}`);
    const latest = parseLatestRelease(await res.json());
    if (!latest) throw new Error('release response has no tag_name');
    if (compareVersions(latest, this.version) > 0) {
      this.pendingApkVersion.set(latest);
      return 'available';
    }
    this.pendingApkVersion.set(null);
    return 'up-to-date';
  }

  /**
   * Is the server serving something newer than the build running here?
   *
   * `GET /api/health` reports the running server version and needs no auth. It
   * is the only signal that survives a service worker holding a stale manifest,
   * which is exactly the state a user reports as "it says I'm up to date".
   * `no-store` so no cache — HTTP or otherwise — can answer for it.
   */
  private async serverIsNewer(): Promise<boolean> {
    try {
      const res = await fetch(this.serverConfig.apiUrl('/api/health'), {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { version?: unknown };
      const served = typeof body.version === 'string' ? body.version : null;
      if (!served || served === 'unknown') return false;
      return compareVersions(served, this.version) > 0;
    } catch {
      return false;
    }
  }

  /** A periodic/resume check. Never reports, never throws — it only stages. */
  private async backgroundCheck(): Promise<void> {
    if (!this.sw.isEnabled || this.ready()) return;
    try {
      if (await this.sw.checkForUpdate()) this.ready.set(true);
      else if (await this.serverIsNewer()) this.ready.set(true);
    } catch {
      // Offline, or the worker is busy. The next tick asks again.
    }
    this.maybeAutoApply();
  }

  private maybeAutoApply(): void {
    if (this.applying()) return;
    const decide = canApplyUpdateNow({
      ready: this.ready(),
      playing: this.player.isPlaying(),
      visible: typeof document === 'undefined' || !document.hidden,
    });
    if (decide) void this.applyUpdate();
  }

  async applyUpdate(): Promise<void> {
    if (this.nativeApk) {
      const version = this.pendingApkVersion();
      const plugin = getCapacitorPlugin<ApkUpdatePlugin>('NicotindApkUpdate');
      if (!version || !plugin) return;
      const tv = isTvUi();
      this.downloadProgress.set(0);
      try {
        await plugin.downloadAndInstall({
          url: apkAssetUrl(version, tv),
          fileName: apkFileName(version, tv),
        });
      } finally {
        this.downloadProgress.set(null);
      }
      return;
    }
    this.applying.set(true);
    try {
      await this.sw.activateUpdate();
    } catch {
      // No version staged here — the "available" came from the server
      // comparison, so a reload is what fetches the newer shell. Deliberately
      // not fatal: the reload below is the recovery.
    }
    this.reload();
  }

  private reload(): void {
    if (typeof document !== 'undefined') document.location.reload();
  }
}
