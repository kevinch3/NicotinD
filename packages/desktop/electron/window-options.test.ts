import { describe, expect, it } from 'bun:test';
import { windowOptionsForPlatform } from './window-options.js';

describe('windowOptionsForPlatform', () => {
  it('uses hiddenInset + traffic lights on darwin', () => {
    const opts = windowOptionsForPlatform('darwin');
    expect(opts.titleBarStyle).toBe('hiddenInset');
    expect(opts.trafficLightPosition).toEqual({ x: 14, y: 14 });
    expect(opts.frame).toBeUndefined();
  });

  it('frames-off everywhere else (Linux)', () => {
    const opts = windowOptionsForPlatform('linux');
    expect(opts.frame).toBe(false);
    expect(opts.titleBarStyle).toBe('hidden');
    expect(opts.trafficLightPosition).toBeUndefined();
  });

  it('frames-off on Windows for future parity (no Windows target yet)', () => {
    const opts = windowOptionsForPlatform('win32');
    expect(opts.frame).toBe(false);
    expect(opts.titleBarStyle).toBe('hidden');
  });

  it('keeps the sandboxed preload + contextIsolation on every platform', () => {
    for (const p of ['darwin', 'linux', 'win32'] as const) {
      const opts = windowOptionsForPlatform(p);
      expect(opts.webPreferences?.sandbox).toBe(true);
      expect(opts.webPreferences?.contextIsolation).toBe(true);
      expect(opts.webPreferences?.nodeIntegration).toBe(false);
      expect(opts.webPreferences?.preload).toMatch(/preload\.cjs$/);
    }
  });

  it('does not paint an icon when one is unavailable (no fallback)', () => {
    const opts = windowOptionsForPlatform('linux', '/nonexistent/icon.png');
    expect(opts.icon).toBeUndefined();
  });
});
