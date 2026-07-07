import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

const initMock = mock(() => {});
const captureExceptionMock = mock((_err: unknown, _hint?: unknown) => {});
mock.module('@sentry/bun', () => ({
  init: initMock,
  captureException: captureExceptionMock,
}));

import { initServerSentry, captureProcessingFailure } from './sentry.js';

describe('initServerSentry', () => {
  const original = { ...process.env };

  beforeEach(() => {
    initMock.mockClear();
    delete process.env.NICOTIND_SENTRY_DSN;
    delete process.env.NICOTIND_SENTRY_TRACES_SAMPLE_RATE;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('returns false and does not init when DSN is unset', () => {
    expect(initServerSentry()).toBe(false);
    expect(initMock).not.toHaveBeenCalled();
  });

  it('returns false when DSN is blank/whitespace', () => {
    process.env.NICOTIND_SENTRY_DSN = '   ';
    expect(initServerSentry()).toBe(false);
    expect(initMock).not.toHaveBeenCalled();
  });

  it('inits with defaults when DSN is set', () => {
    process.env.NICOTIND_SENTRY_DSN = 'https://abc@o1.ingest.sentry.io/1';
    expect(initServerSentry()).toBe(true);
    expect(initMock).toHaveBeenCalledTimes(1);
    const cfg = (initMock.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    expect(cfg.dsn).toBe('https://abc@o1.ingest.sentry.io/1');
    expect(cfg.tracesSampleRate).toBe(0.1);
  });

  it('honors a custom traces sample rate', () => {
    process.env.NICOTIND_SENTRY_DSN = 'https://abc@o1.ingest.sentry.io/1';
    process.env.NICOTIND_SENTRY_TRACES_SAMPLE_RATE = '0.5';
    initServerSentry();
    const cfg = (initMock.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    expect(cfg.tracesSampleRate).toBe(0.5);
  });
});

describe('captureProcessingFailure', () => {
  beforeEach(() => captureExceptionMock.mockClear());

  it('captures one exception carrying the task, counts and sample', () => {
    captureProcessingFailure({
      task: 'key',
      failed: 25,
      applied: 0,
      sample: 'code 183: Invalid data',
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, hint] = (captureExceptionMock.mock.calls as unknown[][])[0] as [
      Error,
      Record<string, unknown>,
    ];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("task 'key'");
    expect(err.message).toContain('code 183');
    expect((hint.tags as Record<string, string>).processing_task).toBe('key');
    expect((hint.extra as Record<string, number>).failed).toBe(25);
    // Grouped so repeated identical failures collapse into one Sentry issue.
    expect(hint.fingerprint).toEqual(['library-processing', 'key', 'code 183: Invalid data']);
  });
});
