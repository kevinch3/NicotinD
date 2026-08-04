import { Injectable, inject, signal, computed, effect, untracked } from '@angular/core';
import { SystemApiService } from './api/system-api.service';
import type { SetupStatus } from './api/api-types';
import { NetworkStatusService } from './network-status.service';
import { firstValueFrom, timeout } from 'rxjs';

/**
 * Upper bound on how long boot will wait for the native connectivity seed before
 * deciding online-ness. The seed is a local OS query (`@capacitor/network`
 * `getStatus()` reads Android's ConnectivityManager), so it normally settles in
 * a few ms — but if a broken/absent plugin never resolves, this cap makes sure we
 * fall through to the HTTP probe rather than hanging bootstrap forever.
 */
export const NETWORK_SEED_TIMEOUT_MS = 1500;

/**
 * How often to re-probe the server while it is flagged unreachable (device
 * network up, server not answering). Runs ONLY in that state — zero background
 * traffic in normal operation — and is cancelled the moment a probe succeeds.
 * The device-reconnect fast path (see the constructor effect) makes recovery
 * instant after airplane mode; this poll covers the server-side-outage case
 * where no device event will ever fire.
 */
export const SERVER_RECOVERY_POLL_MS = 20_000;

/** Timeout for a single reachability probe (boot + verification + recovery). */
const PROBE_TIMEOUT_MS = 3000;

@Injectable({ providedIn: 'root' })
export class SetupService {
  private api = inject(SystemApiService);
  private network = inject(NetworkStatusService);

  readonly status = signal<SetupStatus | null>(null);
  readonly checked = signal(false);
  // "Device reports a live network but the server didn't answer" — distinct from
  // being disconnected. Set by the probe (boot or mid-session); the two are
  // OR-folded below.
  private readonly serverUnreachable = signal(false);

  // Offline == no live network OR the server is unreachable. A `computed` reads
  // like a plain signal, so every existing `setup.isOffline()` call site is
  // unchanged — but it now recomputes when connectivity flips in EITHER direction
  // mid-session, so the whole UI (library source swap, nav gating, offline
  // banner, redirects) reacts live instead of being frozen at boot time.
  readonly isOffline = computed(() => !this.network.online() || this.serverUnreachable());

  // Single-flight guard: at most one probe in the air. Also what makes
  // reportServerFailure() safe against the probe's own failure re-entering it
  // through the interceptor.
  private verifying = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Reconnect fast path: the device coming back online re-probes IMMEDIATELY
    // when the server is flagged unreachable — so leaving airplane mode/regaining
    // Wi-Fi flips the app back to online mode in one round-trip instead of
    // waiting out the recovery poll — and also when `status` is still null,
    // i.e. an OFFLINE LAUNCH skipped the boot probe entirely and the app has
    // never learned the server's setup state (without this, `needsSetup` stayed
    // unknowable until a full reload). Tracks only the network signal (the rest
    // is read via untracked) and only fires on the offline→online transition.
    let wasOnline = this.network.online();
    effect(() => {
      const online = this.network.online();
      const cameBackOnline = online && !wasOnline;
      wasOnline = online;
      if (cameBackOnline && untracked(() => this.serverUnreachable() || this.status() === null)) {
        void this.verify();
      }
    });
  }

  async check(): Promise<void> {
    // Wait (briefly) for the native connectivity seed to land before deciding.
    // `NetworkStatusService.online` seeds asynchronously on native (the Capacitor
    // plugin's `getStatus()` is a promise), but this runs synchronously in the app
    // initializer right after construction — so without this await, `online()` is
    // still the optimistic `true` on an OFFLINE launch, the fast path below is
    // skipped, and bootstrap blocks on the 3s HTTP probe (the exact ANR/crash this
    // guards against). Bounded so a hung/absent plugin can't reintroduce the hang.
    await this.awaitNetworkSeed();

    // Fast path: the device already reports offline, so skip the HTTP probe
    // entirely. This kills the multi-second blank-screen boot (and the flurry of
    // failing offline requests) that caused the Android release to ANR/crash on
    // an offline launch — `isOffline` is already true via the network signal.
    if (!this.network.online()) {
      this.checked.set(true);
      return;
    }
    await this.verify();
    this.checked.set(true);
  }

  /**
   * Entry point for the interceptor's network-level failure signal (an API call
   * that died without an HTTP status). One flaky request must NOT bounce the
   * whole app into offline mode, so this never flips the flag directly — it
   * fires a verification probe and lets the probe's outcome decide. No-ops when
   * a probe is already in flight, when the app is already flagged unreachable
   * (the recovery poll owns retries — N failing background polls must not turn
   * into N probes), and when the device itself is offline (the network signal
   * already covers that; probing would just add another doomed request).
   */
  reportServerFailure(): void {
    if (this.verifying || this.serverUnreachable() || !this.network.online()) return;
    void this.verify();
  }

  /**
   * Entry point for the interceptor's SUCCESS signal (issue #372): any API
   * request that received a real HTTP response while the app believed the
   * server unreachable is itself the reachability proof — no verification
   * round-trip needed. This heals the app instantly when background traffic
   * (the disk pill, transfers poll, …) reaches a recovered server, instead of
   * waiting out the 20s recovery poll or requiring a device online/offline
   * edge (which never fires for a server-side outage). Only when the setup
   * status was never learned (an offline launch) does it still probe, since
   * `needsSetup` must come from somewhere.
   */
  reportServerSuccess(): void {
    if (!this.serverUnreachable()) return;
    this.serverUnreachable.set(false);
    this.clearRecoveryTimer();
    if (this.status() === null) void this.verify();
  }

  /**
   * One reachability probe, and the single writer of `serverUnreachable` in both
   * directions: success stores the setup status, clears the flag and stops the
   * recovery poll; failure sets the flag and (re)schedules the poll. Boot
   * (`check()`), the interceptor report, the recovery poll and the reconnect
   * effect all converge here, so "how the app decides it is offline/online"
   * exists exactly once.
   */
  private async verify(): Promise<void> {
    if (this.verifying) return;
    this.verifying = true;
    try {
      const status = await firstValueFrom(
        this.api.getSetupStatus().pipe(timeout(PROBE_TIMEOUT_MS)),
      );
      this.status.set(status);
      this.serverUnreachable.set(false);
      this.clearRecoveryTimer();
    } catch {
      // Network says online but the server didn't answer — offline mode, and
      // start (or keep) polling so the app returns to online mode by itself.
      this.serverUnreachable.set(true);
      this.scheduleRecovery();
    } finally {
      this.verifying = false;
    }
  }

  private scheduleRecovery(): void {
    this.clearRecoveryTimer();
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      // Device offline: don't burn a doomed probe — keep the timer armed as a
      // safety net; the reconnect effect fires the instant probe when the
      // network returns.
      if (!this.network.online()) {
        this.scheduleRecovery();
        return;
      }
      void this.verify();
    }, SERVER_RECOVERY_POLL_MS);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /**
   * Await the network seed, but never longer than {@link NETWORK_SEED_TIMEOUT_MS}.
   * On web/Electron (and when the native plugin is missing) the seed is already
   * resolved, so this returns on the next microtask with no real delay; the e2e
   * suite and browser boot are unaffected.
   */
  private async awaitNetworkSeed(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, NETWORK_SEED_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.network.whenReady(), cap]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Records that setup just finished so redirects treat the app as configured. */
  markComplete(): void {
    this.status.set({ needsSetup: false });
  }
}
