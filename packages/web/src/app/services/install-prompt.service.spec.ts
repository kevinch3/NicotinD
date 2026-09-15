import { TestBed } from '@angular/core/testing';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { InstallPromptService } from './install-prompt.service';
import {
  INSTALL_PROMO_DISMISSED_KEY,
  captureInstallPrompt,
  resetInstallPromptCapture,
  type BeforeInstallPromptEvent,
} from '../lib/install-prompt';

function promptEvent(outcome: 'accepted' | 'dismissed' = 'accepted'): BeforeInstallPromptEvent {
  const e = new Event('beforeinstallprompt', { cancelable: true });
  return Object.assign(e, {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome }),
  }) as unknown as BeforeInstallPromptEvent;
}

const realMatchMedia = window.matchMedia;

function setStandalone(matches: boolean): void {
  window.matchMedia = vi.fn().mockReturnValue({ matches }) as unknown as typeof window.matchMedia;
}

describe('InstallPromptService', () => {
  beforeEach(() => {
    resetInstallPromptCapture();
    localStorage.removeItem(INSTALL_PROMO_DISMISSED_KEY);
    setStandalone(false);
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    document.documentElement.classList.remove('tv-build');
    // The listener main.ts attaches before bootstrap.
    captureInstallPrompt(window);
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    localStorage.removeItem(INSTALL_PROMO_DISMISSED_KEY);
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    document.documentElement.classList.remove('tv-build');
  });

  const make = () => TestBed.inject(InstallPromptService);

  it('offers nothing until beforeinstallprompt fires', () => {
    const svc = make();
    expect(svc.canInstall()).toBe(false);
    expect(svc.showPromotion()).toBe(false);
  });

  it('sees an event captured before it was created (no-replay trap)', () => {
    window.dispatchEvent(promptEvent());
    const svc = make();
    expect(svc.canInstall()).toBe(true);
    expect(svc.showPromotion()).toBe(true);
  });

  it('sees an event captured after it was created', () => {
    const svc = make();
    window.dispatchEvent(promptEvent());
    expect(svc.canInstall()).toBe(true);
  });

  it('install() shows the browser dialog once and spends the event either way', async () => {
    const e = promptEvent('dismissed');
    window.dispatchEvent(e);
    const svc = make();
    await expect(svc.install()).resolves.toBe('dismissed');
    expect(e.prompt).toHaveBeenCalledTimes(1);
    expect(svc.canInstall()).toBe(false);
    await expect(svc.install()).resolves.toBe('unavailable');
  });

  it('a second click while the dialog is open is ignored', async () => {
    const e = promptEvent();
    window.dispatchEvent(e);
    const svc = make();
    const first = svc.install();
    const second = svc.install();
    await expect(second).resolves.toBe('unavailable');
    await expect(first).resolves.toBe('accepted');
    expect(e.prompt).toHaveBeenCalledTimes(1);
  });

  it('appinstalled marks the app installed and hides every offer', () => {
    window.dispatchEvent(promptEvent());
    const svc = make();
    window.dispatchEvent(new Event('appinstalled'));
    expect(svc.installed()).toBe(true);
    expect(svc.canInstall()).toBe(false);
    expect(svc.showPromotion()).toBe(false);
  });

  it('an app already running standalone is never asked to install', () => {
    setStandalone(true);
    window.dispatchEvent(promptEvent());
    const svc = make();
    expect(svc.installed()).toBe(true);
    expect(svc.canInstall()).toBe(false);
  });

  it('dismissing the promotion persists per device but keeps the Settings offer', () => {
    window.dispatchEvent(promptEvent());
    const svc = make();
    svc.dismissPromotion();
    expect(svc.showPromotion()).toBe(false);
    expect(svc.canInstall()).toBe(true);
    expect(localStorage.getItem(INSTALL_PROMO_DISMISSED_KEY)).toBe('1');
  });

  it('a dismissal from an earlier session is honoured at boot', () => {
    localStorage.setItem(INSTALL_PROMO_DISMISSED_KEY, '1');
    window.dispatchEvent(promptEvent());
    expect(make().showPromotion()).toBe(false);
  });

  it('is inert inside a native shell even if the event somehow fires', () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    window.dispatchEvent(promptEvent());
    const svc = make();
    expect(svc.nativeShell).toBe(true);
    expect(svc.canInstall()).toBe(false);
    expect(svc.showPromotion()).toBe(false);
    expect(svc.showIosHint()).toBe(false);
  });

  it('is inert on the TV build', () => {
    document.documentElement.classList.add('tv-build');
    window.dispatchEvent(promptEvent());
    expect(make().canInstall()).toBe(false);
  });
});
