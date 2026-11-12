import { vi } from 'vitest';
import * as Sentry from '@sentry/angular';
import { isNonUserSession, loadSentry, SENTRY_DATA_COLLECTION } from './sentry';
import { captureError, _resetErrorBuffer } from './error-buffer';

vi.mock('@sentry/angular', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
}));

const DSN = { production: true, sentryDsn: 'https://abc@o1.ingest.sentry.io/1' };
// jsdom's own hostname is `localhost`, which loadSentry now (rightly) skips.
const USER_PAGE = { nav: { webdriver: false }, hostname: 'music.example.org' };

describe('isNonUserSession', () => {
  it.each(['localhost', '127.0.0.1', '127.0.1.1', '[::1]', 'nicotind.localhost'])(
    'treats loopback host %s as non-user on the web',
    (host) => expect(isNonUserSession({ webdriver: false }, host, false)).toBe(true),
  );

  it.each(['music.example.org', '192.168.1.20', 'kpc.tailnet.ts.net'])(
    'treats %s as a real user',
    (host) => expect(isNonUserSession({ webdriver: false }, host, false)).toBe(false),
  );

  it('treats any automated browser as non-user, whatever the host', () => {
    expect(isNonUserSession({ webdriver: true }, 'music.example.org', false)).toBe(true);
    expect(isNonUserSession({ webdriver: true }, '127.0.0.1', true)).toBe(true);
  });

  // Electron always loads http://127.0.0.1:<port>; loopback is its normal origin.
  it('keeps the Electron shell on its loopback origin', () => {
    expect(isNonUserSession({ webdriver: false }, '127.0.0.1', true)).toBe(false);
  });
});

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
    const result = await loadSentry(DSN, '1.2.3', false, false, USER_PAGE);
    expect(result).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://abc@o1.ingest.sentry.io/1',
        release: '1.2.3',
        environment: 'production',
        tracesSampleRate: 0.1,
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
        dataCollection: SENTRY_DATA_COLLECTION,
      }),
    );
    // v11 collects bodies, cookies and user info unless told not to.
    expect(SENTRY_DATA_COLLECTION).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
    });
    // Web keeps the heavy integrations.
    expect(Sentry.browserTracingIntegration).toHaveBeenCalled();
    expect(Sentry.replayIntegration).toHaveBeenCalled();
  });

  // #1502: the F-Droid APKs must not contact sentry.io — the SDK's default
  // session integration alone sends one envelope per launch.
  it('never loads the SDK inside the Capacitor apps, even with a DSN', async () => {
    const result = await loadSentry(DSN, '1.2.3', true, true, USER_PAGE);
    expect(result).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  // e2e serves the prod bundle (DSN included) from localhost to Playwright: every
  // test was a Sentry session and the replay quota drained in days.
  it('never loads the SDK for an automated browser or a loopback web host', async () => {
    expect(
      await loadSentry(DSN, '1.2.3', false, false, { ...USER_PAGE, nav: { webdriver: true } }),
    ).toBe(false);
    expect(
      await loadSentry(DSN, '1.2.3', false, false, { ...USER_PAGE, hostname: 'localhost' }),
    ).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('drops Session Replay + browser tracing on native shells', async () => {
    // Regression: rrweb DOM recording + fetch/XHR wrapping on the WebView main
    // thread (running before bootstrap, churning on failing offline requests) was
    // the prime suspect for the Android release ANR on an offline launch.
    const result = await loadSentry(DSN, '1.2.3', true, false, USER_PAGE);
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
    await loadSentry(DSN, '1.2.3', false, false, USER_PAGE);
    expect(Sentry.captureException).toHaveBeenCalledWith(boom);
  });

  it('forwards errors captured after the SDK connected', async () => {
    await loadSentry(DSN, '1.2.3', false, false, USER_PAGE);
    const later = new Error('later');
    captureError(later);
    expect(Sentry.captureException).toHaveBeenCalledWith(later);
  });
});
