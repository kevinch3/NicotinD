# Observability (Sentry)

Error tracking + performance/session-replay via Sentry, **opt-in on both
surfaces** and inert when unconfigured.

## Web (Angular)

- `initSentry(environment, release)` (`app/observability/sentry.ts`) is called from
  `main.ts` before bootstrap. It **no-ops when `sentryDsn` is empty**, so dev
  (`environment.ts`, empty DSN) sends nothing; prod (`environment.prod.ts`) is on.
- A Sentry DSN is a **public ingest key** by design — the prod DSN is committed in
  `environment.prod.ts`; it is not a secret and does not belong in a runtime channel.
- Prod config: `tracesSampleRate: 0.1`, session replay `0.1` / on-error `1.0`,
  `sendDefaultPii: false`, and every issue tagged with `release` (app version) +
  `environment`.

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
  windowed library processor (`library-processing.service.ts`) to report enrichment
  failures (ffmpeg decode / analysis-sidecar errors) as **one aggregated event per
  failing task per run**. It tags `scope: 'library-processing'` + `processing_task`,
  and sets a `['library-processing', task, sample]` fingerprint so a broken decoder
  collapses into a single grouped issue instead of one event per file. No-op when
  Sentry is unconfigured. → [library-processing.md](library-processing.md).

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
- CI: API via `ci.yml:52`, web via `ci.yml:58`.
