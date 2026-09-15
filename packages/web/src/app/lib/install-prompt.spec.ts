import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  INSTALL_PROMO_DISMISSED_KEY,
  captureInstallPrompt,
  clearStashedInstallPrompt,
  installPromotionVisible,
  isIosBrowser,
  isStandaloneDisplay,
  loadInstallPromoDismissed,
  onInstallPrompt,
  resetInstallPromptCapture,
  saveInstallPromoDismissed,
  stashedInstallPrompt,
} from './install-prompt';

function promptEvent(): Event {
  const e = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(e, { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'accepted' }) });
  return e;
}

afterEach(() => resetInstallPromptCapture());

describe('captureInstallPrompt', () => {
  it('stashes an event fired before anyone subscribed and suppresses the browser infobar', () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    const e = promptEvent();
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(stashedInstallPrompt()).toBe(e);
  });

  it('notifies later subscribers of a fresh capture and unsubscribes cleanly', () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    const seen: Event[] = [];
    const off = onInstallPrompt((e) => seen.push(e));
    const first = promptEvent();
    target.dispatchEvent(first);
    off();
    target.dispatchEvent(promptEvent());
    expect(seen).toEqual([first]);
  });

  it('a spent prompt is cleared without dropping the listener', () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    target.dispatchEvent(promptEvent());
    clearStashedInstallPrompt();
    expect(stashedInstallPrompt()).toBeNull();
    const again = promptEvent();
    target.dispatchEvent(again);
    expect(stashedInstallPrompt()).toBe(again);
  });
});

describe('isStandaloneDisplay', () => {
  const mm = (matching: string[]) => (q: string) => ({
    matches: matching.some((m) => q.includes(m)),
  });

  it('is false in a plain browser tab', () => {
    expect(isStandaloneDisplay({ matchMedia: mm([]), navigator: {} })).toBe(false);
  });

  it.each(['standalone', 'fullscreen', 'minimal-ui'])('is true under display-mode %s', (mode) => {
    expect(isStandaloneDisplay({ matchMedia: mm([mode]), navigator: {} })).toBe(true);
  });

  it('honours the iOS-only navigator.standalone flag', () => {
    expect(isStandaloneDisplay({ matchMedia: mm([]), navigator: { standalone: true } })).toBe(true);
  });

  it('survives a window without matchMedia', () => {
    expect(isStandaloneDisplay({ navigator: {} })).toBe(false);
  });
});

describe('isIosBrowser', () => {
  it('matches iPhone and iPad UAs', () => {
    expect(
      isIosBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }),
    ).toBe(true);
    expect(isIosBrowser({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)' })).toBe(true);
  });

  it('treats a touch Macintosh UA as iPadOS but a real Mac as not', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
    expect(isIosBrowser({ userAgent: mac, maxTouchPoints: 5 })).toBe(true);
    expect(isIosBrowser({ userAgent: mac, maxTouchPoints: 0 })).toBe(false);
  });

  it('is false on Android and desktop Chrome', () => {
    expect(isIosBrowser({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' })).toBe(false);
    expect(isIosBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' })).toBe(false);
  });
});

describe('installPromotionVisible', () => {
  const base = {
    canInstall: false,
    iosManual: false,
    installed: false,
    dismissed: false,
    nativeShell: false,
  };

  it('shows nothing until there is something to offer', () => {
    expect(installPromotionVisible(base)).toBe(false);
  });

  it('shows once beforeinstallprompt was captured', () => {
    expect(installPromotionVisible({ ...base, canInstall: true })).toBe(true);
  });

  it('shows the manual path on iOS, which never fires the event', () => {
    expect(installPromotionVisible({ ...base, iosManual: true })).toBe(true);
  });

  it.each([
    ['installed', { installed: true }],
    ['dismissed on this device', { dismissed: true }],
    ['inside a native shell', { nativeShell: true }],
  ])('stays hidden when %s, whatever else is true', (_label, over) => {
    expect(installPromotionVisible({ ...base, canInstall: true, iosManual: true, ...over })).toBe(
      false,
    );
  });
});

describe('dismissal persistence', () => {
  it('round-trips through storage and defaults to not dismissed', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadInstallPromoDismissed(storage)).toBe(false);
    saveInstallPromoDismissed(storage);
    expect(store.get(INSTALL_PROMO_DISMISSED_KEY)).toBe('1');
    expect(loadInstallPromoDismissed(storage)).toBe(true);
  });

  it('a throwing storage (private mode) reads as not dismissed and does not throw on save', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadInstallPromoDismissed(throwing)).toBe(false);
    expect(() => saveInstallPromoDismissed(throwing)).not.toThrow();
  });
});
