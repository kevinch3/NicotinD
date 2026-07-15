# Desktop app (Electron)

`packages/desktop` wraps the same backend (`src/main.ts` + its workspace
packages) and the same `@nicotind/web` Angular build used everywhere else,
inside an Electron shell that supervises the backend as a local child
process ("sidecar") instead of requiring a separately-hosted server.

## Runtime shape

- `electron/main.ts` creates the app window and owns the `Sidecar` lifecycle.
- `electron/sidecar.ts` spawns `bun run <backendEntry>`, tees stdout/stderr to
  a rotating log file, waits for the `NICOTIND_LISTENING <port>` stdout
  handshake + a passing `GET /api/health`, and supervises unexpected exits
  with capped exponential backoff.
- `electron/paths.ts` is the single source of truth for where the sidecar's
  binaries/source live in **dev** (straight out of the monorepo checkout,
  `bun`/`ffmpeg` resolved from `PATH`) vs **prod** (a packaged app, resolved
  under Electron's `process.resourcesPath`).
- The renderer loads `http://127.0.0.1:<port>` (the sidecar's bound port) —
  never a bundled build of the SPA loaded via `file://`. This keeps dev and
  prod on an identical code path (same HTTP API, same relative asset URLs)
  and is why prod needs an ATS loopback exception on macOS (see below).

## Packaging (electron-builder) — Variant B

A build-time spike (`packages/desktop/spike/README.md`) tried `bun build
--compile` to ship the backend as a single native binary and rejected it:
static bundling breaks `pino-pretty`'s `require.resolve('pino-pretty')` (the
core logger's pretty-printer, a `@nicotind/core` dependency), which only
resolves against a real `node_modules` tree on disk.

**Variant B** ships instead:

- the backend as **unbundled TypeScript source** (`src/main.ts` + the
  workspace packages it imports — `core`, `slskd-client`, `service-manager`,
  `lidarr-client`, `api`) plus a **production `bun install`** of their real
  `node_modules`, run via `bun run <entry>` — no compile step, so
  `require.resolve` keeps working exactly like it does in dev/CI;
- a standalone **`bun` binary** (the packager's own `process.execPath` — the
  platform/arch the packaging machine is *on* is the platform/arch being
  packaged; CI runs one job per target OS, see Task 14) so end users don't
  need Bun installed;
- a static **`ffmpeg`** binary sourced from the `ffmpeg-static` npm package
  (a devDependency of `@nicotind/desktop`), used for transcoding/streaming
  the same way the Docker image's bundled ffmpeg is.

`packages/desktop/scripts/prepare-resources.ts` assembles all of this into
`packages/desktop/resources/` before `electron-builder` runs (wired as the
`dist` script: `build` → `prepare-resources` → `electron-builder`). Its
output layout is a direct contract with `electron/paths.ts`'s prod
resolution — they must always agree:

| `paths.ts` (prod)                              | staged by `prepare-resources.ts`     |
| ----------------------------------------------- | ------------------------------------- |
| `bunBinary()` → `<resourcesPath>/bin/bun`       | `resources/bin/bun`                   |
| `ffmpegBinaryPath()` → `<resourcesPath>/bin/ffmpeg` | `resources/bin/ffmpeg`            |
| `backendEntry()` → `<resourcesPath>/backend/src/main.ts` | `resources/backend/src/main.ts` |
| `webDistPath()` → `<resourcesPath>/web`         | `resources/web`                       |

`electron-builder.yml`'s `extraResources` stages `resources/**` verbatim into
the packaged app's `process.resourcesPath`, so the table above holds
unchanged in the final package. The staged backend gets its **own**
synthesized `package.json` (not a copy of the repo root's — that one carries
dev-only tooling like husky's `prepare` script, which would fail outside a
git checkout) listing the root's external runtime deps plus `workspace:*`
entries for the five packages above; `bun install --production` inside
`resources/backend` then resolves those into a self-contained
`node_modules` (workspace packages become symlinks under
`resources/backend/node_modules/@nicotind/*`), so `bun run
resources/backend/src/main.ts` works with nothing else from the monorepo
present. This was verified end-to-end locally (build web → stage backend →
`bun install --production` → spawn `bun run` against the staged tree →
`NICOTIND_LISTENING` handshake + boot logs observed) before this doc was
written.

Targets: Linux `AppImage` + `deb` (category Audio, `.desktop` entry at
`build/linux/nicotind.desktop`); macOS `dmg` for `x64`+`arm64`. **Unsigned**
(`identity: null`, `hardenedRuntime: false`) — no Apple Developer ID is in
scope for v1; `build/entitlements.mac.plist` is kept minimal (sandbox off,
network client/server) so it's ready to tighten if/when signing lands later.
`mac.extendInfo.NSAppTransportSecurity` carries a **loopback-only** ATS
exception (`localhost`/`127.0.0.1`, not a blanket
`NSAllowsArbitraryLoads`) since the renderer only ever talks to the sidecar
on `127.0.0.1`. `publish` targets the same GitHub repo
(`kevinch3/NicotinD`) the electron-updater (Task 12) reads releases from.

The icon is reused from the existing PWA icon set
(`packages/web/public/icons/icon-512.png` → `packages/desktop/build/icon.png`,
512×512 — electron-builder derives every platform's icon set from this one
source file). No dedicated desktop-app icon asset exists yet; using the PWA
icon is a deliberate reuse, not a placeholder, but a distinct desktop icon
is a reasonable follow-up if the two apps ever want to look different.

### TypeScript project layout

`packages/desktop/tsconfig.json` is a solution file (`files: []`) that
references two sibling project configs so `tsc --build` (both the repo-root
`bun run typecheck` and a standalone `tsc -p packages/desktop/tsconfig.json`)
type-checks both halves of the package without mixing their output
directories:

- `tsconfig.electron.json` — the Electron main/preload/renderer-bridge code
  under `electron/`, emitting to `dist/` (unchanged from before this split;
  `package.json`'s `main: dist/main.js` and `electron-builder.yml`'s `files:
  dist/**` both depend on this exact layout).
- `tsconfig.scripts.json` — packaging scripts (`scripts/prepare-resources.ts`)
  under `scripts/`, emitting (for typecheck purposes only — the script itself
  always runs as `.ts` directly via `bun run`) to `dist-scripts/`, gitignored.

### What Task 11 could and couldn't verify

Packaging was implemented and (unusually) fully exercised in the sandbox
that authored it — `prepare-resources.ts` ran end-to-end (web build → backend
stage → `bun install --production` → bun/ffmpeg staged) and the staged
backend was booted standalone and confirmed to reach `NICOTIND_LISTENING`.
What still needs on-device/CI verification (Task 11's Step 4 / Task 14):
running the actual `electron-builder` packaging step to produce a real
AppImage/deb/dmg, and launching that packaged artifact (onboarding, a 206
stream, radio) — `electron-builder`'s own binary downloads and
platform-specific codesigning/packaging tooling are out of scope for a
sandbox and are exercised on the user's machine / CI.
