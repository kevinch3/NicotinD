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

  /**
   * Monotonic count of device *reconnect events* (a transition to connected
   * reported by the OS/browser), not a derived edge on `online`.
   *
   * Signals coalesce: setting `online` false then true before an effect flushes
   * runs that effect once with only the final `true`, so a consumer diffing the
   * value sees no transition and misses the reconnect entirely — which stranded
   * the app in offline mode for a full recovery poll after a quick airplane-mode
   * toggle. A counter can't lose the event: even coalesced writes leave a
   * changed, greater value. Starts at 0, so "no reconnect yet" is distinguishable
   * from "reconnected once".
   */
  readonly reconnects = signal(0);

  private markReconnected(): void {
    this.reconnects.update((n) => n + 1);
  }

  // Resolves once the INITIAL connectivity status is known. On web/Electron the
  // seed is synchronous, so this is already-resolved; on native it settles after
  // the Capacitor plugin's async `getStatus()` resolves (or rejects). The whole
  // point: `SetupService.check()` runs synchronously in the app initializer, but
  // the native seed is a promise — so without awaiting this, `online()` is still
  // the optimistic `true` on an OFFLINE launch, the probe-skipping fast path is
  // missed, and bootstrap blocks on the multi-second HTTP probe (the Android
  // ANR/crash-on-blink this whole service exists to prevent). `whenReady()` is
  // that await seam; it is settled exactly once by whichever init path runs.
  private resolveReady!: () => void;
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  /** A promise that resolves once the initial `online` value has been seeded. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

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
      // stuck reporting "online" forever. initWeb() seeds synchronously and
      // resolves `readyPromise` itself.
      this.initWeb();
      return;
    }
    void Promise.resolve(plugin.getStatus())
      .then((s) => this.online.set(s.connected))
      .catch(() => {
        /* keep optimistic default */
      })
      // Mark ready whether the seed resolved or threw — a failed seed leaves the
      // optimistic default, and blocking `whenReady()` forever would be worse
      // (bootstrap would hang) than proceeding with a best-guess value.
      .finally(() => this.resolveReady());
    void Promise.resolve(
      plugin.addListener('networkStatusChange', (s) => {
        this.online.set(s.connected);
        if (s.connected) this.markReconnected();
      }),
    ).catch(() => {
      /* listener registration is best-effort */
    });
  }

  private initWeb(): void {
    this.online.set(navigator.onLine);
    window.addEventListener('online', () => {
      this.online.set(true);
      this.markReconnected();
    });
    window.addEventListener('offline', () => this.online.set(false));
    // navigator.onLine is synchronous, so the seed is already correct here.
    this.resolveReady();
  }
}
