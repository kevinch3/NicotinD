# End-to-End Tests (Playwright)

`packages/e2e` is a Bun workspace package holding the Playwright browser suite. It
boots the **real** server (`bun run src/main.ts`) against a throwaway DB and a tiny
committed music library, then drives the Angular SPA in Chromium. It complements
the unit tiers (`bun test` for the API, vitest for web) by covering the wiring no
unit can: boot → auth → scan → stream → playback → plugin gating.

## What it covers

| Spec                           | Asserts                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/auth.setup.ts`          | (setup project) seeds the admin via `/api/setup/complete`, kicks `/api/system/scan`, waits for the fixture album, saves an authenticated `storageState` reused by every other spec                                                            |
| `tests/auth.spec.ts`           | login (valid) lands in the app + logout; invalid creds bounce back to `/login` (the 401 interceptor) and stay unauthenticated                                                                                                                 |
| `tests/library.spec.ts`        | the 7-track fixture album shows in the Albums grid and its tracklist renders; the loose single is **not** in the grid                                                                                                                         |
| `tests/playback.spec.ts`       | Play Album fires a `206`/`200` on `/api/stream/...` and an `<audio>` element advances                                                                                                                                                         |
| `tests/player.spec.ts`         | pause/resume, next-track, seek (click the progress bar → position jumps), shuffle toggle                                                                                                                                                      |
| `tests/plugins.spec.ts`        | the compliance contract: the URL-acquire box is absent until an admin enables the consent-gated yt-dlp `resolve` plugin, and reappears/disappears with enable/disable                                                                         |
| `tests/onboarding.spec.ts`     | (**`onboarding` project**, own fresh server) drives the 4-step setup wizard end-to-end incl. the Advanced/Lidarr panel, then confirms it lands authenticated in the app                                                                       |
| `tests/welcome-banner.spec.ts` | an admin-provisioned user sees the first-login welcome banner and can dismiss it (seeded server)                                                                                                                                              |
| `tests/song-menu.spec.ts`      | on an album detail page: the unified `⋯` row menu's common actions + "Go to album" suppression, "Song info" opens the track-info sheet, admin "Remove from library" → global `ConfirmHost` → row removal (see `docs/song-actions.md#testing`) |

## How it runs

- **Server**: Playwright's `webServer` runs `bun run src/main.ts` from the repo root
  on port **8585** (`E2E_PORT` to override) so it never collides with a developer's
  instance on 8484. It waits on `GET /api/health` (`{ ok: true, version }`).
- **Isolation / determinism**: `playwright.config.ts` wipes `packages/e2e/.tmp-data`
  at config-eval time (before the server boots), so every run starts at
  `needsSetup: true` and the setup project's admin is always the first user.
  `NICOTIND_MODE=external` plus dead `NICOTIND_SLSKD_URL`/`NICOTIND_LIDARR_URL`
  (`http://127.0.0.1:1`) keep the test server from reaching — or mutating — any real
  slskd/Lidarr. No slskd/Lidarr is needed: acquisition is default-off, so auth,
  library, playback and gating all work with zero plugins enabled.
- **Onboarding wizard needs a never-seeded server**: the setup wizard only renders
  when `needsSetup: true` (zero users), but the setup project seeds an admin on the
  main server. So a **second** managed server boots on **8586** (`E2E_ONBOARDING_PORT`)
  with its own `.tmp-data-onboarding` DB, and the `onboarding` project targets it
  with **no `storageState` and no `setup` dependency**. Completing the wizard creates
  the first admin — a one-shot per server — so the spec is a single end-to-end pass.
  The onboarding project is **omitted in external/prod-smoke mode** (`E2E_BASE_URL`):
  the setup wizard must never run against a real instance.
- **Selectors**: the suite selects on `data-testid` attributes added to the relevant
  components (login/setup/search/library/album-detail/plugins/player). **This is the
  e2e selector standard** — prefer adding a `data-testid` over text/CSS coupling when
  writing new specs. `app-password-field` forwards a `testId` input to its inner
  `<input>`.
- **Fixtures**: `fixtures/music/**` are committed silent 30s tagged FLACs generated by
  `scripts/make-fixtures.ts` (ffmpeg). 30s gives seek/pause/next headroom so a track
  doesn't auto-advance mid-assertion. Regenerate only when the desired fixture library
  changes (`bun run --filter @nicotind/e2e make-fixtures`) and **commit the output** —
  CI has no ffmpeg.

## What the e2e environment does NOT give you (write specs against this list)

Recurring wrong assumptions that have shipped red CI. Check every new spec
against these before pushing; if you discover a new one, add it here in the
same PR that hit it.

- **The `request` fixture is NOT authenticated.** The setup project's
  `storageState` only persists **localStorage** (the app keeps its JWT in
  `nicotind_token` — there is no auth cookie), and Playwright's `request`
  fixture sends cookies, not localStorage. Any direct API call must log in
  and attach the header explicitly:

  ```ts
  import { ADMIN, bearer } from '../helpers';
  const { token } = await (
    await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    })
  ).json();
  const res = await request.get('/api/playlists', { headers: bearer(token) });
  ```

  `page`-driven navigation IS authenticated (the browser context restores
  localStorage); only out-of-band `request`/`page.request` calls need the
  explicit header. Assuming otherwise yields 401s that read like route bugs
  (this bit `playlist-from-acquire.spec.ts` on first landing).

- **No resolve/acquisition plugin is enabled on a fresh server.** Acquisition
  is default-off, so every capability-gated surface — the link-intent card,
  acquire buttons, `POST /api/acquire` succeeding — is absent until a spec
  enables a plugin itself. The archive.org plugin is the one that works
  without a binary (fetch-based); enable it through the UI like
  `plugins.spec.ts` does, and **disable it again in `afterEach`** so the
  plugin-gating suite's "fresh install enables nothing" assertion stays true
  in any order.

- **No slskd, no Lidarr, no network egress assumptions.** Both URLs point at
  `http://127.0.0.1:1` (dead on purpose); anything that fans out to them
  fails soft. A spec can't exercise a real download/hunt — cover that logic
  at the unit/integration level and test the _surface_ (gating, forwarding,
  rendering) in e2e.

- **The fixture library is minimal.** Silent FLACs from `fixtures/music/**`,
  no acquire jobs, no user playlists, no curated content beyond what boot
  seeds. Don't assert on content existing unless the setup project or your
  spec created it.

## Running locally

```bash
bunx playwright install chromium            # one-time, from packages/e2e
bun run --filter @nicotind/web build        # Hono serves packages/web/dist
bun run --filter @nicotind/e2e test         # or: bun run e2e (from repo root)
bun run --filter @nicotind/e2e test:ui      # interactive UI mode
```

> The web build requires Node ≥ 22.22.3 (`@angular/build` engine check). The
> version is pinned **once** in `.nvmrc` (`22.22.3`); local dev (`nvm use`), CI
> (`actions/setup-node@v4` with `node-version-file: .nvmrc`), and the Dockerfile
> (`imbios/bun-node:…-22.22.3`) all resolve from it, and root + web `package.json`
> declare `engines.node >= 22.22.3`. If `ng build`/`ng test` fail an engine check,
> run `nvm use` (the host default nvm Node — `22.22.0` — is below the floor).

## Prod smoke

Point the suite at a running instance and the managed `webServer` is skipped:

```bash
E2E_BASE_URL=https://nicotined.kevinroberts.ar \
  bun run --filter @nicotind/e2e test tests/auth.spec.ts
```

Use read-only/login-style specs only — do not seed or destroy prod data.

## CI

The `e2e` job in `.github/workflows/deploy.yml` installs deps + the Chromium
browser, builds web (the Hono server serves `packages/web/dist`), runs the suite,
and uploads the Playwright HTML report on failure. `release` and `deploy` depend on
`[ci, e2e]`, so a red e2e run blocks the deploy.

The CI `ci` job also runs `bun test packages/e2e/playground` — the **pure logic**
of the playground harness below (observation model, report rendering, the response +
console classifiers, the friction/journey model). The playground _flows_ need a live
backend and stay out of CI; their helpers are unit-tested so regressions in the
feedback machinery are still caught.

## Playground harness (automated feedback)

The playground is a **continuous feedback gatherer**, not a pass/fail suite. It
drives real user flows and **records observations** — timings, result counts,
dead-ends (gaps), enhancement ideas, cover-art 404s — that a custom reporter
aggregates into a findings report (`packages/e2e/playground-report/*.{md,json}`).
It is the automated successor to the hand-written
[`e2e-playground-findings-2026-06.md`](e2e-playground-findings-2026-06.md) sessions
(it implements that doc's §E2 recommendation).

**Gated, never in CI.** Acquisition flows (catalog/hunt/network) need a live
slskd/Lidarr, so the harness runs only under `PLAYGROUND=1` and stays out of the CI
`e2e` job. Flows **degrade gracefully**: a dead backend yields a `degraded`
observation (and the report is marked "managed"), never a red test — so it's safe
to run anywhere.

```bash
# Against a live stack (full feedback):
PLAYGROUND=1 E2E_BASE_URL=https://your-stack \
  PLAYGROUND_USERNAME=you PLAYGROUND_PASSWORD=… \
  bun run --filter @nicotind/e2e playground

# Against the managed throwaway server (degraded — proves the harness, no real acquisition):
bun run --filter @nicotind/e2e playground
```

| Flow (spec)                                 | Gathers                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/song-acquisition.playground.ts` (§F) | Reachability of a single song ("Toxic"): catalog is album-only, count of network files to sift, absence of a song-first affordance                                                                                                                                                                                                                                                                                          |
| `tests/catalog-quality.playground.ts` (§A)  | For a non-distinctive artist, the share of album cards that actually belong to the matched artist (own-album ratio)                                                                                                                                                                                                                                                                                                         |
| `tests/album-hunt.playground.ts` (§C)       | Base/skew hunt latency + candidate count / dead-end. **Opt-in** via `PLAYGROUND_HUNT=1` (resolve adds a monitored artist to Lidarr); never triggers a download                                                                                                                                                                                                                                                              |
| `tests/network-search.playground.ts` (§C2)  | Time-to-first-result vs time-to-complete for a niche query                                                                                                                                                                                                                                                                                                                                                                  |
| `tests/metadata-fix.playground.ts` (§G)     | For an album (first in the library, or `PLAYGROUND_FIX_ALBUM`), candidate count + top-candidate confidence the fix modal would surface for a query; flags a 0-candidate gap                                                                                                                                                                                                                                                 |
| `tests/downloads.playground.ts`             | Downloads feed (read-only): Active/Offline/Recent tab friction, feed-item count, retry/cancel/remove affordance presence                                                                                                                                                                                                                                                                                                    |
| `tests/playlists.playground.ts`             | **Self-cleaning** create → render → delete round-trip (local feature, safe on prod); counts steps to build a playlist                                                                                                                                                                                                                                                                                                       |
| `tests/sharing.playground.ts`               | Mints a share link, opens `/share/:token` in a fresh **unauthenticated** context, verifies the read-only view (and that auth chrome doesn't leak); tokens self-expire                                                                                                                                                                                                                                                       |
| `tests/admin-plugins.playground.ts`         | `/settings/plugins` + `/admin` read-only: enabled-plugin count, slskd status, console health. A single toggle is gated behind `PLAYGROUND_PLUGIN_TOGGLE=<id>` and reverted                                                                                                                                                                                                                                                  |
| `tests/remote-playback.playground.ts`       | **Two-context** cast/device-control: a controller tab + a target speaker tab (distinct `nicotind_device_id` seeded per context) opt in, the controller discovers + casts to the target, then relays a remote PAUSE. Records device-discovery / cast-to-playback / PAUSE-round-trip latencies + opt-in friction. Mutates only **ephemeral** per-session playback state (self-resets when the target disconnects at teardown) |

- **Structure**: pure logic in `playground/{observe,report,net-monitor,console-monitor,journey}.ts`
  (unit-tested, CI-covered); the Playwright fixture (`playground/fixtures.ts`) auto-
  monitors **responses** (cover-art 404s, 503s, 5xx, slow calls) **and runtime health**
  — `page.on('console')`/`pageerror`/`requestfailed` → `console-monitor.ts` (a real
  `console.error` during a normal flow is a defect signal even when every HTTP call was
  200; a small ignore list drops env noise). The `obs` recorder also exposes
  `obs.time()`, `obs.journey()` (**friction / step-count** — `step`/`fallback`/`deadEnd`,
  auto-flushed at teardown), and `obs.outcome('success'|'partial'|'degraded'|'failed')`
  (a terminal success measurement). The report renders an **Outcome matrix** and a
  **Health summary** on top of the per-flow detail; the reporter (`playground/reporter.ts`)
  writes it.
- **Tuning queries** via env: `PLAYGROUND_SONG_QUERY`, `PLAYGROUND_ARTIST`,
  `PLAYGROUND_NETWORK_QUERY`, `PLAYGROUND_HUNT_ARTIST` / `PLAYGROUND_HUNT_ALBUM`,
  `PLAYGROUND_FIX_ALBUM` / `PLAYGROUND_FIX_QUERY`, `PLAYGROUND_PLUGIN_TOGGLE`.
- **Adding a flow**: drop a `tests/*.playground.ts` that imports `test`/`expect` from
  `../playground/fixtures`, records via `obs.record(...)`, tracks friction with
  `obs.journey()`, and ends with `obs.outcome(...)`; the gated project picks it up
  automatically (`testMatch: /\.playground\.ts$/`). Keep mutations self-cleaning (a
  `finally` that undoes anything created) so the flow is safe against prod.

### Real round-trip (`*.real.ts`) — opt-in, mutating, auto-cleanup

The one config that performs **genuinely mutating acquisition** against a live backend:
`playwright.real.config.ts` runs `tests/real-roundtrip.real.ts`, which **acquires** an
album (URL via the search omnibox's link-intent card, or artist/album via the hunt path), waits for it to
**land in the library**, verifies it's **playable** (a `206`/`200` range request), and then
**DELETES it** in a `finally` — so prod is left clean even if the flow fails mid-way. It
measures the end-to-end experience the synthetic flows can't (acquire → in-library →
playable timings, step-count, console health). A deliberate **two-key guard** (`E2E_BASE_URL`
**and** `PLAYGROUND_REAL=1`) means a stray `playwright test` can never trigger real
downloads/removals.

```bash
E2E_BASE_URL=https://your-stack PLAYGROUND_REAL=1 \
  PLAYGROUND_USERNAME=you PLAYGROUND_PASSWORD=… \
  PLAYGROUND_REAL_URL=https://… \
  bun run --filter @nicotind/e2e playground:real
# or PLAYGROUND_REAL_ARTIST=… PLAYGROUND_REAL_ALBUM=… for the hunt path.
```

> See **[testing-routines.md](testing-routines.md)** for the full flow catalogue (every
> main flow × which tier covers it) and the recurring routines (when to run what).

### Screenshot flows (`*.screens.ts`)

A parallel family of flows captures **screenshots** for manual UX review rather than
(or in addition to) observations. They are `tests/*.screens.ts` drivers — **never
matched by the default `testMatch`** (which requires `test`/`spec`), so they only run
under a dedicated `--config` and stay out of CI, like the playground flows. Shots land
under `screenshots/mobile/<flow>/NN-label.png` via the pure `playground/shot.ts`
helper (`shotPath`/`shot`, unit-tested in the `ci` job alongside `observe`/`report`).

| Config                              | Backend                             | Flows                                                                                   |
| ----------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| `playwright.screenshots.config.ts`  | managed server + fixtures (Pixel 7) | `mobile-screenshots.screens.ts` — library / album / player / now-playing / song-details |
| `playwright.hunt.config.ts`         | **live** (`E2E_BASE_URL`, Pixel 7)  | `hunt-mobile` + `network-album-download` — **mutates prod** (real downloads)            |
| `playwright.live-screens.config.ts` | **live** (`E2E_BASE_URL`, Pixel 7)  | `player-analysis` + `downloads-acquire` — read-mostly; mutating sub-steps env-gated     |

The **live-screens** config doubles as a findings run: its two flows use the playground
`obs` fixture, so the config also wires `playground/reporter.ts` and a single run emits
both the per-flow screenshots **and** `playground-report/*.{md,json}` (timings, cover-art
404s, gated-state gaps).

```bash
# Live mobile screenshots + findings (read-mostly default):
E2E_BASE_URL=https://nicotined.kevinroberts.ar \
  PLAYGROUND_USERNAME=claude-e2e PLAYGROUND_PASSWORD=… \
  bun run --filter @nicotind/e2e screens:live
```

- `player-analysis.screens.ts` — plays a real track, walks Now Playing
  (shuffle/repeat/queue/radio) + the track-info sheet. BPM analysis (writes a tag) and
  genre apply (admin write) are gated behind **`PLAYGROUND_ANALYZE=1`**.
- `downloads-acquire.screens.ts` — Get-from-a-link box, watchlist star (toggled then
  reverted), archive.org lane (captures its gated state), and the three Downloads tabs.
  Actually pasting a URL to acquire is gated behind **`PLAYGROUND_ACQUIRE_URL=<url>`**
  (`PLAYGROUND_ACQUIRE_QUERY` tunes the catalog query).
- The few elements these flows target that lacked stable hooks gained `data-testid`s
  (`now-playing-{shuffle,repeat,radio,queue}`, `downloads-tab-{active,offline,recent}`,
  `offline-storage-bar`); their presence is asserted by the CI `mobile-ux.spec.ts` /
  `downloads.spec.ts` so the screenshot flows can't silently rot.
