import { vi } from 'vitest';
import { hapticTick } from './haptics';

describe('hapticTick', () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('is a no-op on the web (no Capacitor global)', () => {
    expect(() => hapticTick()).not.toThrow();
  });

  it('fires a light impact on the native shells', () => {
    const impact = vi.fn().mockResolvedValue(undefined);
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { Haptics: { impact } },
    };
    hapticTick();
    expect(impact).toHaveBeenCalledWith({ style: 'LIGHT' });
  });

  it('stays silent when the plugin is missing or its call rejects', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {},
    };
    expect(() => hapticTick()).not.toThrow();
    const impact = vi.fn().mockRejectedValue(new Error('no vibrator'));
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { Haptics: { impact } },
    };
    hapticTick();
    await Promise.resolve();
    expect(impact).toHaveBeenCalled();
  });
});
