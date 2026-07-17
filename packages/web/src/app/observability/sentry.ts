import * as Sentry from '@sentry/angular';

export interface SentryEnvironment {
  production: boolean;
  sentryDsn: string;
}

/**
 * Initialize browser Sentry. Opt-in: an empty `sentryDsn` (dev) is a no-op and
 * returns false, so no events/replays are sent. Prod uses low trace sampling and
 * tags every issue with the app version (release) + environment.
 *
 * `nativeShell` (Capacitor / Electron) drops Session Replay + browser tracing:
 * both instrument the WebView main thread heavily (rrweb DOM recording, wrapping
 * every fetch/XHR) and ran before Angular even bootstrapped — the prime suspect
 * for the Android release ANR on an offline launch, where they also churned on
 * the failing offline requests. Error reporting is kept everywhere.
 */
export function initSentry(env: SentryEnvironment, release: string, nativeShell = false): boolean {
  if (!env.sentryDsn) return false;

  Sentry.init({
    dsn: env.sentryDsn,
    release,
    environment: env.production ? 'production' : 'development',
    sendDefaultPii: false,
    integrations: nativeShell
      ? []
      : [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    // Tracing/replay sampling only matters when those integrations are present.
    tracesSampleRate: nativeShell ? 0 : 0.1,
    replaysSessionSampleRate: nativeShell ? 0 : 0.1,
    replaysOnErrorSampleRate: nativeShell ? 0 : 1.0,
  });
  return true;
}
