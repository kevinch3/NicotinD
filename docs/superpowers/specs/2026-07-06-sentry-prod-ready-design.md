# Production-ready Sentry — Design

**Date:** 2026-07-06
**Branch:** `feature/sentry`
**Status:** Approved (design)

## Problem

The `feature/sentry` branch (commit `6f59143`, 2026-07-01) prototypes Sentry in the
Angular web app only. It is not production-ready:

- Dev and prod `environment.*.ts` share **one DSN** at `tracesSampleRate: 1.0`, so dev
  noise + session replays pollute the prod Sentry project and burn replay quota.
- No way to disable Sentry (always on, DSN baked in).
- No backend coverage — server-side (Bun/Hono) errors only reach pino.
- Fails the project Quality Gates: no tests, no CI coverage, no docs.

## Goals

Make Sentry production-ready across **web + API backend**, env-gated and opt-in,
with tests that run in CI and docs, per the Quality Gates.

## Context / constraints

- **Distribution:** the operator (repo owner) runs the only instances that report to
  this Sentry project — no public-self-hoster DSN-leak concern. Baking the web DSN is
  acceptable; a Sentry DSN is a **public ingest key** by design (meant to ship in
  client bundles), not a secret.
- **No runtime-config channel** exists from API → web today (web reads a build-time
  `environment.ts`). Building one is out of scope (YAGNI); web DSN stays build-time.
- Backend runs on **Bun** → use `@sentry/bun`.
- CI runs API tests via `bun test packages/api/src` (`ci.yml:52`) and web vitest via
  `bun run --filter @nicotind/web test` (`ci.yml:58`). New tests on either side are
  covered.
- Local web vitest has a known env gap (`localStorage.clear is not a function`) — web
  tests are verified via CI, API tests locally.

## Design

### 1. Web (Angular) — harden existing wiring

- Extract init into a **testable** `initSentry(environment)` in
  `packages/web/src/app/observability/sentry.ts`. It **no-ops when `sentryDsn` is
  empty** — the on/off switch. `main.ts` calls it before `bootstrapApplication`.
- `environment.ts` (dev): `sentryDsn: ''` (Sentry off in dev).
  `environment.prod.ts`: keep the DSN (public ingest key).
- Prod `Sentry.init` config:
  - `tracesSampleRate: 0.1` (was `1.0`)
  - `replaysSessionSampleRate: 0.1`, `replaysOnErrorSampleRate: 1.0` (unchanged)
  - `release: APP_VERSION` (from `package.json`), `environment` (prod/dev)
  - `sendDefaultPii: false`
  - integrations: `browserTracingIntegration()`, `replayIntegration()` (unchanged)
- Keep the `ErrorHandler` (`Sentry.createErrorHandler`) and `Sentry.TraceService`
  providers in `app.config.ts`, and the `appSentryCta` directive (already no-ops when
  Sentry is uninitialized).

### 2. API (Bun/Hono) backend — new

- Add `@sentry/bun` as a dependency of **both** the root `package.json` (for the
  `src/main.ts` entry) and `packages/api/package.json` (for `error-handler.ts`), so
  it resolves from either. In the Bun workspace it hoists to one install.
- Init at the **top of `src/main.ts`**, before `createApp`, via a small
  `initSentry()` helper reading env:
  - `NICOTIND_SENTRY_DSN` — **empty = disabled** (default off, matches
    plugin/acquisition opt-in ethos).
  - `NICOTIND_SENTRY_TRACES_SAMPLE_RATE` — default `0.1`.
  - `release` = `package.json` version, `environment`.
  - `@sentry/bun` auto-captures `uncaughtException` / `unhandledRejection` once
    initialized — no manual process wiring.
- Wire into the existing `errorHandler` (`packages/api/src/middleware/error-handler.ts`):
  call `Sentry.captureException(err)` **only on the unknown 500-class path**.
  Deliberately **skip**:
  - `NicotinDError` (expected 4xx) — routine client errors.
  - connectivity branches (502 slskd / 503 service unavailable) — routine
    "upstream offline" noise.
  A `// why` comment documents the skip rationale.

### 3. Config & docs

- `.env.example`: add, documented as opt-in —
  - `NICOTIND_SENTRY_DSN=` (empty = off)
  - `NICOTIND_SENTRY_TRACES_SAMPLE_RATE=0.1`
- New `docs/observability.md`: full rationale — DSN-is-public note, why dev is off,
  why 4xx/connectivity are skipped, sampling choices, web vs API knobs.
- One-line **CLAUDE.md** index entry under Key Design Patterns pointing at
  `docs/observability.md`.

### 4. Tests (Quality Gate 1 + 2)

- **API** — `packages/api/src/middleware/error-handler.test.ts`: mock `@sentry/bun`;
  assert `captureException` **is** called for an unknown `Error` (→ 500) and **is
  not** called for a `NicotinDError` (4xx) nor a connection-refused error (→ 503).
  Runs in CI (`ci.yml:52`).
- **Web** — `sentry.spec.ts`: assert `initSentry` no-ops with empty DSN and calls
  `Sentry.init` with the expected `release`/sampling when a DSN is present.
  `sentry-cta.directive.spec.ts`: assert `captureMessage` fires with the right
  `cta_name` tag on click. Runs in CI (`ci.yml:58`).

## Out of scope (YAGNI)

- Runtime-config endpoint for the web DSN (build-time env is fine for the operator's
  own deploys).
- Enforcing separate Sentry projects per surface — web and API each take their own DSN
  knob; operator points them wherever.

## Acceptance

- Sentry off with no config (empty DSN) on both surfaces; on when DSN set.
- Prod web reports at 0.1 trace sampling with versioned releases; dev reports nothing.
- Backend 500s reach Sentry; 4xx and upstream-offline errors do not.
- New API + web tests pass in CI.
- `docs/observability.md` + CLAUDE.md index entry + `.env.example` updated in the same
  change.
