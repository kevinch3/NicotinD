import * as Sentry from '@sentry/angular';

export interface SentryEnvironment {
  production: boolean;
  sentryDsn: string;
}

/**
 * Initialize browser Sentry. Opt-in: an empty `sentryDsn` (dev) is a no-op and
 * returns false, so no events/replays are sent. Prod uses low trace sampling and
 * tags every issue with the app version (release) + environment.
 */
export function initSentry(env: SentryEnvironment, release: string): boolean {
  if (!env.sentryDsn) return false;

  Sentry.init({
    dsn: env.sentryDsn,
    release,
    environment: env.production ? 'production' : 'development',
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
  return true;
}
