import { ApplicationConfig, provideBrowserGlobalErrorListeners, inject, provideAppInitializer, isDevMode, InjectionToken } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { authInterceptor } from './interceptors/auth.interceptor';
import { SetupService } from './services/setup.service';
import { ThemeService } from './services/theme.service';
import { PreserveService } from './services/preserve.service';
import { PlayerService } from './services/player.service';
import pkg from '../../package.json';

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
      theme.apply();
      preserve.init();
      player.restoreState();
      return setup.check();
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
