# Production-ready Sentry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the prototyped Sentry integration production-ready across the Angular web app and the Bun/Hono API, env-gated and opt-in, with CI tests and docs.

**Architecture:** Web keeps `@sentry/angular` but its `Sentry.init` moves into a testable `initSentry()` that no-ops on an empty DSN (dev = off, prod = on). The API gets `@sentry/bun`, initialized from `NICOTIND_SENTRY_DSN` (empty = disabled) at process boot, and reports only unknown 500-class errors via the existing Hono `errorHandler`.

**Tech Stack:** Bun, Hono, Angular v22, `@sentry/angular@^10.62.0`, `@sentry/bun@^10.62.0`, vitest (web), `bun:test` (API).

## Global Constraints

- Sentry SDK major version is **10** — pin `@sentry/bun` at `^10.62.0` to match `@sentry/angular`.
- **Opt-in / default-off:** with no config the integration must be fully inert on both surfaces. Web = empty DSN in `environment.ts`; API = unset `NICOTIND_SENTRY_DSN`.
- A Sentry DSN is a **public ingest key** — the web prod DSN stays committed in `environment.prod.ts`; do not treat it as a secret or move it to a runtime channel.
- Backend Sentry captures **only** the unknown 500-class path in `errorHandler`. Never capture `NicotinDError` (4xx) or the connectivity 502/503 branches.
- CI runs API tests via `bun test packages/api/src` (`ci.yml:52`) and web tests via `bun run --filter @nicotind/web test` (`ci.yml:58`). Every new test file must live under those paths. **The root `src/` dir is NOT in the CI test command** — backend Sentry logic therefore lives in `packages/api/src/`, not root `src/`.
- Quality Gates: every change tested + tested in CI + docs updated in the same change.
- Follow existing test style: API tests use `bun:test` + `mock.module`; web tests use vitest globals (`describe`/`it`/`expect`/`vi`, jsdom).

---

### Task 1: Backend Sentry init helper (`initServerSentry`)

**Files:**
- Create: `packages/api/src/observability/sentry.ts`
- Create (test): `packages/api/src/observability/sentry.test.ts`
- Modify: `packages/api/package.json` (add `@sentry/bun` dependency)
- Modify: `packages/api/src/index.ts` (re-export `initServerSentry`)

**Interfaces:**
- Produces: `initServerSentry(): boolean` — reads `NICOTIND_SENTRY_DSN` (trimmed; empty/unset ⇒ returns `false`, no init) and `NICOTIND_SENTRY_TRACES_SAMPLE_RATE` (default `0.1`). Re-exported from `@nicotind/api`.

- [ ] **Step 1: Add the dependency**

Edit `packages/api/package.json` — add to `dependencies` (keep alphabetical if the block is sorted):

```json
"@sentry/bun": "^10.62.0",
```

Then install:

Run: `bun install`
Expected: lockfile updates, `@sentry/bun@10.62.0` resolved. (Only `bun.lock` + the one package.json line should change — do not reformat the file.)

- [ ] **Step 2: Write the failing test**

Create `packages/api/src/observability/sentry.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/api/src/observability/sentry.test.ts`
Expected: FAIL — `Cannot find module './sentry.js'` (module not yet created).

- [ ] **Step 4: Write the helper**

Create `packages/api/src/observability/sentry.ts`:

```ts
import * as Sentry from '@sentry/bun';
import pkg from '../../../../package.json';

/**
 * Initialize server-side Sentry. Opt-in: with no `NICOTIND_SENTRY_DSN` this is a
 * no-op and returns false, so an unconfigured deploy sends nothing. `@sentry/bun`
 * auto-captures uncaughtException / unhandledRejection once initialized.
 */
export function initServerSentry(): boolean {
  const dsn = process.env.NICOTIND_SENTRY_DSN?.trim();
  if (!dsn) return false;

  const parsed = Number(process.env.NICOTIND_SENTRY_TRACES_SAMPLE_RATE);
  const tracesSampleRate = Number.isFinite(parsed) ? parsed : 0.1;

  Sentry.init({
    dsn,
    release: pkg.version,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    tracesSampleRate,
  });
  return true;
}
```

> Note: `import pkg from '../../../../package.json'` requires `resolveJsonModule` in
> the effective tsconfig (as `app.config.ts` already relies on). If `bun run typecheck`
> later complains, fall back to `release: process.env.npm_package_version ?? 'unknown'`
> and drop the JSON import — the tests don't assert `release`, so either works.

- [ ] **Step 5: Re-export from the package entry**

In `packages/api/src/index.ts`, add near the other exports (top-level, after imports):

```ts
export { initServerSentry } from './observability/sentry.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/api/src/observability/sentry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/api/package.json bun.lock packages/api/src/observability/sentry.ts packages/api/src/observability/sentry.test.ts packages/api/src/index.ts
git commit -m "feat(api): opt-in server-side Sentry init helper"
```

---

### Task 2: Capture unknown 500s in the API error handler

**Files:**
- Modify: `packages/api/src/middleware/error-handler.ts`
- Create (test): `packages/api/src/middleware/error-handler.test.ts`

**Interfaces:**
- Consumes: `@sentry/bun` `captureException`.
- Produces: no signature change to `errorHandler`; behavior — calls `Sentry.captureException(err)` only on the final unknown-error (500) branch.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/middleware/error-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NicotinDError } from '@nicotind/core';

const captureException = mock(() => {});
mock.module('@sentry/bun', () => ({
  captureException,
  init: mock(() => {}),
}));

import { errorHandler } from './error-handler.js';

// Minimal Hono-context stub — errorHandler only uses c.json(body, status).
const c = { json: (body: unknown, status: number) => ({ body, status }) } as never;

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/api/src/middleware/error-handler.test.ts`
Expected: FAIL — first test fails, `captureException` called 0 times (not yet wired).

- [ ] **Step 3: Wire capture into the 500 branch**

In `packages/api/src/middleware/error-handler.ts`, add the import at the top:

```ts
import * as Sentry from '@sentry/bun';
```

Then change the final branch (currently lines 22-23) from:

```ts
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
```

to:

```ts
  console.error('Unhandled error:', err);
  // why: only genuinely unexpected 500-class failures reach Sentry. Expected
  // client errors (NicotinDError → 4xx) and upstream-offline connectivity errors
  // are handled and returned above, so they never get captured as noise.
  Sentry.captureException(err);
  return c.json({ error: 'Internal server error' }, 500);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/api/src/middleware/error-handler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/middleware/error-handler.ts packages/api/src/middleware/error-handler.test.ts
git commit -m "feat(api): report unknown 500 errors to Sentry"
```

---

### Task 3: Boot server Sentry in the entry point + document env

**Files:**
- Modify: `src/main.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `initServerSentry` from `@nicotind/api` (Task 1).

> No new unit test: this is wiring an already-tested helper into the boot path. It is covered indirectly by Task 1's tests plus the existing server boot. Verify by build/typecheck.

- [ ] **Step 1: Import and call at boot**

In `src/main.ts`, add to the existing `@nicotind/api` import (currently `import { createApp } from '@nicotind/api';`):

```ts
import { createApp, initServerSentry } from '@nicotind/api';
```

Then, as the **first statement inside `main()`** (before `log.info('Starting NicotinD...')`), add:

```ts
  // Opt-in server-side error tracking. No-op unless NICOTIND_SENTRY_DSN is set.
  const sentryOn = initServerSentry();
  if (sentryOn) log.info('Sentry error tracking enabled');
```

- [ ] **Step 2: Document the env vars**

In `.env.example`, add a new block near the other `NICOTIND_*` options:

```bash
# Error tracking (Sentry) — opt-in. Leave DSN empty to disable entirely.
NICOTIND_SENTRY_DSN=
NICOTIND_SENTRY_TRACES_SAMPLE_RATE=0.1
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add src/main.ts .env.example
git commit -m "feat: initialize server Sentry at boot (opt-in via env)"
```

---

### Task 4: Web — extract testable `initSentry` + dev off

**Files:**
- Create: `packages/web/src/app/observability/sentry.ts`
- Create (test): `packages/web/src/app/observability/sentry.spec.ts`
- Modify: `packages/web/src/main.ts`
- Modify: `packages/web/src/environments/environment.ts`
- Modify: `packages/web/src/environments/environment.prod.ts`

**Interfaces:**
- Produces: `initSentry(env: SentryEnvironment, release: string): boolean` where `interface SentryEnvironment { production: boolean; sentryDsn: string }`. No-ops (returns `false`) when `sentryDsn` is empty.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/app/observability/sentry.spec.ts`:

```ts
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

  it('inits with release, environment and prod sampling when DSN present', () => {
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
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @nicotind/web test -- sentry.spec`
Expected: FAIL — cannot resolve `./sentry` (not yet created).
(If the local run errors on the known `localStorage.clear` env gap instead, that is the documented local vitest gap — this test still runs in CI via `ci.yml:58`.)

- [ ] **Step 3: Write the module**

Create `packages/web/src/app/observability/sentry.ts`:

```ts
import * as Sentry from '@sentry/angular';

export interface SentryEnvironment {
  production: boolean;
  sentryDsn: string;
}

/**
 * Initialize browser Sentry. Opt-in: an empty `sentryDsn` (dev) is a no-op and
 * returns false, so no events/replays are sent. Prod uses low trace sampling and
 * tags every issue with the app version (release) + environment.
 */
export function initSentry(env: SentryEnvironment, release: string): boolean {
  if (!env.sentryDsn) return false;

  Sentry.init({
    dsn: env.sentryDsn,
    release,
    environment: env.production ? 'production' : 'development',
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --filter @nicotind/web test -- sentry.spec`
Expected: PASS (2 tests). (Or verify via CI if blocked by the local env gap.)

- [ ] **Step 5: Rewire `main.ts` and turn dev off**

Replace `packages/web/src/main.ts` entirely with:

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';
import { initSentry } from './app/observability/sentry';
import pkg from '../../../package.json';

initSentry(environment, pkg.version);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
```

In `packages/web/src/environments/environment.ts`, set the dev DSN empty (Sentry off in dev):

```ts
export const environment = {
  production: false,
  sentryDsn: '', // empty = Sentry disabled in dev
};
```

Leave `packages/web/src/environments/environment.prod.ts` DSN as-is (public ingest key), but update its comment to reflect the versioned/sampled prod setup:

```ts
export const environment = {
  production: true,
  sentryDsn: 'https://10c3535096cee5fd283f70bbeb0b0f3b@o432900.ingest.us.sentry.io/4511658482991104', // Prod Sentry DSN (public ingest key)
};
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/app/observability/sentry.ts packages/web/src/app/observability/sentry.spec.ts packages/web/src/main.ts packages/web/src/environments/environment.ts packages/web/src/environments/environment.prod.ts
git commit -m "feat(web): testable opt-in Sentry init, disabled in dev"
```

---

### Task 5: Web — test the CTA directive

**Files:**
- Create (test): `packages/web/src/app/directives/sentry-cta.directive.spec.ts`

> The directive already exists (`sentry-cta.directive.ts`); this task adds its missing test coverage per Quality Gate 1.

**Interfaces:**
- Consumes: `SentryCtaDirective` (existing) `onClick(event: Event)` + `ctaName` input; `@sentry/angular` `captureMessage`.

- [ ] **Step 1: Write the test**

Create `packages/web/src/app/directives/sentry-cta.directive.spec.ts`:

```ts
import { vi } from 'vitest';
import * as Sentry from '@sentry/angular';
import { SentryCtaDirective } from './sentry-cta.directive';

vi.mock('@sentry/angular', () => ({
  captureMessage: vi.fn(),
}));

describe('SentryCtaDirective', () => {
  beforeEach(() => vi.clearAllMocks());

  it('captures a CTA message with tags on click', () => {
    const directive = new SentryCtaDirective();
    directive.ctaName = 'download-album';
    directive.onClick(new Event('click'));

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'CTA Clicked: download-album',
      expect.objectContaining({
        level: 'info',
        tags: expect.objectContaining({ type: 'cta_click', cta_name: 'download-album' }),
      }),
    );
  });

  it('does nothing when ctaName is empty', () => {
    const directive = new SentryCtaDirective();
    directive.onClick(new Event('click'));
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun run --filter @nicotind/web test -- sentry-cta.directive.spec`
Expected: PASS (2 tests). (Or verify via CI if blocked by the local env gap.)

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/app/directives/sentry-cta.directive.spec.ts
git commit -m "test(web): cover the Sentry CTA directive"
```

---

### Task 6: Documentation (Quality Gate 3)

**Files:**
- Create: `docs/observability.md`
- Modify: `CLAUDE.md` (add one index line under Key Design Patterns)

- [ ] **Step 1: Write the feature doc**

Create `docs/observability.md`:

```markdown
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
- `[appSentryCta]` (`directives/sentry-cta.directive.ts`) emits a `captureMessage`
  breadcrumb on click for CTA analytics; safely no-ops when Sentry is uninitialized.

## API (Bun/Hono)

- `initServerSentry()` (`packages/api/src/observability/sentry.ts`) runs first in
  `src/main.ts`. It reads `NICOTIND_SENTRY_DSN` (**empty = disabled**, default off,
  matching the plugin/acquisition opt-in ethos) and
  `NICOTIND_SENTRY_TRACES_SAMPLE_RATE` (default `0.1`). `@sentry/bun` auto-captures
  `uncaughtException` / `unhandledRejection` once initialized.
- The Hono `errorHandler` reports **only the unknown 500-class branch**. It
  deliberately skips `NicotinDError` (expected 4xx) and the connectivity 502/503
  branches, so routine "bad request" / "slskd offline" outcomes never become Sentry
  noise.

## Config

| Var | Default | Effect |
| --- | --- | --- |
| `NICOTIND_SENTRY_DSN` | (empty) | Server DSN; empty disables server Sentry |
| `NICOTIND_SENTRY_TRACES_SAMPLE_RATE` | `0.1` | Server performance trace sampling |

Web DSN is build-time (`environment.prod.ts`); there is no runtime web-DSN channel
(YAGNI for the operator's own deploys).

## Tests

- API: `packages/api/src/observability/sentry.test.ts` (init on/off) +
  `packages/api/src/middleware/error-handler.test.ts` (captures 500s, skips 4xx/503).
- Web: `app/observability/sentry.spec.ts` (init on/off + prod config) +
  `directives/sentry-cta.directive.spec.ts`.
- CI: API via `ci.yml:52`, web via `ci.yml:58`.
```

- [ ] **Step 2: Add the CLAUDE.md index line**

In `CLAUDE.md`, under **## Key Design Patterns**, add one bullet (place it after the "Auth flow" bullet):

```markdown
- **Observability (Sentry, opt-in)**: web `initSentry` (empty DSN = off, prod-only, versioned + low sampling) + API `initServerSentry` (`NICOTIND_SENTRY_DSN` empty = off) reporting only unknown 500s from the Hono `errorHandler` (4xx/connectivity skipped). → [docs/observability.md](docs/observability.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/observability.md CLAUDE.md
git commit -m "docs: document opt-in Sentry observability"
```

---

## Final verification (after all tasks)

- [ ] Run full API suite: `bun test packages/api/src` — Expected: PASS incl. the 2 new Sentry files.
- [ ] Run typecheck: `bun run typecheck` — Expected: PASS.
- [ ] Run lint: `bun run lint` — Expected: PASS.
- [ ] Confirm web specs are picked up in CI (`ci.yml:58` runs `@nicotind/web test`); the two new `.spec.ts` files match the vitest glob.
- [ ] Sanity: with no `NICOTIND_SENTRY_DSN` set, `bun run src/main.ts` boots without the "Sentry error tracking enabled" log line.
```
