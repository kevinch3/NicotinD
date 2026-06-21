# Testing routines — what to run, when, and how to read it

This is the index for **how NicotinD is exercised**: every main user flow, which test
tier covers it, and the recurring routines a maintainer runs. It complements
[e2e.md](e2e.md) (the Playwright/playground reference) — read that for the mechanics;
read this to decide *what to run today*.

## The three tiers (and why CI stays smoke)

| Tier | What it is | Where | When |
|------|-----------|-------|------|
| **CI smoke** | Deterministic pass/fail specs (`tests/*.spec.ts`) on a throwaway server with committed fixtures. Fast, no external services. | `ci.yml` `e2e` job | Every push/PR |
| **Playground feedback** | `tests/*.playground.ts` — record *observations* (timings, gaps, friction, console health, outcome), never assert. Run live (full signal) or managed (degraded). Safe on prod (read-only or self-cleaning). | `bun run … playground` | Weekly / before a release / when chasing a friction report |
| **Real round-trip** | `tests/real-roundtrip.real.ts` — genuinely **acquires → verifies → deletes** against prod, with auto-cleanup. Opt-in (two-key guard). | `bun run … playground:real` | Pre-release, or when validating the acquisition pipeline end-to-end |
| **Screenshot / UX** | `tests/*.screens.ts` — capture mobile screens for manual review (+ findings via the `obs` fixture). | `bun run … screens:live` | Before a UI/mobile release |

**CI is deliberately smoke-only.** Acquisition flows need live slskd/Lidarr and/or
mutate state, so the real feedback lives in the playground/real tiers — not CI. Adding
breadth to CI buys little (it can't reach the network) and costs flakiness; invest the
effort in the playground instead. The *pure* harness logic (observation model, report
rendering, response/console classifiers, friction model) **is** unit-tested in CI
(`bun test packages/e2e/playground`) so the feedback machinery can't rot.

## Flow catalogue

Coverage legend: **CI** smoke spec · **PG** playground feedback flow · **Real** round-trip ·
**Shot** screenshot flow · **Manual** = exercise by hand. Deps: **L** local-only · **X** needs
an external service (slskd/Lidarr/plugin).

| Flow | Deps | Coverage |
|------|------|----------|
| Auth — setup / login / logout / token refresh | L | CI (`auth.spec.ts`) |
| Library — albums grid, artist/album detail, singles, genres | L | CI (`library.spec.ts`), PG (cover-404 health on every flow) |
| Playback — play/pause/next/seek/shuffle, streaming, media session | L | CI (`playback.spec.ts`, `player.spec.ts`), Shot (`player-analysis`) |
| Remote playback — cast to another device, remote PLAY/PAUSE, device discovery | L | PG (`remote-playback`, two-context: controller + target speaker) |
| Search — unified (local + network), song-first lane | L+X | PG (`song-acquisition`, `network-search`) |
| Catalog (metadata) search + discography | X | PG (`catalog-quality`) |
| Album hunt | X | PG (`album-hunt`, opt-in), Shot (`hunt-mobile`, `network-album-download`) |
| Acquire — URL "Get from a link" / archive.org / Spotify | X | PG (`song-acquisition` affordance), Shot (`downloads-acquire`), **Real** (`real-roundtrip`) |
| Watchlist | L | Shot (`downloads-acquire` star toggle) |
| Downloads — feed, tabs, retry/cancel/remove | L+X | CI (`downloads.spec.ts`), PG (`downloads`) |
| Metadata — fix modal, optimize, BPM/genre analysis | X | CI (`metadata-fix.spec.ts`), PG (`metadata-fix`), Shot (`player-analysis` analyze) |
| Playlists — create / add / reorder / delete | L | PG (`playlists`, self-cleaning) |
| Sharing — mint link, anonymous read-only view | L | PG (`sharing`, self-cleaning) |
| Admin / plugins — enable-state, system status, gating | L | CI (`plugins.spec.ts`), PG (`admin-plugins`) |
| Album deletion / removals | L | **Real** (`real-roundtrip` teardown), Manual |
| Theme / favicon / mobile safe-area | L | CI (`theme.spec.ts`, `favicon.spec.ts`, `mobile-ux.spec.ts`) |

## Recurring routines

### A. Weekly live feedback pass

```bash
PLAYGROUND=1 E2E_BASE_URL=https://nicotined.kevinroberts.ar \
  PLAYGROUND_USERNAME=you PLAYGROUND_PASSWORD=… \
  bun run --filter @nicotind/e2e playground
```

Reads `playground-report/playground-report.md`:
- **Outcomes** — per-flow `success`/`partial`/`degraded`/`failed`. Anything not `success`
  on a live run is a lead.
- **Health** — runtime errors (console errors, uncaught page errors, real request
  failures). `✅ No runtime errors` is the goal; any 🔴 is a defect even if the flow
  "worked".
- **Top signals** — high/medium gaps, friction (fallbacks/dead-ends), slow calls.

File anything worth acting on into [e2e-playground-findings-2026-06.md](e2e-playground-findings-2026-06.md)
(structured, §-numbered) or the rolling [feedback-log-2026-06.md](feedback-log-2026-06.md)
(real-use friction). Recurring friction across runs = a prioritization signal.

### B. Pre-release real round-trip (mutating — opt-in)

```bash
E2E_BASE_URL=https://nicotined.kevinroberts.ar PLAYGROUND_REAL=1 \
  PLAYGROUND_USERNAME=you PLAYGROUND_PASSWORD=… \
  PLAYGROUND_REAL_URL=https://… \
  bun run --filter @nicotind/e2e playground:real
```

Acquires a real album, confirms it's in the library and playable, then **deletes it**.
Check the report's `Acquire → in library` / `First-byte → playable` timings and confirm
`Albums acquired + removed by this run` matches what was created (a cleanup failure is
surfaced as a 🔴 in Health — remove the leftover manually if so). Use a small, reliably
available source.

### C. Mobile/UX screenshot pass (before a UI release)

```bash
E2E_BASE_URL=… PLAYGROUND_USERNAME=… PLAYGROUND_PASSWORD=… \
  bun run --filter @nicotind/e2e screens:live
```

Shots land under `screenshots/mobile/<flow>/`; this run also emits the findings report.

### D. Monthly feedback-log rotation

Rotate `docs/feedback-log-YYYY-MM.md`, carry forward open items, and promote recurring
clusters into the findings doc as workstreams.

## Conventions

- **Selector standard**: `data-testid`. New playground-targeted elements get one, and its
  presence is asserted in a CI spec so it can't silently rot (see `downloads.spec.ts`,
  `mobile-ux.spec.ts`).
- **Safe on prod**: playground/screenshot flows are read-only or self-cleaning (a `finally`
  that undoes any mutation). Only the real round-trip deletes — and it cleans up after
  itself.
- **Degrade, never red**: a missing backend/feature records a `degraded` observation, not a
  test failure, so the report is always produced.
