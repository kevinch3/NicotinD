import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';
import { initSentry } from './app/observability/sentry';
import { isNativeShell } from './app/lib/platform';
import pkg from '../../../package.json';

// Guarded: a Sentry init failure must never prevent the app from bootstrapping
// (this runs before bootstrapApplication and was previously uncaught). Native
// shells get a trimmed init (no Session Replay / tracing) — see initSentry.
try {
  initSentry(environment, pkg.version, isNativeShell());
} catch (err) {
  console.error('Sentry init failed', err);
}

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
