import { vi } from 'vitest';
import * as Sentry from '@sentry/angular';
import { loadSentry } from './sentry';
import { captureError, _resetErrorBuffer } from './error-buffer';

vi.mock('@sentry/angular', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
}));

describe('loadSentry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetErrorBuffer();
  });

  it('no-ops when the DSN is empty (and never dynamically loads the SDK)', async () => {
    const result = await loadSentry({ production: false, sentryDsn: '' }, '1.0.0');
    expect(result).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('inits with release, environment and prod sampling when DSN present (web)', async () => {
    const result = await loadSentry(
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

  it('drops Session Replay + browser tracing on native shells', async () => {
    // Regression: rrweb DOM recording + fetch/XHR wrapping on the WebView main
    // thread (running before bootstrap, churning on failing offline requests) was
    // the prime suspect for the Android release ANR on an offline launch.
    const result = await loadSentry(
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

  // The whole property #285's lazy approach must preserve: an error captured
  // BEFORE the SDK finished loading is still reported once it connects.
  it('replays an error buffered before the SDK loaded', async () => {
    const boom = new Error('startup boom');
    captureError(boom, 'bootstrap');
    await loadSentry({ production: true, sentryDsn: 'https://abc@o1.ingest.sentry.io/1' }, '1.2.3');
    expect(Sentry.captureException).toHaveBeenCalledWith(boom);
  });

  it('forwards errors captured after the SDK connected', async () => {
    await loadSentry({ production: true, sentryDsn: 'https://abc@o1.ingest.sentry.io/1' }, '1.2.3');
    const later = new Error('later');
    captureError(later);
    expect(Sentry.captureException).toHaveBeenCalledWith(later);
  });
});
