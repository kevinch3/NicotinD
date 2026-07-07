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

/** Summary of a library-processing run's failures, for Sentry + logs. */
export interface ProcessingFailureReport {
  /** Task the failures came from (or null for a mixed/aggregate run). */
  task: string | null;
  /** Number of items that failed to enrich in the run. */
  failed: number;
  /** Number of items that succeeded in the run. */
  applied: number;
  /** A representative failure reason (e.g. ffmpeg's stderr tail), if any. */
  sample: string | null;
}

/**
 * Report a batch of library-processing failures to Sentry as one aggregated
 * event (never one-per-file — a broken ffmpeg build would otherwise flood the
 * project). No-op when Sentry isn't initialized (`captureException` is a safe
 * no-op then), so unconfigured deploys stay silent. Grouped by task + sample so
 * repeated identical failures collapse into a single Sentry issue.
 */
export function captureProcessingFailure(report: ProcessingFailureReport): void {
  const err = new Error(
    `Library processing: ${report.failed} item(s) failed` +
      (report.task ? ` in task '${report.task}'` : '') +
      (report.sample ? ` — ${report.sample}` : ''),
  );
  err.name = 'LibraryProcessingFailure';
  Sentry.captureException(err, {
    tags: { scope: 'library-processing', processing_task: report.task ?? 'mixed' },
    extra: {
      task: report.task,
      failed: report.failed,
      applied: report.applied,
      sample: report.sample,
    },
    // Group all failures of a task+reason into one issue rather than per-message.
    fingerprint: ['library-processing', report.task ?? 'mixed', report.sample ?? 'unknown'],
  });
}
