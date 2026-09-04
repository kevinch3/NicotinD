# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

**This file is orientation, not the index and not a detail store.** It loads into *every* request,
so every byte here is paid on every task — including the many tasks that never need the index at
all. It carries only what is worth that price: how to build and test, what the repo *is*, and where
to look next.

**The index itself is [docs/index.md](docs/index.md)** — every mechanism, the symbols you would grep
for, and the doc that explains why. It is read when you need to locate something, not on every
request (#934). An entry's shape is fixed there: **name**, one sentence of *what it is*, the symbols,
and the link. No rationale, no issue narratives, no prod numbers — those go in the linked doc.

`bun run check:claude-md` enforces both files: a named symbol that exists nowhere in code, a link to
a doc that does not exist, an entry over its character cap, and either file over its own byte budget.
The two budgets are deliberately different sizes — CLAUDE.md's is the per-request cost and the one to
defend.

**When you change behavior**, update the linked `docs/` page in the same commit, and touch the index
line in `docs/index.md` only if the *name* or the *location* changed.
→ [quality-gates.md](docs/quality-gates.md)

## Quality Gates

Three gates, all mandatory before a task is done.

1. **Every change is tested.** Features get tests, fixes get regression tests, refactors keep
   coverage. If it cannot be unit-tested, add an integration or e2e test.
2. **Every test runs in CI.** `bun run verify` runs every gate job (`ci` + `web-test` + `storybook`)
   in one command — use it before pushing. `check:ci-parity` keeps it honest. `bun run e2e` is
   deliberately outside `verify` (own CI job, minutes long) — run it before declaring a feature done,
   especially after any `data-testid`, popover or route-DOM change.
3. **Docs are updated in the same commit as the code.** A doc statement made wrong by a change is a
   bug. Detail goes in `docs/<feature>.md` or [design-patterns.md](docs/design-patterns.md); the
   index line here just points at it; a short `// why` comment carries local rationale.

→ [quality-gates.md](docs/quality-gates.md) for what each gate measures and why gates assert their
own denominator.

## What is NicotinD?

A unified music acquisition + streaming platform. Acquisition sources are external, Torrentio-style
**addons** (core carries zero source-specific code and talks to them over the acquisition addon
protocol); NicotinD **natively scans and streams** the music library itself. Downloads land in a
shared folder, get organized, and are incrementally scanned into the canonical SQLite library the API
streams from. Navidrome, the `/rest/*` Subsonic proxy and the original playlist feature were removed
in the native migration.

## Commands

```bash
bun install              # Install all workspace dependencies
bun run verify           # Every gate the CI gate jobs run — run this before pushing
bun run typecheck        # tsc --build + Angular templates + e2e specs + web specs (all four surfaces)
bun run lint             # ESLint over packages/*/src + src + scripts (quote the globs). NOT packages/web (#612)
bun run test             # Vitest across packages/ + src/
bun run test:web         # Angular component tests (vitest, never `ng test`)
bun run e2e              # Playwright suite — always run before declaring a feature done
bun run e2e:tv           # Android TV emulator lane (real APK on an AVD)
bun run format           # Prettier — .ts only, never Markdown/YAML
bun run format:check     # CI gate
bun run release          # Bump version, generate CHANGELOG, tag (:minor / :major to force)
bun run src/main.ts      # Start NicotinD (requires .env or config/default.yml)
```

**Check gates** (all CI-blocking unless noted): `check:claude-md` (this file's *and*
`docs/index.md`'s symbols, links and size) · `check:ci-parity` (a gate job step `verify` misses, or a gate that stopped blocking
`release`) · `check:action-runtimes` (an action pinned to a retired Node runtime, or one the floor
table cannot classify) · `check:route-auth` (an `/api` group mounted with no auth decision) · `check:audit` (an
advisory that both ships and matches the resolved version) · `check:shared-helpers` (a shared helper
re-implemented locally) · `check:library-walkers` (a `musicDir` walker that skips the reserved-path
predicate) · `check:search-matching` (a name search done in raw SQL, bypassing the shared
folded matcher) · `check:json` (duplicate keys) · `check:shipped-issues` (report, not a gate)
· `check:isolated-specs` (slow, not a gate). → [quality-gates.md](docs/quality-gates.md)

**Diagnostics**: `bun run packages/api/src/scripts/prod-probe.ts --orphans --jobs` (read-only prod/dev
DB probe) → [prod-inspection.md](docs/prod-inspection.md)

## Commit Conventions

[Conventional Commits](https://www.conventionalcommits.org/), enforced by a husky + commitlint
`commit-msg` hook: `<type>(<optional scope>): <description>`.

| Bumps version                 | Does not bump                                                      |
| ----------------------------- | ------------------------------------------------------------------ |
| `feat` minor · `fix` `perf` patch | `chore` `refactor` `style` `docs` `test` `ci` `build`           |

`BREAKING CHANGE:` in the body or `!` after the type triggers a major bump.

**Closing issues**: put **`Closes #N` in the PR body** — that is the action GitHub honours on merge.
`(#N)` in a commit subject only *references*, and the issue stays open forever. Use `Refs #N` for
partial work. → [quality-gates.md](docs/quality-gates.md), [releasing.md](docs/releasing.md)

## Architecture

```
NicotinD (Hono API :8484)  — native library scanner + streaming, all in-process
└── acquisition addons (own repos + images, registered over the addon protocol)
        AddonJobPoller (HTTP) → LibraryOrganizer → LibraryScanner (tags → SQLite)
```

**Bun monorepo.** Entry point `src/main.ts` loads config, starts services, wires clients into the API.

| Package                     | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `@nicotind/core`            | Shared Zod types, logger, crypto utils, error classes                        |
| `@nicotind/addon-sdk`       | Published npm SDK: addon protocol v1 DTOs, hunt-query helpers, leaf logger    |
| `@nicotind/service-manager` | Sub-service lifecycle strategies (Lidarr only since the addon split)          |
| `@nicotind/api`             | Hono API — routes, JWT auth, search, download watcher, scanner, streaming, DB |
| `@nicotind/web`             | Angular v22 web UI (standalone components, signals, Tailwind)                 |

## Key Design Patterns

The index proper — every mechanism, the symbols you would grep for, and the doc that explains why —
is **[docs/index.md](docs/index.md)**. Read it to locate a mechanism; it is not loaded on every
request, which is the point. Sections: Acquisition & downloads · Library & metadata · Audio analysis
& enrichment · Playback, radio & streaming · Playlists, listening & privacy · Users, auth & access ·
Web UI patterns · Data integrity, caching & migrations · Build, CI, deploy & ops.

## Surfaces

### Web (`@nicotind/web`)

Angular v22 standalone SPA with signals, `HttpClient` + interceptors and lazy routes, built via
`ng build`. Tests run on **plain vitest**, never `ng test`. The HTTP surface is split into per-domain
stateless services under `services/api/` — inject the specific one; there is no monolithic
`ApiService`. **Four type-check surfaces**, none covering the others, all folded into
`bun run typecheck`: `tsc --build`, `typecheck:template` (Angular templates), the e2e specs, and
`typecheck:web-spec`. → [web-ui.md](docs/web-ui.md)

- **i18n**: runtime JSON (`public/i18n/<lang>.json`, `en` the base), `TranslateService` + a `t` pipe
  that is **impure by measurement** (a pure pipe never re-invokes on a language switch), falling
  through active → base → key. Language is per-device. Server error `code` fields map through
  `ERROR_CODE_I18N_KEYS`, but only codes whose message is stable across call sites.
  → [i18n.md](docs/i18n.md)
- **Bundle budget**: `angular.json` carries a budget the project stands behind rather than the
  scaffold default, verified to still fire; CJS bailouts are declared via
  `allowedCommonJsDependencies`. → [web-ui.md](docs/web-ui.md)
- **Storybook component catalog**: shared components storied with theme/TV/viewport globals; stories
  run the **real** services behind an HTTP fixture interceptor. `smoke:storybook` and
  `a11y:storybook:strict` are separate gates from `build:storybook` — compiling a story is not running
  one — and share one traversal. → [storybook.md](docs/storybook.md)

### Mobile (Capacitor Android + iOS)

`packages/mobile` is a thin Capacitor shell around the **same** web build, enabled by a
runtime-configurable API base URL (`ServerConfigService` + `nativeAppCors`). Background audio and
lock-screen controls come from a media-session plugin on Android and an iOS-only Swift plugin.
→ [mobile-app.md](docs/mobile-app.md), [ios-app.md](docs/ios-app.md)

- **Android TV**: the same APK is a leanback launcher app; a `tv` build ships a second APK with a
  10-foot player, roving-tabindex D-pad directives, a `BackHandlerStack`, and
  `@nicotind/capacitor-tv-channels`. The UI is a **route-level fork keyed off `isTvBuild()`, never
  `isTvUi()`** — routes evaluate before the DOM class applies. → [tv-ux.md](docs/tv-ux.md),
  [mobile-app.md](docs/mobile-app.md)

### Desktop (Electron)

`packages/desktop` wraps the **same** backend and web build; Electron supervises the backend as a
local Bun child process via handshake- and health-checked spawn, and the renderer loads
`http://127.0.0.1:<port>` (same-origin, no `file://`). Packaging ships the backend as unbundled source
plus a production install and standalone binaries. Per-platform chrome: native traffic lights on
macOS, an in-app drag region + `DesktopWindowControlsComponent` elsewhere, and hide-to-tray via the
pure `shouldHideOnClose`. → [desktop-app.md](docs/desktop-app.md)

### End-to-end tests

`packages/e2e` boots the real server against a throwaway DB and silent-FLAC fixtures and drives the
SPA in Chromium. Selectors are `data-testid` attributes — **adding one is the standard for new
e2e-targeted elements**. **Before writing a spec, read
[e2e.md](docs/e2e.md) "What the e2e environment does NOT give you"** — the Playwright `request`
fixture is unauthenticated, and no resolve plugin is enabled on a fresh server. The web bundle is
built at config-eval time (`E2E_SKIP_BUILD=1` is the fast path), because serving a stale prebuilt
bundle silently tests the previous code. → [e2e.md](docs/e2e.md),
[testing-routines.md](docs/testing-routines.md)

- **Android TV emulator lane** (`bun run e2e:tv`): a local-only lane driving the real APK on an AVD via
  Playwright's `_android` API. It exists for the one thing Chromium structurally cannot model — a
  WebView has spatial navigation and desktop Chrome does not — plus hardware Back and a WebView-only
  smoke pass. → [e2e-tv-emulator.md](docs/e2e-tv-emulator.md)

### Real-use feedback

[feedback-log-2026-08.md](docs/feedback-log-2026-08.md) is a rolling, dated log of friction noticed
while actually *using* the app, one entry per observation with Severity/Status. Rotate monthly.

### Curation playbook

[curation-playbook.md](docs/curation-playbook.md) is the standardized library curation pass —
measure (`libraryHealth`) → fix (bulk → MCP agent → human) → acquire (budgeted `complete_album`)
→ re-measure — with a dated record per pass in `docs/measurements/curation-pass-YYYY-MM.md`.
Monthly, or after any bulk ingest.

## Configuration

Loaded from `config/default.yml`, overridden by environment variables. See `.env.example` for all
options and [configuration.md](docs/configuration.md) for the reference table. Key vars:
`NICOTIND_MODE`, `NICOTIND_MUSIC_DIR`, `NICOTIND_DATA_DIR`. Source credentials live on their addon
containers, not here.
