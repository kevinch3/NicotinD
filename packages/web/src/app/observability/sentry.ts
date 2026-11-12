// `import type` is erased at compile time, so this pulls in NO runtime code —
// the only runtime reference to the SDK is the dynamic `import()` below, which
// is what lets esbuild split @sentry into a lazy chunk (issue #285).
import type * as SentryNs from '@sentry/angular';
import { connectErrorSink } from './error-buffer';

// why: SDK v11 dropped `sendDefaultPii` and defaults to collecting cookies, headers, user
// info and request/response bodies (a login body carries a password). This is the
// migration guide's "keep the v10 default" baseline — see docs/observability.md.
const SENTRY_REDACTED_KEYS = ['forwarded', '-ip', 'remote-', 'via', '-user'];
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: SENTRY_REDACTED_KEYS },
    response: { deny: SENTRY_REDACTED_KEYS },
  },
  httpBodies: [],
  urlQueryParams: { deny: SENTRY_REDACTED_KEYS },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
} satisfies SentryNs.BrowserOptions['dataCollection'];

/**
 * True for a page load that is not a real user: a browser driven by automation
 * (Playwright/WebDriver set `navigator.webdriver`) or a web build served from a
 * loopback host (e2e, `bun run src/main.ts`, a local `ng serve` of the prod
 * config). Both bundle the prod DSN, so without this every e2e test is a Sentry
 * session and burns the replay quota. Electron is exempt from the host check —
 * it always loads `http://127.0.0.1:<port>`.
 */
export function isNonUserSession(
  nav: Pick<Navigator, 'webdriver'>,
  hostname: string,
  nativeShell: boolean,
): boolean {
  if (nav.webdriver) return true;
  if (nativeShell) return false;
  return (
    /^(localhost|127(\.\d+){3}|\[::1\]|::1)$/.test(hostname) || hostname.endsWith('.localhost')
  );
}

export interface SentryEnvironment {
  production: boolean;
  sentryDsn: string;
}

/**
 * Lazily load and initialize browser Sentry, then connect it to the error buffer
 * so anything captured before it resolved is replayed (issue #285). The SDK is
 * ~272 kB / 42 % of the initial chunk (Session Replay alone is 124 kB), so it is
 * dynamically imported *after* first paint and off the critical path. Startup-
 * error capture is preserved by `error-buffer.ts`, not by eager init.
 *
 * Opt-in: an empty `sentryDsn` (dev) is a no-op returning false, so no events or
 * replays are sent. Prod uses low trace sampling and tags every issue with the
 * app version (release) + environment.
 *
 * `nativeShell` (Capacitor / Electron) still drops Session Replay + browser
 * tracing: both instrument the WebView main thread heavily (rrweb DOM recording,
 * wrapping every fetch/XHR) and were the prime suspect for the Android release
 * ANR on an offline launch. Error reporting is kept everywhere.
 */
export async function loadSentry(
  env: SentryEnvironment,
  release: string,
  nativeShell = false,
  capacitor = false,
  page: { nav: Pick<Navigator, 'webdriver'>; hostname: string } = {
    nav: navigator,
    hostname: location.hostname,
  },
): Promise<boolean> {
  // The Android/TV/iOS apps report nothing: even with no integrations passed,
  // Sentry's defaults send a session on every launch, which F-Droid counts as
  // tracking (#1502). Web and Electron keep error reporting.
  if (!env.sentryDsn || capacitor) return false;
  if (isNonUserSession(page.nav, page.hostname, nativeShell)) return false;
  const Sentry: typeof SentryNs = await import('@sentry/angular');
  Sentry.init({
    dsn: env.sentryDsn,
    release,
    environment: env.production ? 'production' : 'development',
    dataCollection: SENTRY_DATA_COLLECTION,
    integrations: nativeShell
      ? []
      : [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    // Tracing/replay sampling only matters when those integrations are present.
    tracesSampleRate: nativeShell ? 0 : 0.1,
    replaysSessionSampleRate: nativeShell ? 0 : 0.1,
    replaysOnErrorSampleRate: nativeShell ? 0 : 1.0,
  });
  // Drain everything the buffer collected before the SDK resolved, and forward
  // all future errors straight through.
  connectErrorSink(({ error }) => Sentry.captureException(error));
  return true;
}
