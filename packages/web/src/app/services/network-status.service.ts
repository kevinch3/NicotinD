import { Injectable, signal } from '@angular/core';
import { getCapacitorPlugin, isNativePlatform } from '../lib/platform';

/** Minimal shape of the `@capacitor/network` plugin — reached via the global
 * `Capacitor.Plugins` (see network path below) rather than an `import`, so the
 * shared web `dist/` stays free of native deps (same convention as `lib/platform.ts`). */
interface NetworkStatus {
  connected: boolean;
  connectionType?: string;
}
interface PluginListenerHandle {
  remove: () => void | Promise<void>;
}
interface NetworkPlugin {
  getStatus(): Promise<NetworkStatus>;
  addListener(
    event: 'networkStatusChange',
    cb: (status: NetworkStatus) => void,
  ): Promise<PluginListenerHandle> | PluginListenerHandle;
}

/**
 * Live device connectivity as a single `online` signal.
 *
 * Native (Capacitor): reads `@capacitor/network` (seeded via `getStatus()` — no
 * server round-trip — and kept live via `networkStatusChange`). The Android
 * WebView's `navigator.onLine` is unreliable (often stuck `true`), which is why
 * native must use the plugin.
 *
 * Web / Electron: `navigator.onLine` + window `online`/`offline` events.
 *
 * This replaces the app's previous boot-only offline inference: `SetupService`
 * folds this signal into `isOffline`, so the whole UI reacts to connectivity
 * changes in both directions mid-session (not just at launch). It is also the
 * fast-path that lets an offline launch skip the multi-second setup probe that
 * caused the Android ANR/crash.
 */
@Injectable({ providedIn: 'root' })
export class NetworkStatusService {
  // Optimistic default: assume online until proven otherwise, so a first paint
  // never wrongly shows the offline surface before the seed resolves.
  readonly online = signal(true);

  constructor() {
    if (isNativePlatform()) {
      this.initNative();
    } else {
      this.initWeb();
    }
  }

  private initNative(): void {
    const plugin = getCapacitorPlugin<NetworkPlugin>('Network');
    if (!plugin) {
      // Plugin missing (e.g. an older shell without @capacitor/network) — fall
      // back to the web listeners so we can still detect drops rather than being
      // stuck reporting "online" forever.
      this.initWeb();
      return;
    }
    void Promise.resolve(plugin.getStatus())
      .then((s) => this.online.set(s.connected))
      .catch(() => {
        /* keep optimistic default */
      });
    void Promise.resolve(
      plugin.addListener('networkStatusChange', (s) => this.online.set(s.connected)),
    ).catch(() => {
      /* listener registration is best-effort */
    });
  }

  private initWeb(): void {
    this.online.set(navigator.onLine);
    window.addEventListener('online', () => this.online.set(true));
    window.addEventListener('offline', () => this.online.set(false));
  }
}
