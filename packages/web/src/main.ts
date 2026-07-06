import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';
import { initSentry } from './app/observability/sentry';
import pkg from '../../../package.json';

initSentry(environment, pkg.version);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
