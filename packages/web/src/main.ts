import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';
import { loadSentry } from './app/observability/sentry';
import { installStartupErrorCapture, captureError } from './app/observability/error-buffer';
import { isNativeShell, applyTvBuildClass, isTvBuild } from './app/lib/platform';
import { clearStaleChunkMarker } from './app/lib/stale-chunk';
import { applyOverscan, loadOverscanPreset } from './app/lib/tv-overscan';
import pkg from '../../../package.json';

// Sentry is loaded lazily to keep its ~272 kB (42 % of the initial chunk) off
// the first-paint path (issue #285). A synchronous global capture is installed
// *first* so a startup/bootstrap failure is still buffered and replayed once the
// SDK resolves — the property the old eager init existed to provide.
const stopStartupCapture = installStartupErrorCapture();

// TV builds get the overscan safe-area layout (styles.css `.tv-build` rules) —
// stamped before bootstrap so the first paint is already inset.
applyTvBuildClass();
if (isTvBuild()) applyOverscan(loadOverscanPreset());

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
    // The app is running, so whatever build we are on is intact — release the
    // one-shot stale-chunk reload guard so a *future* deploy can recover too
    // (#925). Left set, the second stale chunk of a session would not reload.
    clearStaleChunkMarker();
    startSentry();
  })
  .catch((err) => {
    // Bootstrap failed: Angular isn't handling errors, so keep the startup
    // listeners and still load Sentry to report the failure via the buffer.
    captureError(err, 'bootstrap');
    console.error(err);
    startSentry();
  });
