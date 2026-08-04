import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter, map, of } from 'rxjs';
import { APP_VERSION } from '../app.config';
import {
  apkAssetUrl,
  apkFileName,
  parseLatestRelease,
  RELEASES_LATEST_URL,
} from '../lib/apk-update';
import { getCapacitorPlugin, getPlatform, isNativePlatform, isTvUi } from '../lib/platform';
import { compareVersions } from '@nicotind/core';

export type CheckUpdateOutcome = 'unavailable' | 'available' | 'up-to-date';

/** `@nicotind/capacitor-apk-update`'s native plugin (Capacitor global, no
 *  `@capacitor/*` import in the web bundle — the native-capabilities pattern). */
interface ApkUpdatePlugin {
  downloadAndInstall(options: { url: string; fileName: string }): Promise<void>;
  addListener(event: 'apkDownloadProgress', cb: (data: { percent: number }) => void): unknown;
}

@Injectable({ providedIn: 'root' })
export class UpdateService {
  private sw = inject(SwUpdate);
  private version = inject(APP_VERSION);
  private zone = inject(NgZone);

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

  /** Sticky "an update is ready" flag. Sourced directly from the SW version
   * stream via `toSignal` — no manual subscription/teardown. `toSignal` retains
   * the last emitted value, so once VERSION_READY maps to `true` it stays true. */
  readonly updateAvailable = toSignal(
    this.sw.isEnabled
      ? this.sw.versionUpdates.pipe(
          filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'),
          map(() => true),
        )
      : of(false),
    { initialValue: false },
  );

  /** Convenience for templates that want to render the manual control. */
  readonly checkAvailable = computed(() => this.enabled() && !this.updateAvailable());

  constructor() {
    if (this.nativeApk) {
      // zone.run: native callbacks arrive outside Angular's zone (the
      // tv-channels pattern), so the signal write must re-enter it to render.
      getCapacitorPlugin<ApkUpdatePlugin>('NicotindApkUpdate')?.addListener(
        'apkDownloadProgress',
        ({ percent }) => this.zone.run(() => this.downloadProgress.set(percent)),
      );
    }
  }

  async checkForUpdate(): Promise<CheckUpdateOutcome> {
    if (!this.enabled()) return 'unavailable';
    if (this.searching()) return 'unavailable';
    this.searching.set(true);
    try {
      if (this.nativeApk) return await this.checkGithubRelease();
      const found = await this.sw.checkForUpdate();
      return found ? 'available' : 'up-to-date';
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
    await this.sw.activateUpdate();
    if (typeof document !== 'undefined') document.location.reload();
  }
}
