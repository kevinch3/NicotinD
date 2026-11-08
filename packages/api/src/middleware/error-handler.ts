import type { Context, ErrorHandler } from 'hono';
import { NicotinDError, createLogger } from '@nicotind/core';
import * as Sentry from '@sentry/bun';

/** The one method the handler logs through; injectable for tests. */
export interface WarnLogger {
  warn: (fields: Record<string, unknown>, msg: string) => void;
}

/** Seconds a client should wait before retrying a 503. */
export const RETRY_AFTER_S = 5;

/**
 * Every 503 is logged with its request and reason, and carries Retry-After.
 * A 503 used to leave the server log empty, so a self-hoster whose track did
 * not play had nothing to go on (#1726).
 */
function unavailable(log: WarnLogger, c: Context, reason: string, body: Record<string, unknown>) {
  log.warn(
    { method: c.req.method, path: c.req.path, status: 503, reason },
    'responding 503 service unavailable',
  );
  c.header('Retry-After', String(RETRY_AFTER_S));
  return c.json(body, 503);
}

export function createErrorHandler(log: WarnLogger): ErrorHandler {
  return (err, c) => {
    if (err instanceof NicotinDError) {
      if (err.statusCode === 503) {
        return unavailable(log, c, err.message, { error: err.message, code: err.code });
      }
      return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
    }

    // Service connectivity and upstream errors
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Unable to connect') ||
      msg.includes('ConnectionRefused') ||
      msg.includes('ECONNREFUSED')
    ) {
      return unavailable(log, c, msg, { error: 'Service unavailable', detail: msg });
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
}

export const errorHandler: ErrorHandler = createErrorHandler(createLogger('http-errors'));
