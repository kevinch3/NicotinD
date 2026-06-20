import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  inject,
  provideAppInitializer,
  isDevMode,
  InjectionToken,
} from '@angular/core';
import { provideRouter } from '@angular/router';
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
import { ApiService } from './services/api.service';
import pkg from '../../../../package.json';

export const APP_VERSION = new InjectionToken<string>('APP_VERSION');

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: APP_VERSION, useValue: pkg.version },
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideAppInitializer(() => {
      const setup = inject(SetupService);
      const theme = inject(ThemeService);
      const preserve = inject(PreserveService);
      const player = inject(PlayerService);
      const auth = inject(AuthService);
      const api = inject(ApiService);
      theme.apply();
      preserve.init();
      player.restoreState();
      // Sliding session: renew the token on every boot so an active user never
      // hits the expiry wall. Fire-and-forget — never block render; a failure is
      // handled by the auth interceptor (401 → logout → /login).
      if (auth.isAuthenticated()) {
        api.refreshToken().subscribe({
          next: (res) => auth.setToken(res.token),
          error: () => {},
        });
      }
      return setup.check();
    }),
    provideServiceWorker('ngsw-worker.js', {
      // Disabled in the native (Capacitor) shell: the WebView serves assets from a
      // local origin, so ngsw caching is redundant and can fight Capacitor's own
      // asset serving / cross-origin API calls. IndexedDB offline still works.
      enabled: !isDevMode() && !isNativePlatform(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
