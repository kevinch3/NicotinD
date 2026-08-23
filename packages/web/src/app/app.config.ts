import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  inject,
  provideAppInitializer,
  isDevMode,
  InjectionToken,
  ErrorHandler,
  Injector,
  effect,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { BufferingErrorHandler } from './observability/buffering-error-handler';
import { authInterceptor } from './interceptors/auth.interceptor';
import { isNativeShell, serviceWorkerEnabled } from './lib/platform';
import { SetupService } from './services/setup.service';
import { ThemeService } from './services/theme.service';
import { PreserveService } from './services/preserve.service';
import { PlayerService } from './services/player.service';
import { AuthService } from './services/auth.service';
import { AuthApiService } from './services/api/auth-api.service';
import { AutoPreserveCoordinator } from './services/auto-preserve-coordinator';
import pkg from '../../../../package.json';
import { switchMap } from 'rxjs/operators';
import { TranslateService } from './services/translate.service';

export const APP_VERSION = new InjectionToken<string>('APP_VERSION');

/**
 * Refresh the stored session and sync the per-user profile flags. Runs after the
 * boot connectivity check (online boot), or on the first return to online after
 * an offline launch (see the initializer below).
 */
export function refreshSession(api: AuthApiService, auth: AuthService): void {
  api
    .refreshToken()
    .pipe(
      switchMap((res) => {
        auth.setToken(res.token);
        return api.getMe();
      }),
    )
    .subscribe({
      next: (profile) => {
        // Sync role from the (DB-backed) refreshed session so a role change
        // an admin made takes effect on this load, not only on re-login.
        auth.setRole(profile.role);
        auth.welcomeDismissed.set(profile.welcomeDismissed);
        auth.feedbackCapture.set(profile.feedbackCapture);
        // Deployment-wide acquisition kill-switch (#235): default to enabled
        // when an older server omits the field.
        auth.serverAcquisitionEnabled.set(profile.acquisitionEnabled ?? true);
      },
      error: () => {},
    });
}

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: APP_VERSION, useValue: pkg.version },
    // A Sentry-free ErrorHandler (issue #285): it buffers into error-buffer.ts,
    // which the lazily-loaded SDK drains on connect. Replaces
    // Sentry.createErrorHandler() + Sentry.TraceService, whose static imports
    // pinned the 272 kB SDK into the initial chunk. Dropping TraceService loses
    // only Angular-router navigation spans (tracing still runs browser-side once
    // the SDK loads); error capture is fully preserved.
    { provide: ErrorHandler, useClass: BufferingErrorHandler },
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideAppInitializer(() => {
      const setup = inject(SetupService);
      const theme = inject(ThemeService);
      const preserve = inject(PreserveService);
      const player = inject(PlayerService);
      const auth = inject(AuthService);
      const api = inject(AuthApiService);
      // Load the i18n catalogs before first paint (issue #236). Deliberately
      // not awaited: a slow/failed catalog fetch must never delay or block
      // bootstrap — the UI renders English (or raw keys) and swaps in when it
      // lands, which the impure translate pipe picks up.
      void inject(TranslateService).init();
      theme.apply();
      preserve.init();
      player.restoreState();
      // AutoPreserveCoordinator wires the player queue → IndexedDB. Cheap while
      // autoPreserveMode is "off" (default — returns immediately on every effect
      // tick), so it ships in dev too: the gate originally mirrored the SW's
      // (which is dev/native-skip to avoid stale-cache issues) but the
      // coordinator has no equivalent concern. Native apps default to "off" and
      // the only effect cost is reading two signals.
      inject(AutoPreserveCoordinator);
      // Captured here because the .then() below runs outside the injection
      // context (needed for the deferred-refresh effect).
      const injector = inject(Injector);
      // The session refresh runs AFTER the connectivity check, and only when the
      // app is actually online: on an offline launch the refresh/`/me` pair is
      // doomed (part of the failing-request flurry behind the Android offline
      // ANR), and skipping it deliberately KEEPS the stored token — the offline
      // library must stay usable with the last known session rather than
      // churning on auth requests that can't succeed.
      return setup.check().then(() => {
        if (!auth.isAuthenticated()) return;
        if (!setup.isOffline()) {
          refreshSession(api, auth);
          return;
        }
        // Offline launch with a stored session: refresh it automatically the
        // FIRST time the app returns online (one-shot — the effect destroys
        // itself), so roles/flags re-sync without a reload. No autoplay here.
        const ref = effect(
          () => {
            if (setup.isOffline()) return;
            ref.destroy();
            if (auth.isAuthenticated()) refreshSession(api, auth);
          },
          { injector },
        );
      });
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: serviceWorkerEnabled(isDevMode(), isNativeShell()),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
