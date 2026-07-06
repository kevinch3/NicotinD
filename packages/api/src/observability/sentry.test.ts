import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

const initMock = mock(() => {});
mock.module('@sentry/bun', () => ({
  init: initMock,
  captureException: mock(() => {}),
}));

import { initServerSentry } from './sentry.js';

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
    const cfg = initMock.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.dsn).toBe('https://abc@o1.ingest.sentry.io/1');
    expect(cfg.tracesSampleRate).toBe(0.1);
  });

  it('honors a custom traces sample rate', () => {
    process.env.NICOTIND_SENTRY_DSN = 'https://abc@o1.ingest.sentry.io/1';
    process.env.NICOTIND_SENTRY_TRACES_SAMPLE_RATE = '0.5';
    initServerSentry();
    const cfg = initMock.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.tracesSampleRate).toBe(0.5);
  });
});
