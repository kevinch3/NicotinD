import type { ErrorHandler } from 'hono';
import { NicotinDError } from '@nicotind/core';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof NicotinDError) {
    return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
  }

  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
};
