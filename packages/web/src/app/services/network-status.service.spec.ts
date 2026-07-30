import { vi } from 'vitest';
import { NetworkStatusService } from './network-status.service';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('NetworkStatusService (web)', () => {
  const originalOnLine = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(navigator),
    'onLine',
  );

  function setOnLine(value: boolean): void {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
  }

  afterEach(() => {
    // Restore navigator.onLine and clear any Capacitor global a native test set.
    if (originalOnLine) {
      Object.defineProperty(Object.getPrototypeOf(navigator), 'onLine', originalOnLine);
    }
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('seeds online from navigator.onLine', () => {
    setOnLine(true);
    expect(new NetworkStatusService().online()).toBe(true);
  });

  it('seeds offline when navigator reports offline', () => {
    setOnLine(false);
    expect(new NetworkStatusService().online()).toBe(false);
  });

  it('flips to offline on the window offline event and back on the online event', () => {
    setOnLine(true);
    const svc = new NetworkStatusService();

    window.dispatchEvent(new Event('offline'));
    expect(svc.online()).toBe(false);

    window.dispatchEvent(new Event('online'));
    expect(svc.online()).toBe(true);
  });

  it('whenReady() resolves immediately on web (synchronous seed)', async () => {
    setOnLine(true);
    // Would reject if whenReady never resolved: Promise.race against a rejecting
    // microtask proves it's already/eagerly resolved rather than pending.
    await Promise.race([
      new NetworkStatusService().whenReady(),
      Promise.reject(new Error('whenReady did not resolve synchronously on web')),
    ]);
  });
});

describe('NetworkStatusService (native)', () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('seeds from the Capacitor Network plugin and updates on networkStatusChange', async () => {
    // Collected rather than held in a `let`: the only assignment is inside the
    // addListener callback, which TS's control-flow analysis can't see, so a
    // nullable `let` narrows to `null` and the call sites stop type-checking.
    const listeners: Array<(s: { connected: boolean }) => void> = [];
    const plugin = {
      getStatus: vi.fn(async () => ({ connected: false })),
      addListener: vi.fn((_evt: string, cb: (s: { connected: boolean }) => void) => {
        listeners.push(cb);
        return { remove: () => {} };
      }),
    };
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { Network: plugin },
    };

    const svc = new NetworkStatusService();
    await flush();

    // Seeded from getStatus (no server round-trip) — the plugin, not navigator.onLine.
    expect(plugin.getStatus).toHaveBeenCalled();
    expect(svc.online()).toBe(false);
    expect(plugin.addListener).toHaveBeenCalledWith('networkStatusChange', expect.any(Function));

    // Live updates in both directions via the registered listener.
    listeners[0]?.({ connected: true });
    expect(svc.online()).toBe(true);
    listeners[0]?.({ connected: false });
    expect(svc.online()).toBe(false);
  });

  it('whenReady() resolves only after the async native seed lands, and online() is correct by then', async () => {
    // The ANR-relevant guarantee: whenReady() gates on the async getStatus(), so a
    // consumer awaiting it (SetupService) reads the true offline value, not the
    // optimistic default. Before the seed, online() is the optimistic true.
    let resolveStatus!: (s: { connected: boolean }) => void;
    const plugin = {
      getStatus: vi.fn(() => new Promise<{ connected: boolean }>((r) => (resolveStatus = r))),
      addListener: vi.fn(() => ({ remove: () => {} })),
    };
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { Network: plugin },
    };

    const svc = new NetworkStatusService();
    expect(svc.online()).toBe(true); // optimistic until the seed resolves

    let ready = false;
    void svc.whenReady().then(() => (ready = true));
    await flush();
    expect(ready).toBe(false); // still pending — getStatus() hasn't resolved

    resolveStatus({ connected: false });
    await flush();
    expect(ready).toBe(true);
    expect(svc.online()).toBe(false);
  });

  it('whenReady() still resolves when the native seed rejects (never hangs boot)', async () => {
    const plugin = {
      getStatus: vi.fn(async () => {
        throw new Error('plugin blew up');
      }),
      addListener: vi.fn(() => ({ remove: () => {} })),
    };
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { Network: plugin },
    };

    const svc = new NetworkStatusService();
    await svc.whenReady(); // resolves despite the rejection (optimistic default kept)
    expect(svc.online()).toBe(true);
  });

  it('whenReady() resolves via the web fallback when the Network plugin is missing', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {}, // no Network plugin
    };
    await new NetworkStatusService().whenReady(); // initWeb() resolves it
  });

  it('falls back to web listeners when the Network plugin is unavailable', () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {}, // no Network plugin registered (e.g. an older shell)
    };

    const svc = new NetworkStatusService();
    // Should still react to window events rather than being stuck online forever.
    window.dispatchEvent(new Event('offline'));
    expect(svc.online()).toBe(false);
  });
});
