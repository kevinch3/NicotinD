import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NicotinDError, ServiceUnavailableError } from '@nicotind/core';

const captureException = mock(() => {});
mock.module('@sentry/bun', () => ({
  captureException,
  init: mock(() => {}),
}));

import { createErrorHandler } from './error-handler.js';

// The logger is injected rather than module-mocked: another suite may load the
// handler first, and then a module mock would never reach it.
const warn = mock((..._args: unknown[]) => {});
const errorHandler = createErrorHandler({ warn });

// Minimal Hono-context stub: the request line, c.header() and c.json().
const headers: Record<string, string> = {};
const c = {
  req: { method: 'GET', path: '/api/stream/abc' },
  header: (k: string, v: string) => void (headers[k] = v),
  json: (body: unknown, status: number) => ({ body, status }),
} as never;

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

// #1726: a 503 from /api/stream reached a self-hoster's player with nothing in
// the server log, so "why did this track not play" had no answer.
describe('errorHandler 503s', () => {
  beforeEach(() => {
    warn.mockClear();
    for (const k of Object.keys(headers)) delete headers[k];
  });

  it('logs the request and the reason for a connectivity 503', () => {
    errorHandler(new Error('ECONNREFUSED 127.0.0.1:8686'), c);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ method: 'GET', path: '/api/stream/abc', status: 503 });
    expect(String(fields.reason)).toContain('ECONNREFUSED');
    expect(msg).toContain('503');
  });

  it('logs a ServiceUnavailableError too, not just raw connectivity errors', () => {
    const res = errorHandler(new ServiceUnavailableError('archive.org'), c) as { status: number };
    expect(res.status).toBe(503);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String((warn.mock.calls[0] as [Record<string, unknown>])[0].reason)).toContain(
      'archive.org',
    );
  });

  it('tells the client when to retry', () => {
    errorHandler(new Error('Unable to connect'), c);
    expect(headers['Retry-After']).toBe('5');
  });

  it('stays quiet for an expected 4xx', () => {
    errorHandler(new NicotinDError('bad input', 'BAD', 400), c);
    expect(warn).not.toHaveBeenCalled();
  });
});
