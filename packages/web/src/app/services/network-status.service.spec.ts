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
});

describe('NetworkStatusService (native)', () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('seeds from the Capacitor Network plugin and updates on networkStatusChange', async () => {
    let listener: ((s: { connected: boolean }) => void) | null = null;
    const plugin = {
      getStatus: vi.fn(async () => ({ connected: false })),
      addListener: vi.fn((_evt: string, cb: (s: { connected: boolean }) => void) => {
        listener = cb;
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
    listener?.({ connected: true });
    expect(svc.online()).toBe(true);
    listener?.({ connected: false });
    expect(svc.online()).toBe(false);
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
