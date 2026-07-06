import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NicotinDError } from '@nicotind/core';

const captureException = mock(() => {});
mock.module('@sentry/bun', () => ({
  captureException,
  init: mock(() => {}),
}));

import { errorHandler } from './error-handler.js';

// Minimal Hono-context stub — errorHandler only uses c.json(body, status).
const c = { json: (body: unknown, status: number) => ({ body, status }) } as never;

describe('errorHandler Sentry capture', () => {
  beforeEach(() => captureException.mockClear());

  it('captures unknown errors returned as 500', () => {
    const res = errorHandler(new Error('boom'), c) as { status: number };
    expect(res.status).toBe(500);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('does NOT capture NicotinDError (expected 4xx)', () => {
    const res = errorHandler(new NicotinDError('bad input', 'BAD', 400), c) as {
      status: number;
    };
    expect(res.status).toBe(400);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('does NOT capture connectivity errors (503)', () => {
    const res = errorHandler(new Error('ECONNREFUSED 127.0.0.1:5030'), c) as {
      status: number;
    };
    expect(res.status).toBe(503);
    expect(captureException).not.toHaveBeenCalled();
  });
});
