import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  inject,
  provideAppInitializer,
  isDevMode,
  InjectionToken,
  ErrorHandler,
} from '@angular/core';
import * as Sentry from '@sentry/angular';
import { provideRouter, Router } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
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

export const APP_VERSION = new InjectionToken<string>('APP_VERSION');

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: APP_VERSION, useValue: pkg.version },
    {
      provide: ErrorHandler,
      useValue: Sentry.createErrorHandler({
        showDialog: false,
      }),
    },
    {
      provide: Sentry.TraceService,
      deps: [Router],
    },
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
      theme.apply();
      preserve.init();
      player.restoreState();
      if (auth.isAuthenticated()) {
        api.refreshToken().pipe(
          switchMap((res) => {
            auth.setToken(res.token);
            return api.getMe();
          }),
        ).subscribe({
          next: (profile) => {
            // Sync role from the (DB-backed) refreshed session so a role change
            // an admin made takes effect on this load, not only on re-login.
            auth.setRole(profile.role);
            auth.welcomeDismissed.set(profile.welcomeDismissed);
            auth.autoplayOnLoad.set(profile.autoplayOnLoad);
            // Resume a previously playing session if the user opted in to
            // autoplay-on-load. See PlayerService.maybeResumeAutoplay.
            player.maybeResumeAutoplay(profile.autoplayOnLoad);
          },
          error: () => {},
        });
      }
      const traceService = inject(Sentry.TraceService);
      // AutoPreserveCoordinator wires the player queue → IndexedDB. Cheap while
      // autoPreserveMode is "off" (default — returns immediately on every effect
      // tick), so it ships in dev too: the gate originally mirrored the SW's
      // (which is dev/native-skip to avoid stale-cache issues) but the
      // coordinator has no equivalent concern. Native apps default to "off" and
      // the only effect cost is reading two signals.
      inject(AutoPreserveCoordinator);
      return setup.check();
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: serviceWorkerEnabled(isDevMode(), isNativeShell()),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
