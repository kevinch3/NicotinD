import { vi } from 'vitest';
import * as Sentry from '@sentry/angular';
import { initSentry } from './sentry';

vi.mock('@sentry/angular', () => ({
  init: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
}));

describe('initSentry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops when the DSN is empty', () => {
    const result = initSentry({ production: false, sentryDsn: '' }, '1.0.0');
    expect(result).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('inits with release, environment and prod sampling when DSN present (web)', () => {
    const result = initSentry(
      { production: true, sentryDsn: 'https://abc@o1.ingest.sentry.io/1' },
      '1.2.3',
    );
    expect(result).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://abc@o1.ingest.sentry.io/1',
        release: '1.2.3',
        environment: 'production',
        tracesSampleRate: 0.1,
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
        sendDefaultPii: false,
      }),
    );
    // Web keeps the heavy integrations.
    expect(Sentry.browserTracingIntegration).toHaveBeenCalled();
    expect(Sentry.replayIntegration).toHaveBeenCalled();
  });

  it('drops Session Replay + browser tracing on native shells', () => {
    // Regression: rrweb DOM recording + fetch/XHR wrapping on the WebView main
    // thread (running before bootstrap, churning on failing offline requests) was
    // the prime suspect for the Android release ANR on an offline launch.
    const result = initSentry(
      { production: true, sentryDsn: 'https://abc@o1.ingest.sentry.io/1' },
      '1.2.3',
      true,
    );
    expect(result).toBe(true);
    expect(Sentry.browserTracingIntegration).not.toHaveBeenCalled();
    expect(Sentry.replayIntegration).not.toHaveBeenCalled();
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: [],
        tracesSampleRate: 0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
      }),
    );
  });
});
