import { DestroyRef, Injectable, NgZone, computed, inject, signal } from '@angular/core';
import {
  clearStashedInstallPrompt,
  installPromotionVisible,
  isIosBrowser,
  isStandaloneDisplay,
  loadInstallPromoDismissed,
  onInstallPrompt,
  saveInstallPromoDismissed,
  stashedInstallPrompt,
  type BeforeInstallPromptEvent,
} from '../lib/install-prompt';
import { isNativeShell, isTvUi } from '../lib/platform';

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/**
 * In-app PWA install (web.dev "promote-install"). Two surfaces read it: the
 * promotion strip in the layout (once, dismissible) and the permanent
 * Settings → Updates row. Inert inside Capacitor / Electron / TV, where the
 * app already *is* the installed thing.
 */
@Injectable({ providedIn: 'root' })
export class InstallPromptService {
  private zone = inject(NgZone);
  private destroyRef = inject(DestroyRef);

  /** True inside any native shell or the TV build: nothing to install. */
  readonly nativeShell = isNativeShell() || isTvUi();

  private readonly deferred = signal<BeforeInstallPromptEvent | null>(
    this.nativeShell ? null : stashedInstallPrompt(),
  );

  /** Running standalone at boot, or `appinstalled` fired this session. */
  readonly installed = signal(!this.nativeShell && isStandaloneDisplay());

  /** iOS browser: the only install path is Share → Add to Home Screen. */
  readonly iosManualInstall = !this.nativeShell && isIosBrowser();

  readonly promoDismissed = signal(loadInstallPromoDismissed());

  /** A captured prompt is on hand and the app is not already installed. */
  readonly canInstall = computed(() => this.deferred() !== null && !this.installed());

  /** True while `install()` awaits the browser's dialog. Gates duplicate clicks. */
  readonly installing = signal(false);

  readonly showPromotion = computed(() =>
    installPromotionVisible({
      canInstall: this.canInstall(),
      iosManual: this.iosManualInstall,
      installed: this.installed(),
      dismissed: this.promoDismissed(),
      nativeShell: this.nativeShell,
    }),
  );

  /** The Settings row: same offer without the dismissal — it is where a user goes looking. */
  readonly showIosHint = computed(
    () => this.iosManualInstall && !this.installed() && !this.nativeShell,
  );

  constructor() {
    if (this.nativeShell) return;

    // A capture after this service was created (the usual case: Chromium waits
    // for the manifest + SW before deciding the page is installable).
    const off = onInstallPrompt((e) => this.zone.run(() => this.deferred.set(e)));

    // Fires after the user accepts the prompt — ours or the browser's own
    // omnibox button — and is the only signal that the install actually landed.
    const onInstalled = (): void =>
      this.zone.run(() => {
        this.installed.set(true);
        this.deferred.set(null);
        clearStashedInstallPrompt();
      });
    window.addEventListener('appinstalled', onInstalled);

    this.destroyRef.onDestroy(() => {
      off();
      window.removeEventListener('appinstalled', onInstalled);
    });
  }

  /**
   * Show the browser's install dialog. The captured event is single-use: after
   * `prompt()` it is spent whatever the user chose, so it is dropped here and
   * the browser fires a fresh `beforeinstallprompt` if the page stays
   * installable.
   */
  async install(): Promise<InstallOutcome> {
    const event = this.deferred();
    if (!event || this.installing()) return 'unavailable';
    this.installing.set(true);
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      return outcome;
    } finally {
      this.deferred.set(null);
      clearStashedInstallPrompt();
      this.installing.set(false);
    }
  }

  /** Close the strip and remember it on this device. The Settings row stays. */
  dismissPromotion(): void {
    this.promoDismissed.set(true);
    saveInstallPromoDismissed();
  }
}
