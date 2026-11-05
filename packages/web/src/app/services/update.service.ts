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
import { APP_BUILD_INFO, APP_VERSION } from '../app.config';
import {
  apkAssetUrl,
  apkFileName,
  isSideloadInstaller,
  parseLatestRelease,
  RELEASES_LATEST_URL,
} from '../lib/apk-update';
import { getCapacitorPlugin, getPlatform, isNativePlatform, isTvUi } from '../lib/platform';
import { createVisibilityPoller, type VisibilityPoller } from '../lib/visibility-poller';
import { canApplyUpdateNow } from '../lib/update-policy';
import {
  afterUpdateReload,
  clearPendingUpdate,
  parseHealth,
  readPendingUpdate,
  resetServiceWorker,
  servedBuildVerdict,
  writePendingUpdate,
  type BuildVerdict,
} from '../lib/update-check';
import { compareVersions } from '@nicotind/core';
import { PlayerService } from './player.service';
import { ServerConfigService } from './server-config.service';

/** `offline`: the server could not be reached, so nothing was checked. */
export type CheckUpdateOutcome = 'unavailable' | 'available' | 'up-to-date' | 'offline';

/** A health probe slower than this is an unreachable server, not a slow answer. */
export const HEALTH_PROBE_TIMEOUT_MS = 8_000;

type ServerProbe =
  { reachable: false } | { reachable: true; verdict: BuildVerdict; commit: string | null };

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
  private build = inject(APP_BUILD_INFO);
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

  /**
   * This boot follows an apply whose outcome is not known yet (`verifyLastApply`).
   * If the reload came back on the old build, the worker's navigation check finds
   * the update again and would raise the strip the user just tapped, right before
   * the verification reloads anyway (#1596). So nothing is offered or applied
   * until it settles.
   */
  private readonly verifying = signal(
    this.sw.isEnabled && readPendingUpdate(localStorage) !== null,
  );

  readonly updateAvailable = computed(() => this.ready() && !this.verifying());

  /** True from the moment `applyUpdate` starts until the reload replaces us. */
  readonly applying = signal(false);

  /**
   * The build the server serves, when the last probe found it differs from ours.
   * Shown on the strip, so a real second update can be told from a failed first.
   */
  readonly targetBuild = signal<string | null>(null);

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
      void this.hideUnlessSideloaded();
    }
  }

  /**
   * Show the in-app updater only for a sideload (#1168, #1503).
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
   * later. A failed answer hides it; a shell too old to have the method keeps
   * it, since such a shell predates F-Droid and can only be a sideload.
   */
  private async hideUnlessSideloaded(): Promise<void> {
    const plugin = getCapacitorPlugin<ApkUpdatePlugin>('NicotindApkUpdate');
    // Optional-chained: a shell older than the web bundle it serves has no such
    // method, and that shell is a sideload anyway.
    if (!plugin?.getInstallerPackage) return;
    try {
      const { installer } = await plugin.getInstallerPackage();
      if (!isSideloadInstaller(installer)) {
        // zone.run for the same reason as the progress listener above.
        this.zone.run(() => this.enabled.set(false));
      }
    } catch {
      // No answer is not a sideload (#1503).
      this.zone.run(() => this.enabled.set(false));
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
    void this.settleLastApply();

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
      // The server first: it is the only side that knows what is being served.
      // The worker answers "no new version" both for a version it already holds
      // and for a manifest it could not fetch, and a version string cannot tell
      // two edge builds of one release apart — the commit can.
      const server = await this.probeServerBuild();
      // Unreachable is not "up to date": nothing was checked, and saying so is
      // how a phone offline reported the old build as current.
      if (!server.reachable) return 'offline';
      if (server.verdict === 'update') {
        this.ready.set(true);
        return 'available';
      }
      // Same build as the server — but a newer one may already be staged.
      if (await this.sw.checkForUpdate()) {
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
   * What build is the server serving, compared with the one running here?
   *
   * `GET /api/health` needs no auth and reports `{ version, commit }`; the
   * verdict is `servedBuildVerdict` (lib/update-check.ts). `no-store` so no
   * cache — HTTP or the worker's — can answer for it, and bounded so a server
   * that never answers reads as unreachable instead of a check that hangs.
   */
  private async probeServerBuild(): Promise<ServerProbe> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), HEALTH_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(this.serverConfig.apiUrl('/api/health'), {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: abort.signal,
      });
      if (!res.ok) return { reachable: false };
      const served = parseHealth(await res.json());
      if (!served) return { reachable: false };
      const verdict = servedBuildVerdict(served, {
        version: this.version,
        commit: this.build.commit,
      });
      this.targetBuild.set(verdict === 'update' ? served.commit : null);
      return { reachable: true, verdict, commit: served.commit };
    } catch {
      return { reachable: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A periodic/resume check. Never reports, never throws — it only stages. */
  private async backgroundCheck(): Promise<void> {
    if (!this.sw.isEnabled || this.ready() || this.verifying()) return;
    try {
      const server = await this.probeServerBuild();
      // Unreachable: the worker's manifest fetch would fail the same way.
      if (!server.reachable) return;
      if (server.verdict === 'update') this.ready.set(true);
      else if (await this.sw.checkForUpdate()) this.ready.set(true);
    } catch {
      // The worker is busy or broken. The next tick asks again.
    }
    this.maybeAutoApply();
  }

  private maybeAutoApply(): void {
    if (this.applying() || this.verifying()) return;
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
    // Remember what this reload should land on, so the next boot can tell
    // whether it did (`verifyLastApply`).
    const target = this.targetBuild();
    writePendingUpdate(localStorage, { commit: target, attempts: 1, at: Date.now() });
    try {
      // When the server found the update, the worker may not have it yet — and a
      // reload is a navigation the worker answers from its OLD cache. Make it
      // fetch the new manifest first; `false` here also means "already staged".
      if (target) await this.sw.checkForUpdate();
    } catch {
      /* the reload, then verifyLastApply, are the recovery */
    }
    try {
      await this.sw.activateUpdate();
    } catch {
      // Nothing staged to activate. Deliberately not fatal: the reload is the
      // recovery, and verifyLastApply escalates if it came back stale.
    }
    this.reload();
  }

  /**
   * The boot after an apply: did the reload land on the build it aimed at?
   *
   * If it came back on the old build, the worker served its stale cache to the
   * navigation. Reset the worker and reload once more — but only after reaching
   * the server, because a reset with no network would leave an installed app
   * with nothing to load. Bounded by `MAX_UPDATE_ATTEMPTS`.
   *
   * Answers whether it reloaded, which leaves this page with nothing more to do.
   */
  private async verifyLastApply(): Promise<boolean> {
    const pending = readPendingUpdate(localStorage);
    if (!pending) return false;
    const action = afterUpdateReload(pending, this.build.commit, Date.now());
    if (action !== 'escalate') {
      clearPendingUpdate(localStorage);
      return false;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    const server = await this.probeServerBuild();
    if (!server.reachable || server.verdict !== 'update') {
      // Unreachable: try again on a later boot. Current: the server moved to
      // this very build in the meantime — nothing left to do.
      if (server.reachable) clearPendingUpdate(localStorage);
      return false;
    }
    writePendingUpdate(localStorage, {
      commit: server.commit,
      attempts: pending.attempts + 1,
      at: Date.now(),
    });
    try {
      await resetServiceWorker();
    } catch {
      /* a failed reset still reloads; the attempt is counted either way */
    }
    this.reload();
    return true;
  }

  private async settleLastApply(): Promise<void> {
    let reloading = false;
    try {
      reloading = await this.verifyLastApply();
    } finally {
      // Left set on a reload: the strip must not flash on the page being replaced.
      if (!reloading) {
        this.verifying.set(false);
        this.maybeAutoApply();
      }
    }
  }

  private reload(): void {
    if (typeof document !== 'undefined') document.location.reload();
  }
}
