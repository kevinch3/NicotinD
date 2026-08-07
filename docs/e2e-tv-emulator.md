# Android TV emulator e2e lane (design — not yet implemented)

**Status:** design approved 2026-08-07; no code written yet. Nothing in this document
describes behaviour that currently exists — it is a plan, in the same sense as
[oauth-auth.md](oauth-auth.md).

**Origin:** verifying issue #432 on a real TV emulator found #436, a focus trap the
114-test Chromium suite ([e2e.md](e2e.md)) structurally cannot detect.

## Why this exists

The Chromium e2e suite fakes a TV by stamping the `tv-build` class on the prod bundle at a
960×540 viewport. That covers layout and any behaviour driven by the app's own JavaScript
keydown handlers — which is most of the TV navigation work.

It cannot cover one thing: **an Android WebView has spatial navigation and desktop Chrome
does not.** On a TV, pressing a direction key with no nav group claiming it moves focus to
the nearest focusable element in that direction. Chrome desktop has no such behaviour at
any level, so a desktop test can't distinguish "focus correctly moved" from "focus never
could have moved".

That distinction is where #436 lives. `TvNavGroupDirective` calls `preventDefault()`
unconditionally at a group edge (deliberately — so an edge press can't leak into the global
ArrowLeft/Right seek shortcut). On desktop that's invisible: focus wasn't going anywhere
regardless. On a TV it suppresses the spatial-navigation escape, trapping focus inside any
song list. Verified on device: from the last track row, `DPAD_DOWN` ×8 never leaves
`rowIndex=6 of 7`, and `RIGHT`×3 → `DOWN`×2 is likewise trapped on the row's `⋯` toggle.

### Measured facts this design rests on

Gathered on the `nicotind-tv` AVD (API 36 google-tv, x86_64) on 2026-08-07:

- `chromium.connectOverCDP()` **fails** against an Android WebView — no browser-level
  target is exposed, only page targets. Playwright's `_android` API works and yields a real
  `Page`: `getByTestId` locators, auto-waiting, and `evaluate` all function normally.
- Synthetic key events (`page.keyboard.press`) and hardware key events
  (`adb shell input keyevent`) behave **identically** in the WebView, including for spatial
  navigation. Hardware keys are used for fidelity to what a remote does, not because
  synthetic ones are wrong. Do not "optimize" this away in either direction without
  re-measuring.
- The fix under test works: with the notch focused, a hardware `DPAD_CENTER` moves the Now
  Playing sheet from `top: 588` (below a 540 px viewport) to `top: 48`.

## Scope

**Purpose:** a local, on-demand pre-release gate — `bun run e2e:tv`, run before cutting a TV
APK. Not a CI gate. The runner pool is already saturated (observed runs queuing 1–2 h), and
emulator boots are a classic CI flake source; neither cost is worth paying on every PR for a
lane whose findings are this narrow and this deterministic.

**Coverage:** TV-specific surfaces and focus/navigation, plus a smoke pass of core journeys
on real Android. Not a port of all 114 Chromium tests — most of those exercise Angular logic
that behaves identically in both engines, so re-running them would trade real time for
approximately no new signal.

## Architecture

```
packages/e2e/
  playwright.config.ts        # unchanged — 114 Chromium tests
  playwright.tv.config.ts     # NEW — emulator lane
  helpers.ts                  # shared, unchanged
  tv/
    preflight.ts              # emulator + APK + server lifecycle
    fixtures.ts               # androidPage fixture, seedAuth, dpad helpers
  tests-tv/
    navigation-escape.tv.spec.ts
    dpad-reachability.tv.spec.ts
    tv-chrome.tv.spec.ts
    smoke.tv.spec.ts
```

A second config file in the same package, rather than a new project in the existing config
or a separate `packages/e2e-tv`:

- A new _project_ inside `playwright.config.ts` would put the emulator in the blast radius
  of every `bun run e2e`, which must stay fast and CI-safe.
- A separate _package_ would duplicate `helpers.ts`, the fixture music library, the
  server-boot recipe, and auth seeding — or need cross-package imports for them. The two
  suites share far more than they differ.

### The `androidPage` fixture

```ts
export const test = base.extend<{ device: AndroidDevice; page: Page }>({
  device: async ({}, use) => {
    const device = (await _android.devices())[0];
    if (!device) throw new Error('no adb device — run `bun run e2e:tv`, not playwright directly');
    await use(device);
    await device.close();
  },
  page: async ({ device }, use) => {
    const wv = device.webViews().find((w) => w.pkg() === APP_ID);
    if (!wv) throw new Error('app has no WebView — see the logcat tail above');
    await use(await wv.page());
  },
});
```

Two things the Chromium lane gets for free and this lane must handle:

**Auth.** `storageState` cannot work — a different browser on a different device. `seedAuth`
mints a JWT against the fixture server over HTTP, writes `nicotind_server_url`,
`nicotind_token`, `nicotind_username` and `nicotind_role` into `localStorage`, then reloads.

**Origin.** The WebView serves the app from `https://localhost`; the API is reached over
`adb reverse` at `http://localhost:<port>`. So `baseURL` is `https://localhost` and the
server URL is injected as app config, never as the page origin. Inverting these is the most
likely setup mistake, so it lives in the fixture rather than in specs.

**D-pad helpers.** `dpad(device, 'DOWN', n)` wrapping `device.shell('input keyevent
KEYCODE_DPAD_DOWN')`, and `focusPath(page)` returning the active element's testid plus its
index within any enclosing list — the probe otherwise hand-rewritten in every spec.

`playwright.tv.config.ts` declares **no browser project and no `use.browserName`**: the
`page` fixture is overridden to return the WebView page, so Playwright must not also try to
launch a local browser. Specs in `tests-tv/` import `test` from `tv/fixtures.ts`, never from
`@playwright/test` directly.

## Preflight lifecycle

`bun run e2e:tv` → `tv/preflight.ts` → `playwright test -c playwright.tv.config.ts`.

**No build caching, no skips.** Measured costs:

| Step                                              | Measured |
| ------------------------------------------------- | -------- |
| Cold emulator boot → `sys.boot_completed=1`       | 26 s     |
| Web build `--configuration tv`                    | 8.0 s    |
| `cap sync`                                        | 0.05 s   |
| `gradlew assembleDebug` (warm daemon, no changes) | 9.8 s    |
| `adb install -r` (31 MB)                          | 0.7 s    |
| Fixture server boot → `/api/health`               | ~15 s    |
| Launch + WebView target ready                     | ~8 s     |

Warm total ≈ 42 s; fully cold ≈ 68 s. Caching the build steps would save roughly 18 s and
reintroduce the failure mode of issue #253, where the suite silently served the previous web
bundle and reported pre-fix behaviour as the actual value. On these numbers that trade is
clearly wrong, so every run builds and installs from scratch.

The one conditional is the emulator itself: boot it only if no device reporting the
`nicotind-tv` AVD has `sys.boot_completed=1`. That reuses a _running process_, not a _build
artifact_ — a different risk class, and worth not paying 26 s per run.

### Fixed decisions

- **Port 8587, own data dir.** 8585 is the Chromium lane, 8586 is onboarding. A separate
  port lets both suites run concurrently and prevents a TV run poisoning the Chromium DB.
- **Fixture music copied to a temp dir.** A server's enrichment writes tags into the FLACs
  it scans; pointing the TV server at the checked-in `packages/e2e/fixtures/music` dirties
  the working tree. Observed during the #432 investigation and manually reverted. The
  harness must never require a `git checkout` afterwards. `changelog.json`, which the web
  build regenerates, is likewise restored if it was clean beforehand.
- **Use the SDK `adb`, never `/usr/bin/adb`.** A distro adb (v20) fights the SDK adb server
  and surfaces as "device not found".
- **Actionable failures.** No AVD → print the `avdmanager create` line. No `adb` → the
  `ANDROID_HOME` hint. Booted but no WebView target → tail 40 lines of logcat, since a crash
  on launch otherwise reads as a mysterious fixture timeout.

## Specs

### `navigation-escape.tv.spec.ts`

For each of album detail, library Songs, artist detail, playlist detail, radio landing and
Acquire: focus starts in the content region and must reach the player chrome by D-pad. This
is #436's regression test generalized — the bug is one instance of a pattern that recurs on
any surface with a nav group at the bottom of its content.

### `dpad-reachability.tv.spec.ts`

Per route: walk the D-pad, collect the reachable set, diff it against every element in the
viewport carrying `appTvNavItem` or `tabindex="0"`. Unreachable elements fail with their
testid. This is what finds the next #436 without anyone predicting it.

"Walk" needs a precise termination rule, since a naive loop either misses branches or never
ends. The walk is a breadth-first search over focus states: from each newly reached element,
try all four directions, recording the resulting element; stop when a full sweep of the
frontier yields no element not already seen. Focus identity is the element's testid plus its
index among same-testid siblings (repeated testids across list rows are the norm here — the
`track-row-title` walk during the #436 investigation looked stationary for exactly this
reason). A hard cap on total presses guards against a cycle the identity rule fails to
collapse; hitting the cap is a test failure, not a silent truncation.

### `tv-chrome.tv.spec.ts`

Android-only surfaces: hardware **Back** through `BackHandlerStack` (#394) — impossible in
Chromium, which has no Back key — plus the 10-foot Now Playing layout, the queue overlay
(#399) and the Next-up chip. Subsumes the intent of `now-playing-tv.spec.ts`, which
approximates a TV; this runs the real TV bundle on a real TV device.

### `smoke.tv.spec.ts`

Login → library → play → Now Playing → Settings. The target is not UI logic (Chromium covers
it) but WebView-only failure modes: CORS through `nativeAppCors`, the service worker not
intercepting `/api/stream` (`ngsw-bypass`), and media-session wiring.

## Out of scope, with reasons

- **TV launcher channels (#395).** `adb root` does not work on the google-tv production
  image, so another app's TV-provider rows are unreadable from the shell. Not testable
  without adding instrumentation; stays a manual verification.
- **Onboarding wizard.** Needs a second never-seeded server. Pure Angular logic with no
  WebView-specific risk, already covered in Chromium.
- **Acquisition, playgrounds, screenshot flows.** Default-off or already out of CI by
  design.

## Open risk to resolve during implementation

The emulator runs with `-no-audio`. Whether `<audio>` `currentTime` advances without an
output device is unverified. If it stalls, `smoke.tv.spec.ts`'s "playback progresses"
assertion is unwritable as stated, and the choice is between dropping `-no-audio` (costing
boot time and possibly stability) or weakening the assertion to "the stream request returns
206". Verify this first, before building around either assumption.

## Success criteria

- `bun run e2e:tv` completes from a cold machine in under ~2 minutes.
- It never leaves the working tree dirty.
- A failure names the element or surface at fault, not a stack trace.

### The suite is expected to be RED on arrival

#436 is open, so `navigation-escape.tv.spec.ts` will fail the moment it exists — that is the
point, and it is the proof the lane works. But a permanently-red suite is one nobody runs,
and this is a local gate with no CI to enforce a green baseline.

So the escape assertions for surfaces blocked by #436 ship as `test.fail()` — Playwright's
expected-failure marker, which passes while the bug is present and _fails loudly if the bug
is fixed without updating the test_. That keeps the suite green-by-default, keeps the
finding recorded as executable rather than prose, and makes fixing #436 turn the annotation
into a normal passing test. Any surface not blocked by #436 asserts normally from day one.
