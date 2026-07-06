import type { ErrorHandler } from 'hono';
import { NicotinDError } from '@nicotind/core';
import * as Sentry from '@sentry/bun';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof NicotinDError) {
    return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
  }

  // Service connectivity and upstream errors
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('Unable to connect') ||
    msg.includes('ConnectionRefused') ||
    msg.includes('ECONNREFUSED')
  ) {
    return c.json({ error: 'Service unavailable', detail: msg }, 503);
  }
  if (msg.includes('slskd request failed')) {
    return c.json({ error: 'Soulseek service error', detail: msg }, 502);
  }

  console.error('Unhandled error:', err);
  // why: only genuinely unexpected 500-class failures reach Sentry. Expected
  // client errors (NicotinDError → 4xx) and upstream-offline connectivity errors
  // are handled and returned above, so they never get captured as noise.
  Sentry.captureException(err);
  return c.json({ error: 'Internal server error' }, 500);
};
