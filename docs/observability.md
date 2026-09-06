# Observability (Sentry)

Error tracking + performance/session-replay via Sentry, **opt-in on both
surfaces** and inert when unconfigured.

## Web (Angular)

- **The SDK is loaded lazily (issue #285).** Sentry is ~272 kB — 42 % of the initial
  chunk, Session Replay alone 124 kB — so `loadSentry(environment, release, nativeShell?)`
  (`app/observability/sentry.ts`) reaches the SDK only via a dynamic
  `import('@sentry/angular')`, which esbuild splits into a lazy chunk off the first-paint
  path. `main.ts` calls it in the post-bootstrap `.then()` (and on the `.catch()` for a
  bootstrap failure). It **no-ops when `sentryDsn` is empty**, so dev (`environment.ts`,
  empty DSN) sends nothing; prod (`environment.prod.ts`) is on.
- **Startup-error capture is preserved by a buffer, not by eager init.**
  `error-buffer.ts` records errors synchronously; `main.ts` installs
  `installStartupErrorCapture()` (global `error`/`unhandledrejection` listeners) *before*
  bootstrap, and the Angular `ErrorHandler` is `BufferingErrorHandler` (a Sentry-free class
  replacing `Sentry.createErrorHandler()`). Anything captured before the SDK resolves is
  replayed the moment `loadSentry` calls `connectErrorSink` — the property the old eager
  init existed for, now without the 272 kB on first paint. The pre-bootstrap listeners are
  removed once bootstrap succeeds (Angular's `provideBrowserGlobalErrorListeners` owns
  runtime errors, so we don't double-report). `Sentry.TraceService` was dropped with the
  eager import; only Angular-router navigation spans are lost (browser-side tracing still
  runs once the SDK loads). The whole property is regression-tested — `sentry.spec.ts`
  "replays an error buffered before the SDK loaded".
- A Sentry DSN is a **public ingest key** by design — the prod DSN is committed in
  `environment.prod.ts`; it is not a secret and does not belong in a runtime channel.
- Prod config (web/browser): `tracesSampleRate: 0.1`, session replay `0.1` / on-error
  `1.0`, `sendDefaultPii: false`, and every issue tagged with `release` (app version) +
  `environment`.
- **Native shells (Capacitor / Electron) drop Session Replay + browser tracing**
  (`nativeShell=true`, passed via `isNativeShell()` from `main.ts`): both instrument the
  WebView main thread heavily (rrweb DOM recording, wrapping every fetch/XHR) — the prime
  suspect for the Android **release** ANR on an offline launch, where they churned on the
  failing offline requests. Error reporting is kept; only replay/tracing (and their sample
  rates → 0) are removed. (Since #285 the SDK loads lazily on every surface, which also
  keeps it off the pre-bootstrap path everywhere — but the native trimming stays, because
  the instrumentation is still WebView-heavy once loaded.) See
  [docs/mobile-app.md](mobile-app.md) §Network / offline detection.

## API (Bun/Hono)

- `initServerSentry()` (`packages/api/src/observability/sentry.ts`) is invoked at
  **process load** from `src/instrument.ts`, which `src/main.ts` imports on its first
  line — before the `createApp` import pulls in Hono/http. This ordering lets
  `@sentry/bun`'s auto-instrumentation patch those modules for HTTP tracing. The
  isolated `@nicotind/api/instrument` export subpath keeps the API barrel out of the
  preload. It reads `NICOTIND_SENTRY_DSN` (**empty = disabled**, default off,
  matching the plugin/acquisition opt-in ethos) and
  `NICOTIND_SENTRY_TRACES_SAMPLE_RATE` (default `0.1`). `@sentry/bun` auto-captures
  `uncaughtException` / `unhandledRejection` once initialized.
- The Hono `errorHandler` reports **only the unknown 500-class branch**. It
  deliberately skips `NicotinDError` (expected 4xx) and the connectivity 502/503
  branches, so routine "bad request" / "slskd offline" outcomes never become Sentry
  noise.
- `captureProcessingFailure(report)` is a second, non-HTTP capture path used by the
  library processor (`library-processing.service.ts`) to report enrichment
  failures (ffmpeg decode / analysis-sidecar errors) as **one aggregated event per
  failing task per run**. It tags `scope: 'library-processing'` + `processing_task`,
  and sets a `['library-processing', task, sample]` fingerprint so a broken decoder
  collapses into a single grouped issue instead of one event per file. No-op when
  Sentry is unconfigured. → [library-processing.md](library-processing.md).

## Metadata-provider health (Lidarr + MusicBrainz)

Sentry sees only unknown 500s, so a metadata-provider outage was invisible to every
operator surface: both client seams log the failure exactly once and ~20 downstream
call sites then degrade it to `[]`/`null` (issue #670). `packages/core/src/provider-health.ts`
counts what those seams see.

- `recordProviderCall(provider, outcome)` is called from the two — and only two — places
  every outbound call passes through: `LidarrClient.request()`
  (`packages/lidarr-client/src/client.ts`, 13 methods behind it) and
  `MusicBrainzClient.fetch()` (`packages/api/src/services/musicbrainz-client.ts`, whose
  `FetchOutcome` already discriminated transient-vs-confirmed for the cache). The counters
  are **module-level, not per-instance**: `MusicBrainzClient` is constructed in eight
  places while the runtime Lidarr is a single instance, so per-instance counters would
  report whichever one the route happened to hold.
- **A MusicBrainz 404 counts as `ok`.** It is MusicBrainz answering authoritatively that
  the MBID does not exist — the provider working. Counting it as a failure would make the
  success rate track library *coverage* instead of provider health.
- Storage is a fixed ring of one-minute buckets over `PROVIDER_HEALTH_WINDOW_MS` (15 min),
  never an event list, so a provider failing thousands of times an hour costs the same
  memory as an idle one. `providerHealthSnapshot()` sums the buckets inside the window into
  `{ok, failed, timedOut, successRate, lastFailureAt, lastFailureKind, lastFailureStatus,
  windowMs}` per provider.
- `lastFailure*` is deliberately **not** windowed: "when did it last break" is a different
  question from the rate, and outlives it.
- `successRate` reads 1 for a window with no calls, which is why the Admin chip checks
  `ok + failed` first and shows a grey "Idle" rather than a reassuring 100 %. Nothing is
  polled or probed — the numbers are a by-product of calls the app was already making, so
  an idle window means "no data", not "healthy".
- Surfaced as the `providers` slice of `GET /api/admin/review`, rendered by
  `system-health-panel` as one row per provider (`data-testid="provider-health"`). The
  web mirror of the field is optional, because the native shells point at a
  user-configured server that can be older than the app.

## Config

| Var | Default | Effect |
| --- | --- | --- |
| `NICOTIND_SENTRY_DSN` | (empty) | Server DSN; empty disables server Sentry |
| `NICOTIND_SENTRY_TRACES_SAMPLE_RATE` | `0.1` | Server performance trace sampling |

Web DSN is build-time (`environment.prod.ts`); there is no runtime web-DSN channel
(YAGNI for the operator's own deploys).

## Tests

- API: `packages/api/src/observability/sentry.test.ts` (init on/off +
  `captureProcessingFailure` grouping/extra) +
  `packages/api/src/middleware/error-handler.test.ts` (captures 500s, skips 4xx/503).
- Web: `app/observability/sentry.spec.ts` (init on/off + prod config).
- Provider health: `packages/core/src/provider-health.test.ts` (window rollup, rate
  arithmetic, last-failure fields, boundedness), the "provider-health counters" blocks in
  `packages/lidarr-client/src/client.test.ts` and
  `packages/api/src/services/musicbrainz-client.test.ts` (per-class recording, and the 404
  that must not count as an outage), and "metadata-provider health (#670)" in
  `packages/api/src/routes/review.test.ts` (own field + degraded path).
- CI: API via `ci.yml:52`, web via `ci.yml:58`.
