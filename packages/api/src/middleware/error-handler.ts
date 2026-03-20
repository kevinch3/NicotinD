import type { ErrorHandler } from 'hono';
import { NicotinDError } from '@nicotind/core';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof NicotinDError) {
    return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
  }

  // Service connectivity errors
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Unable to connect') || msg.includes('ConnectionRefused') || msg.includes('ECONNREFUSED')) {
    return c.json({ error: 'Service unavailable', detail: msg }, 503);
  }

  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
};
