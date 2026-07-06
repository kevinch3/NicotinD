import * as Sentry from '@sentry/bun';
import pkg from '../../../../package.json';

/**
 * Initialize server-side Sentry. Opt-in: with no `NICOTIND_SENTRY_DSN` this is a
 * no-op and returns false, so an unconfigured deploy sends nothing. `@sentry/bun`
 * auto-captures uncaughtException / unhandledRejection once initialized.
 */
export function initServerSentry(): boolean {
  const dsn = process.env.NICOTIND_SENTRY_DSN?.trim();
  if (!dsn) return false;

  const parsed = Number(process.env.NICOTIND_SENTRY_TRACES_SAMPLE_RATE);
  const tracesSampleRate = Number.isFinite(parsed) ? parsed : 0.1;

  Sentry.init({
    dsn,
    release: pkg.version,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    tracesSampleRate,
  });
  return true;
}
