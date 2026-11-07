import { vi } from 'vitest';
import {
  DEFAULT_HAPTIC_LEVEL,
  HAPTIC_COALESCE_MS,
  HAPTIC_LEVEL_KEY,
  HAPTIC_MAP,
  REDUCED_EVENTS,
  haptic,
  hapticEnabled,
  hapticLevel,
  hapticTick,
  hapticsAvailable,
  setHapticLevel,
  type HapticEvent,
} from './haptics';

const EVENTS = Object.keys(HAPTIC_MAP) as HapticEvent[];

function plugin() {
  return {
    impact: vi.fn().mockResolvedValue(undefined),
    notification: vi.fn().mockResolvedValue(undefined),
    selectionStart: vi.fn().mockResolvedValue(undefined),
    selectionChanged: vi.fn().mockResolvedValue(undefined),
    selectionEnd: vi.fn().mockResolvedValue(undefined),
  };
}

function nativeShell(haptics: unknown = plugin()) {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: haptics === null ? {} : { Haptics: haptics },
  };
  return haptics as ReturnType<typeof plugin>;
}

function media(matches: Record<string, boolean>) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({ matches: matches[q] ?? false, media: q })),
  );
}

// The throttle is module state; every test starts well past any earlier fire.
let clock = 1_000_000;
beforeEach(() => {
  vi.useFakeTimers();
  clock += 10_000;
  vi.setSystemTime(clock);
  setHapticLevel('full');
});

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'vibrate');
  document.documentElement.classList.remove('tv-build');
  vi.useRealTimers();
  localStorage.removeItem(HAPTIC_LEVEL_KEY);
});

describe('haptic — native shells', () => {
  it('maps each impact event to its style', () => {
    const p = nativeShell();
    haptic('tap');
    haptic('hold');
    haptic('commit');
    expect(p.impact.mock.calls).toEqual([
      [{ style: 'LIGHT' }],
      [{ style: 'MEDIUM' }],
      [{ style: 'LIGHT' }],
    ]);
  });

  it('maps success/warning/error to notifications', () => {
    const p = nativeShell();
    haptic('success');
    haptic('warning');
    haptic('error');
    expect(p.notification.mock.calls).toEqual([
      [{ type: 'SUCCESS' }],
      [{ type: 'WARNING' }],
      [{ type: 'ERROR' }],
    ]);
    expect(p.impact).not.toHaveBeenCalled();
  });

  it('plays select as a whole selection start/changed/end pair', async () => {
    const p = nativeShell();
    haptic('select');
    await vi.runAllTimersAsync();
    expect(p.selectionStart).toHaveBeenCalledTimes(1);
    expect(p.selectionChanged).toHaveBeenCalledTimes(1);
    expect(p.selectionEnd).toHaveBeenCalledTimes(1);
  });

  it('never vibrates through the web API inside a native shell', () => {
    nativeShell();
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    haptic('tap');
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('stays silent when the plugin is missing, a method is missing, or a call rejects', async () => {
    nativeShell(null);
    expect(() => haptic('tap')).not.toThrow();
    vi.setSystemTime((clock += 1000));
    nativeShell({});
    expect(() => haptic('success')).not.toThrow();
    vi.setSystemTime((clock += 1000));
    const p = nativeShell({ impact: vi.fn().mockRejectedValue(new Error('no vibrator')) });
    expect(() => haptic('tap')).not.toThrow();
    await vi.runAllTimersAsync();
    expect(p.impact).toHaveBeenCalled();
  });

  it('keeps hapticTick() as the commit alias #1297 shipped with', () => {
    const p = nativeShell();
    setHapticLevel('reduced');
    hapticTick();
    expect(p.impact).toHaveBeenCalledWith({ style: 'LIGHT' });
    expect(HAPTIC_MAP.commit.native).toEqual({ kind: 'impact', style: 'LIGHT' });
  });
});

describe('haptic — web fallback', () => {
  it('vibrates the table pattern on a touch browser that has navigator.vibrate', () => {
    media({ '(pointer: coarse)': true });
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    haptic('success');
    expect(vibrate).toHaveBeenCalledWith(HAPTIC_MAP.success.web);
  });

  it('is a no-op without navigator.vibrate (iOS Safari), on a mouse, on TV and in Electron', () => {
    media({ '(pointer: coarse)': true });
    expect(hapticsAvailable()).toBe(false);
    expect(() => haptic('tap')).not.toThrow();

    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    media({ '(pointer: coarse)': false });
    expect(hapticsAvailable()).toBe(false);

    media({ '(pointer: coarse)': true });
    document.documentElement.classList.add('tv-build');
    expect(hapticsAvailable()).toBe(false);
    document.documentElement.classList.remove('tv-build');

    (window as { nicotind?: unknown }).nicotind = { platform: 'electron' };
    expect(hapticsAvailable()).toBe(false);
    delete (window as { nicotind?: unknown }).nicotind;

    haptic('tap');
    expect(hapticsAvailable()).toBe(true);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });
});

describe('the level gate', () => {
  it('defaults to Reduced (owner decision on #1659)', () => {
    expect(DEFAULT_HAPTIC_LEVEL).toBe('reduced');
    expect([...REDUCED_EVENTS].sort()).toEqual(['commit', 'error', 'hold']);
  });

  it('Off silences everything, Reduced keeps hold/commit/error, Full keeps all', () => {
    for (const e of EVENTS) {
      expect(hapticEnabled(e, 'off')).toBe(false);
      expect(hapticEnabled(e, 'reduced')).toBe(REDUCED_EVENTS.has(e));
      expect(hapticEnabled(e, 'full')).toBe(true);
    }
  });

  it('prefers-reduced-motion caps Full at Reduced', () => {
    media({ '(prefers-reduced-motion: reduce)': true });
    expect(hapticEnabled('tap', 'full')).toBe(false);
    expect(hapticEnabled('hold', 'full')).toBe(true);
  });

  it('gates the real call, and persists the choice per device', () => {
    const p = nativeShell();
    setHapticLevel('reduced');
    haptic('tap');
    haptic('hold');
    expect(p.impact.mock.calls).toEqual([[{ style: 'MEDIUM' }]]);
    setHapticLevel('off');
    vi.setSystemTime((clock += 1000));
    haptic('hold');
    expect(p.impact).toHaveBeenCalledTimes(1);
    expect(hapticLevel()).toBe('off');
    expect(localStorage.getItem(HAPTIC_LEVEL_KEY)).toBe('off');
  });
});

describe('the throttle', () => {
  it('coalesces the same event inside the window, never a different one', () => {
    const p = nativeShell();
    haptic('tap');
    haptic('tap');
    haptic('hold');
    vi.setSystemTime((clock += HAPTIC_COALESCE_MS - 1));
    haptic('tap');
    expect(p.impact).toHaveBeenCalledTimes(2);
    vi.setSystemTime((clock += 1));
    haptic('tap');
    expect(p.impact).toHaveBeenCalledTimes(3);
  });
});
