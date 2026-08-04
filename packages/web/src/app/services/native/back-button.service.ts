import { Injectable, NgZone, inject } from '@angular/core';
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

  initialize(): void {
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
