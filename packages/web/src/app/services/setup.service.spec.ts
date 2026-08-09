import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { Observable, of, throwError } from 'rxjs';
import { SetupService, SERVER_RECOVERY_POLL_MS } from './setup.service';
import { SystemApiService } from './api/system-api.service';
import { NetworkStatusService } from './network-status.service';
import type { SetupStatus } from './api/api-types';

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeApi(getSetupStatus: () => ReturnType<SystemApiService['getSetupStatus']>) {
  return { getSetupStatus: vi.fn(getSetupStatus) } as unknown as SystemApiService & {
    getSetupStatus: ReturnType<typeof vi.fn>;
  };
}

function configure(
  online: boolean,
  api: ReturnType<typeof makeApi>,
  whenReady: () => Promise<void> = () => Promise.resolve(),
) {
  const reconnects = signal(0);
  const onlineSig = signal(online);
  // Mirrors the real service: a transition to connected bumps the counter (the
  // reconnect *event*), which is what SetupService reacts to.
  const net = {
    online: onlineSig,
    reconnects,
    whenReady,
    /** Test helper: simulate the device reporting a connectivity change. */
    setOnline(v: boolean) {
      onlineSig.set(v);
      if (v) reconnects.update((n) => n + 1);
    },
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      SetupService,
      { provide: SystemApiService, useValue: api },
      { provide: NetworkStatusService, useValue: net as unknown as NetworkStatusService },
    ],
  });
  return { svc: TestBed.inject(SetupService), net };
}

const okStatus = (needsSetup: boolean) => () => of({ needsSetup } as SetupStatus);

describe('SetupService', () => {
  it('skips the HTTP probe entirely and is offline when the device reports offline', async () => {
    // Regression: an offline launch previously blocked bootstrap on a ~3s setup
    // probe (blank WebView → Android ANR). Offline is now known up front.
    const api = makeApi(okStatus(false));
    const { svc } = configure(false, api);

    await svc.check();

    expect(api.getSetupStatus).not.toHaveBeenCalled();
    expect(svc.isOffline()).toBe(true);
    expect(svc.checked()).toBe(true);
  });

  it('waits for the async native seed before deciding, then skips the probe when it lands offline', async () => {
    // The real ANR: on native the `online` signal seeds asynchronously (Capacitor
    // `getStatus()` is a promise), so at the instant `check()` runs it's still the
    // optimistic `true`. Without awaiting the seed the fast path is missed and boot
    // blocks on the 3s probe. Here `online` starts `true` and only flips to `false`
    // when `whenReady` resolves — check() must observe the flip and skip the probe.
    const api = makeApi(okStatus(false));
    let resolveSeed!: () => void;
    const seeded = new Promise<void>((r) => (resolveSeed = r));
    const { svc, net } = configure(true, api, () => seeded);

    const done = svc.check();
    // Seed lands: device is actually offline.
    net.setOnline(false);
    resolveSeed();
    await done;

    expect(api.getSetupStatus).not.toHaveBeenCalled();
    expect(svc.isOffline()).toBe(true);
    expect(svc.checked()).toBe(true);
  });

  it('does not hang boot when the native seed never resolves (falls through to the probe)', async () => {
    // A broken/absent plugin whose `getStatus()` never settles must not wedge
    // bootstrap — the bounded wait falls through and the online probe still runs.
    vi.useFakeTimers();
    try {
      const api = makeApi(okStatus(true));
      const { svc } = configure(true, api, () => new Promise<void>(() => {}));

      const done = svc.check();
      await vi.runAllTimersAsync();
      await done;

      expect(api.getSetupStatus).toHaveBeenCalled();
      expect(svc.checked()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('probes and is online when the server is reachable', async () => {
    const api = makeApi(okStatus(true));
    const { svc } = configure(true, api);

    await svc.check();

    expect(api.getSetupStatus).toHaveBeenCalled();
    expect(svc.isOffline()).toBe(false);
    expect(svc.status()?.needsSetup).toBe(true);
  });

  it('is offline when the network is up but the server is unreachable', async () => {
    const api = makeApi(() => throwError(() => new Error('down')));
    const { svc } = configure(true, api);

    await svc.check();

    expect(svc.isOffline()).toBe(true);
    expect(svc.checked()).toBe(true);
  });

  it('recomputes isOffline live when connectivity flips in both directions', async () => {
    const api = makeApi(okStatus(false));
    const { svc, net } = configure(true, api);

    await svc.check();
    expect(svc.isOffline()).toBe(false);

    // Drop mid-session → offline without any re-check.
    net.setOnline(false);
    expect(svc.isOffline()).toBe(true);

    // Reconnect → back online, again reactively.
    net.setOnline(true);
    expect(svc.isOffline()).toBe(false);
  });
});

describe('SetupService — mid-session server loss + automatic recovery', () => {
  it('reportServerFailure switches into offline mode when the verification probe also fails', async () => {
    // Mid-session detection: the interceptor reports a network-level API failure;
    // the service VERIFIES (one probe) and only then flips the app offline.
    const api = makeApi(() => throwError(() => new Error('down')));
    const { svc } = configure(true, api);
    expect(svc.isOffline()).toBe(false);

    svc.reportServerFailure();
    await flush();

    expect(api.getSetupStatus).toHaveBeenCalledTimes(1);
    expect(svc.isOffline()).toBe(true);
  });

  it('a single flaky request does NOT flip the app offline when the probe succeeds', async () => {
    const api = makeApi(okStatus(false));
    const { svc } = configure(true, api);

    svc.reportServerFailure();
    await flush();

    expect(api.getSetupStatus).toHaveBeenCalledTimes(1);
    expect(svc.isOffline()).toBe(false);
  });

  it('reports are single-flight: repeat reports mid-probe or while already offline add no probes', async () => {
    const api = makeApi(() => throwError(() => new Error('down')));
    const { svc } = configure(true, api);

    // Burst of failing requests all reporting at once → one probe.
    svc.reportServerFailure();
    svc.reportServerFailure();
    svc.reportServerFailure();
    await flush();
    expect(api.getSetupStatus).toHaveBeenCalledTimes(1);
    expect(svc.isOffline()).toBe(true);

    // Already flagged unreachable → the recovery poll owns retries; a report
    // from yet another failing background call must not add probes.
    svc.reportServerFailure();
    await flush();
    expect(api.getSetupStatus).toHaveBeenCalledTimes(1);
  });

  it('does not probe on a report while the DEVICE is offline (network signal already covers it)', async () => {
    const api = makeApi(okStatus(false));
    const { svc } = configure(false, api);

    svc.reportServerFailure();
    await flush();

    expect(api.getSetupStatus).not.toHaveBeenCalled();
    expect(svc.isOffline()).toBe(true); // via the network signal
  });

  it('recovers automatically: keeps polling while unreachable and clears the moment a probe lands', async () => {
    // Server-outage lifecycle with no device event: boot probe fails → offline
    // mode; recovery poll fails once more → still offline; server comes back →
    // next poll flips the app back online, and polling stops.
    vi.useFakeTimers();
    try {
      let up = false;
      const api = makeApi(() =>
        up ? of({ needsSetup: false } as SetupStatus) : throwError(() => new Error('down')),
      );
      const { svc } = configure(true, api);

      await svc.check();
      expect(svc.isOffline()).toBe(true);
      expect(api.getSetupStatus).toHaveBeenCalledTimes(1);

      // First poll: still down.
      await vi.advanceTimersByTimeAsync(SERVER_RECOVERY_POLL_MS);
      expect(api.getSetupStatus).toHaveBeenCalledTimes(2);
      expect(svc.isOffline()).toBe(true);

      // Server returns → the next poll recovers the app on its own.
      up = true;
      await vi.advanceTimersByTimeAsync(SERVER_RECOVERY_POLL_MS);
      expect(api.getSetupStatus).toHaveBeenCalledTimes(3);
      expect(svc.isOffline()).toBe(false);

      // Recovered → polling stopped: no further probes fire.
      await vi.advanceTimersByTimeAsync(SERVER_RECOVERY_POLL_MS * 3);
      expect(api.getSetupStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('device reconnect while server-unreachable re-probes immediately (no poll wait)', async () => {
    // Airplane-mode round trip: server flagged unreachable, device drops, then
    // returns — the reconnect effect verifies instantly so the app is back
    // online in one round-trip instead of waiting out the recovery poll.
    let up = false;
    const api = makeApi(() =>
      up ? of({ needsSetup: false } as SetupStatus) : throwError(() => new Error('down')),
    );
    const { svc, net } = configure(true, api);

    await svc.check();
    expect(svc.isOffline()).toBe(true);
    const probesSoFar = api.getSetupStatus.mock.calls.length;

    net.setOnline(false);
    TestBed.flushEffects();
    up = true;
    net.setOnline(true);
    TestBed.flushEffects();
    await flush();

    expect(api.getSetupStatus.mock.calls.length).toBe(probesSoFar + 1);
    expect(svc.isOffline()).toBe(false);
  });

  it('a reconnect that races an in-flight doomed probe still recovers (not stranded for a poll)', async () => {
    // The real-world shape: the recovery poll fires a probe just as the device
    // comes back. That probe was started while the network was still down, so
    // it fails and re-arms the 20s poll. The reconnect's own probe used to be
    // dropped by the single-flight guard, leaving the app offline for the full
    // period despite a healthy server and a live network.
    let up = false;
    const pending: Array<(ok: boolean) => void> = [];
    const api = makeApi(
      () =>
        new Observable<SetupStatus>((sub) => {
          pending.push((ok) =>
            ok
              ? (sub.next({ needsSetup: false } as SetupStatus), sub.complete())
              : sub.error(new Error('down')),
          );
        }),
    );
    const { svc, net } = configure(true, api);

    void svc.check();
    await flush();
    pending.shift()!(false); // boot probe fails → offline
    await flush();
    expect(svc.isOffline()).toBe(true);

    net.setOnline(false);
    TestBed.flushEffects();

    // A probe goes out while the device is still down (the poll's doing).
    svc.reportServerFailure();
    void (svc as unknown as { verify(): Promise<void> }).verify();
    await flush();

    // Device returns, and the server is healthy again.
    up = true;
    net.setOnline(true);
    TestBed.flushEffects();
    await flush();

    // Settle the doomed in-flight probe; the coalesced reconnect probe replays.
    pending.shift()?.(false);
    await flush();
    pending.shift()?.(up);
    await flush();

    expect(svc.isOffline()).toBe(false);
  });

  it('recovers when the offline/online pair is coalesced into one effect flush', async () => {
    // The e2e/real-world shape: a fast airplane-mode toggle writes online
    // false→true before Angular flushes, so an effect diffing `online` runs once
    // and sees only the final `true` — no edge, no probe, and the app sat
    // offline for the full 20s poll. Reacting to the reconnect COUNTER survives
    // the coalescing.
    let up = false;
    const api = makeApi(() =>
      up ? of({ needsSetup: false } as SetupStatus) : throwError(() => new Error('down')),
    );
    const { svc, net } = configure(true, api);

    await svc.check();
    expect(svc.isOffline()).toBe(true);

    // Both writes land before a single flush — the coalescing that hid the edge.
    up = true;
    net.setOnline(false);
    net.setOnline(true);
    TestBed.flushEffects();
    await flush();

    expect(svc.isOffline()).toBe(false);
  });

  it('learns the server state on reconnect after an offline LAUNCH (boot probe was skipped)', async () => {
    // Offline launch: check() fast-paths, so `status` is null — the app never
    // probed. When connectivity returns, the reconnect effect must probe so
    // needsSetup/status become known without a reload.
    const api = makeApi(okStatus(true));
    const { svc, net } = configure(false, api);

    await svc.check();
    expect(api.getSetupStatus).not.toHaveBeenCalled();
    expect(svc.status()).toBeNull();

    net.setOnline(true);
    TestBed.flushEffects();
    await flush();

    expect(api.getSetupStatus).toHaveBeenCalledTimes(1);
    expect(svc.status()?.needsSetup).toBe(true);
    expect(svc.isOffline()).toBe(false);
  });

  it('a mid-session device drop + reconnect with a healthy, already-probed server adds NO probe', async () => {
    // The zero-extra-traffic property: status is known and the server was never
    // flagged unreachable, so a tunnel/elevator connectivity blip must not
    // generate a reachability probe on reconnect.
    const api = makeApi(okStatus(false));
    const { svc, net } = configure(true, api);

    await svc.check();
    expect(api.getSetupStatus).toHaveBeenCalledTimes(1);

    net.setOnline(false);
    TestBed.flushEffects();
    net.setOnline(true);
    TestBed.flushEffects();
    await flush();

    expect(api.getSetupStatus).toHaveBeenCalledTimes(1);
    expect(svc.isOffline()).toBe(false);
  });
});

describe('SetupService — success-signal recovery (issue #372)', () => {
  it('reportServerSuccess clears offline mode instantly, with no extra probe', async () => {
    // Boot succeeds (status learned), then the server dies mid-session.
    let up = true;
    const api = makeApi(() =>
      up ? of({ needsSetup: false } as SetupStatus) : throwError(() => new Error('down')),
    );
    const { svc } = configure(true, api);
    await svc.check();
    up = false;
    svc.reportServerFailure();
    await flush();
    expect(svc.isOffline()).toBe(true);
    const probes = api.getSetupStatus.mock.calls.length;

    // A later API request succeeded (e.g. the disk pill's poll): that response
    // IS the reachability proof — no verification round-trip needed.
    up = true;
    svc.reportServerSuccess();
    await flush();

    expect(svc.isOffline()).toBe(false);
    expect(api.getSetupStatus.mock.calls.length).toBe(probes); // status known → no probe
  });

  it('reportServerSuccess still probes when the setup status was never learned (offline launch)', async () => {
    // Device online but server down at boot → unreachable with status null.
    let up = false;
    const api = makeApi(() =>
      up ? of({ needsSetup: false } as SetupStatus) : throwError(() => new Error('down')),
    );
    const { svc } = configure(true, api);
    await svc.check();
    expect(svc.status()).toBeNull();
    const probes = api.getSetupStatus.mock.calls.length;

    up = true;
    svc.reportServerSuccess();
    await flush();

    expect(svc.isOffline()).toBe(false);
    expect(svc.status()).toEqual({ needsSetup: false }); // probe filled the gap
    expect(api.getSetupStatus.mock.calls.length).toBe(probes + 1);
  });

  it('is a no-op while the server is not flagged unreachable', async () => {
    const api = makeApi(okStatus(false));
    const { svc } = configure(true, api);
    await svc.check();
    const probes = api.getSetupStatus.mock.calls.length;

    svc.reportServerSuccess();
    await flush();

    expect(api.getSetupStatus.mock.calls.length).toBe(probes);
    expect(svc.isOffline()).toBe(false);
  });

  it('stops the recovery poll once a success is reported', async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const api = makeApi(() =>
        up ? of({ needsSetup: false } as SetupStatus) : throwError(() => new Error('down')),
      );
      const { svc } = configure(true, api);
      svc.reportServerFailure();
      await Promise.resolve();
      await Promise.resolve();
      expect(svc.isOffline()).toBe(true);

      up = true; // the server recovered — a background request then succeeded
      svc.reportServerSuccess();
      await Promise.resolve();
      await Promise.resolve();
      const probes = api.getSetupStatus.mock.calls.length;
      // The 20s poll must have been cancelled — no further probes fire.
      await vi.advanceTimersByTimeAsync(SERVER_RECOVERY_POLL_MS * 3);
      expect(api.getSetupStatus.mock.calls.length).toBe(probes);
      expect(svc.isOffline()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
