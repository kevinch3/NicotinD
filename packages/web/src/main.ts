import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';
import { loadSentry } from './app/observability/sentry';
import { installStartupErrorCapture, captureError } from './app/observability/error-buffer';
import { isNativeShell } from './app/lib/platform';
import pkg from '../../../package.json';

// Sentry is loaded lazily to keep its ~272 kB (42 % of the initial chunk) off
// the first-paint path (issue #285). A synchronous global capture is installed
// *first* so a startup/bootstrap failure is still buffered and replayed once the
// SDK resolves — the property the old eager init existed to provide.
const stopStartupCapture = installStartupErrorCapture();

// Native shells get a trimmed init (no Session Replay / tracing) — see loadSentry.
function startSentry(): void {
  loadSentry(environment, pkg.version, isNativeShell()).catch((err) =>
    console.error('Sentry load failed', err),
  );
}

bootstrapApplication(App, appConfig)
  .then(() => {
    // Angular's provideBrowserGlobalErrorListeners now owns runtime errors, so
    // drop the pre-bootstrap listeners to avoid double-reporting, then load the
    // SDK off the critical path.
    stopStartupCapture();
    startSentry();
  })
  .catch((err) => {
    // Bootstrap failed: Angular isn't handling errors, so keep the startup
    // listeners and still load Sentry to report the failure via the buffer.
    captureError(err, 'bootstrap');
    console.error(err);
    startSentry();
  });
