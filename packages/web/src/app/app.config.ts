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
      // AutoPreserveCoordinator is web-only: native already runs a foreground
      // service (Android @jofr) or owns the audio session natively (iOS Swift
      // plugin), so the locked-screen failure mode this guards against doesn't
      // exist there. Same gating as the service worker — dev + native shell skip.
      if (!serviceWorkerEnabled(isDevMode(), isNativeShell())) {
        inject(AutoPreserveCoordinator);
      }
      return setup.check();
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: serviceWorkerEnabled(isDevMode(), isNativeShell()),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
