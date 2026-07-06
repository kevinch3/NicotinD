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
import { isNativePlatform } from './lib/platform';
import { SetupService } from './services/setup.service';
import { ThemeService } from './services/theme.service';
import { PreserveService } from './services/preserve.service';
import { PlayerService } from './services/player.service';
import { AuthService } from './services/auth.service';
import { AuthApiService } from './services/api/auth-api.service';
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
          next: (profile) => auth.welcomeDismissed.set(profile.welcomeDismissed),
          error: () => {},
        });
      }
      const traceService = inject(Sentry.TraceService);
      return setup.check();
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode() && !isNativePlatform(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
