import { DestroyRef, Injectable, NgZone, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { getCapacitorPlugin, isNativePlatform } from '../../lib/platform';
import { BackHandlerStack } from '../../lib/back-handlers';

/** `@capacitor/app`'s native plugin, reached through the Capacitor global so
 *  `@capacitor/*` stays out of the web bundle (native-capabilities pattern).
 *  Registering any `backButton` listener replaces Capacitor's default
 *  activity-finish behavior — which is exactly the point (issue #394). */
interface AppPlugin {
  addListener(event: 'backButton', cb: (state: { canGoBack: boolean }) => void): unknown;
  exitApp(): Promise<void>;
}

/**
 * Android hardware Back (issue #394): close the topmost overlay first (the
 * `BackHandlerStack` — Now Playing sheet, track-info sheet, open menus), else
 * walk router history, and only exit the app from the home route with nothing
 * left to close. Without this, Back finished the activity from anywhere —
 * the observed TV behavior of "Back exits the app". A no-op outside the
 * native shell (plugin absent).
 */
@Injectable({ providedIn: 'root' })
export class BackButtonService {
  readonly stack = new BackHandlerStack();

  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  initialize(): void {
    // Escape shares the stack (issue #398): one press closes only the topmost
    // overlay — replacing the per-component `document:keydown.escape` handlers
    // that all fired at once when overlays stacked. Unlike hardware Back it
    // never falls through to navigation: Escape means "close", not "go back".
    const controller = new AbortController();
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (this.stack.handleBack()) event.preventDefault();
      },
      { signal: controller.signal },
    );
    this.destroyRef.onDestroy(() => controller.abort());
    if (!isNativePlatform()) return;
    const app = getCapacitorPlugin<AppPlugin>('App');
    if (!app) return;
    app.addListener('backButton', () => this.zone.run(() => this.handle()));
  }

  /** Exposed for tests: one Back press's decision, in priority order. */
  handle(): void {
    if (this.stack.handleBack()) return;
    // Any non-home route walks history — in-app navigation always built it.
    if (this.router.url !== '/') {
      this.location.back();
      return;
    }
    void getCapacitorPlugin<AppPlugin>('App')?.exitApp();
  }
}

/**
 * Registers `close` as the overlay's Escape/hardware-Back closer for the
 * lifetime of the calling component (issue #398). For modals rendered under an
 * `@if` — where component lifetime IS open lifetime — call it from the
 * constructor; the DestroyRef teardown unregisters when the modal leaves the
 * DOM. Overlays that outlive their open state (menus, sheets) keep managing
 * their registration manually on open/close instead.
 */
export function registerOverlayCloser(close: () => void): void {
  const unregister = inject(BackButtonService).stack.push(() => {
    close();
    return true;
  });
  inject(DestroyRef).onDestroy(unregister);
}
