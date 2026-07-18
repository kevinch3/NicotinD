# Desktop app (Electron)

NicotinD ships a native **desktop app** (Ubuntu + macOS) that wraps the existing Angular web UI
in an [Electron](https://www.electronjs.org/) shell **and runs the NicotinD backend itself** as a
bundled local sidecar. Unlike the mobile app (which connects to a remote self-hosted server), the
desktop app is **fully self-contained**: the user points it at a local music folder and it scans,
serves, and streams that library locally — no server to run, no URL to configure.

## Why Electron + a Bun sidecar (the load-bearing decision)

The backend is **hard-bound to the Bun runtime** in three ways that Electron's Node runtime cannot
execute directly: `Bun.serve()` is the only HTTP listener (`src/main.ts`), `bun:sqlite` is the only
DB driver (`packages/api/src/db.ts`), and `hono/bun` provides `serveStatic` + `createBunWebSocket`
(`packages/api/src/index.ts`). So the desktop app does **not** re-implement the backend in Node.
Instead, Electron's main process spawns the **existing, unchanged** Bun backend as a child process
(the "sidecar"), and the renderer loads the loopback URL the backend already serves. This reuses the
one Angular app and the one backend — no second codebase, no dual runtime.

**Why the renderer loads `http://127.0.0.1:<port>/` and not `file://`:** the web build assumes
`<base href="/">` + absolute ngsw asset paths, which `file://` breaks. Loading the backend's own
served origin makes the renderer same-origin with the API — no CORS, no base-path rework — and keeps
dev and prod on an identical HTTP code path (which is why prod needs an ATS loopback exception on
macOS, below).

### Backend packaging: Variant B (spike-decided)

A spike (`packages/desktop/spike/README.md`) evaluated `bun build --compile` (single self-contained
binary) and **rejected it**: the shared core logger's static `require.resolve('pino-pretty')` breaks
a compiled binary at link time (bun eagerly links the target even under a runtime guard), and
`import.meta.dir` resolves to `/$bunfs/root` so the web dist can't be found. The compiled binary
(~99 MB) offered no meaningful size win over shipping the `bun` binary (~90 MB) that also runs the
backend unchanged. So the app ships **Variant B**:

- the backend as **unbundled TypeScript source** (`src/main.ts` + the workspace packages it imports —
  `core`, `slskd-client`, `service-manager`, `lidarr-client`, `api`) run via `bun run <entry>`, so
  `require.resolve` keeps working exactly like dev/CI;
- a standalone **`bun` binary** (the packaging machine's own — CI runs one job per target OS) so end
  users don't need Bun installed;
- a static **`ffmpeg`** from the [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) npm
  package (a devDependency of `@nicotind/desktop`).

## Packages & project layout

`packages/desktop` is a thin Electron workspace (`@nicotind/desktop`, ESM, `"type": "module"`). It
does **not** re-declare the UI — it consumes `packages/web/dist` and the staged backend.

- `electron/main.ts` — app entry: single-instance lock (focus existing window on second launch),
  lifecycle, spawns + supervises the sidecar, creates + hardens the window, wires auto-update and the
  "Reveal logs" menu.
- `electron/window.ts` — `createMainWindow(url)` with `contextIsolation: true`, `nodeIntegration:
  false`, `sandbox: true`, `preload: dist/preload.cjs`.
- `electron/security.ts` — `hardenWindow(win)`: `setWindowOpenHandler` (deny in-app opens, route
  http(s) to `shell.openExternal`), `will-navigate` pinned to the loopback origin, and a `session`
  CSP locking `connect-src`/`media-src` to self + loopback (keeps `'unsafe-inline'` for esbuild's
  inline styles/scripts).
- `electron/preload.cts` — **CommonJS** (`.cts` → `preload.cjs`), self-contained: Electron sandboxed
  preloads can only `require('electron')`, so the IPC channel strings are **inlined** (not imported).
  Exposes `window.nicotind = { platform: 'electron', pickDirectory(), setMusicDir() }`.
- `electron/ipc-channels.ts` — `CH` channel-name constants (imported by `main.ts` only).
- `electron/sidecar.ts` — the supervisor (below); `electron/paths.ts` — dev-vs-prod path resolution.
- `electron/desktop-config.ts` — persists the chosen music dir to `<userData>/desktop-config.json`.
- `electron/updater.ts` + `electron/update-mode.ts` — auto-update (below).
- `scripts/prepare-resources.ts`, `electron-builder.yml`, `build/entitlements.mac.plist` — packaging.

The `.cts`/CommonJS preload coexisting with ESM `main.ts` works because the desktop TypeScript config
uses `module`/`moduleResolution: nodenext` (`.cts` → `.cjs` CommonJS; `.ts` → ESM `.js`).
`packages/desktop/tsconfig.json` is a solution file referencing `tsconfig.electron.json`
(`electron/` → `dist/`, which `package.json`'s `main` and electron-builder's `files` depend on) and
`tsconfig.scripts.json` (`scripts/` → `dist-scripts/`, typecheck-only, gitignored).

> **@types/node pin:** `electron` depends on `@types/node@^20`, which collides with the repo's bun
> type environment and breaks `ChildProcess` typing across `api`/`service-manager`. The root
> `package.json` pins `overrides: { "@types/node": "25.5.0" }` to keep the workspace typecheck green.

## Sidecar supervisor

`Sidecar` (`electron/sidecar.ts`) spawns `bun run <backend-entry>` with a controlled env:
`NICOTIND_PORT=0` (ephemeral), `NICOTIND_BIND_HOST=127.0.0.1` (loopback only),
`NICOTIND_MODE=external` (so the backend does **not** download/spawn slskd+Lidarr — v1 is
local-library only), `NICOTIND_DATA_DIR=<userData>`, `NICOTIND_WEB_DIST=<resources/web>`, and (prod)
`NICOTIND_FFMPEG_PATH=<resources/bin/ffmpeg>`, plus `NICOTIND_MUSIC_DIR` from the persisted config.

> **Remote access / phone pairing needs no desktop changes.** The loopback bind stays
> exactly as above even when the user enables remote access: Tailscale **Funnel** proxies
> public HTTPS → `127.0.0.1:<port>` server-side (the backend arms it after every boot with
> its current ephemeral port), the Devices page lives in the shared web UI, and the
> external Tailscale login/approve links open in the OS browser through the existing
> `setWindowOpenHandler` → `shell.openExternal` path. See
> [device-pairing.md](./device-pairing.md).

- **Startup handshake:** the backend prints exactly one line `NICOTIND_LISTENING <port>` after it
  binds (`src/main.ts`). The supervisor reads stdout **line-buffered** (`readline`, so the log tee
  can't split/eat the handshake) and resolves `start()` with `http://127.0.0.1:<port>` only after
  the handshake **and** `GET /api/health` succeed; it rejects on early exit or timeout.
- **Supervision:** crash-restart with capped exponential backoff, gated by `shouldRestart(everHealthy,
  stopping)` — a restart only fires if the sidecar had **previously become healthy** (so a
  never-healthy boot rejects `start()` and does not loop) and we are not intentionally stopping.
  `start()` is re-entrancy-guarded against the macOS `activate` double-spawn.
- **Logs:** stdout/stderr tee to a size-rotated file under `<userData>/logs` (5 MiB, 2 generations),
  surfaced via a "Reveal logs" menu item.
- **stop():** sets a `stopping` flag (so no restart fires), `SIGTERM` (graceful backend shutdown),
  then `SIGKILL` after a grace period.

## Choosing / changing the music folder

The backend takes `musicDir` at boot and — critically — `setup.ts` mutates it **in-memory only**
(never persisted). So the **desktop app owns the music-dir preference**:

- **Onboarding:** the existing Angular setup wizard's music-dir step shows a native "Choose folder…"
  button on Electron (`data-testid="onboarding-pick-folder"`) → `window.nicotind.pickDirectory()` →
  `dialog.showOpenDialog({ properties: ['openDirectory'] })`. The pick is persisted desktop-side
  (`setMusicDir(path, { restart: false })` — no disruptive mid-onboarding reload). Then, on the
  wizard's final **"Get Started"** action, `enterApp()` calls
  `setMusicDir(dir, { restart: true })` to **restart the sidecar before entering the app**. This is
  load-bearing, not polish: the backend booted *before* onboarding with the default `~/Music`, and
  `createApp()` captures `config.musicDir` **by value** into the `LibraryOrganizer`, scanner, and
  library routes — `POST /api/setup/complete` only mutates the config object in memory, so without
  the restart the entire first session would organize acquisitions into and scan `~/Music` instead
  of the selected folder. A failed restart still enters the app (Settings → "Change music folder"
  is the retry path). Refactoring those boot-time captures to use-time reads is deliberately out of
  scope — the restart is the contract.
- **Settings → "Change music folder"** (`data-testid="settings-change-folder"`, Electron-gated):
  re-picks, then `setMusicDir(path, { restart: true })` persists + **restarts the sidecar** so the
  backend re-boots scanning the new dir; the window reloads at the new URL. A failed restart surfaces
  an error (`{ ok, error? }` threaded through the IPC → bridge → UI) and recovers the sidecar state
  rather than wedging.
- On every launch, `Sidecar.start()` falls back to `readDesktopConfig().musicDir`, so the choice
  survives restarts.

This reuses one shared **native-capabilities interface** (`services/native/native-capabilities.ts`)
that both Electron (`window.nicotind`) and Capacitor implement, and `isElectron()`/`isNativeShell()`
in `lib/platform.ts` (Electron detected via the injected `window.nicotind`, no electron import). The
service worker is disabled inside the Electron shell (`serviceWorkerEnabled(isDevMode(),
isNativeShell())`) to avoid cross-update cache surprises.

## Packaging (electron-builder)

`bun run --filter @nicotind/desktop dist` = `build` (tsc) → `prepare-resources` → `electron-builder`.
`prepare-resources.ts` stages, at the paths `paths.ts` expects under `process.resourcesPath` (this
table is a hard contract — they must always agree):

| `paths.ts` (prod)                                        | staged into              |
| -------------------------------------------------------- | ------------------------ |
| `bunBinary()` → `<resourcesPath>/bin/bun`                | `resources/bin/bun`      |
| `ffmpegBinaryPath()` → `<resourcesPath>/bin/ffmpeg`      | `resources/bin/ffmpeg`   |
| `backendEntry()` → `<resourcesPath>/backend/src/main.ts` | `resources/backend/...`  |
| `webDistPath()` → `<resourcesPath>/web`                  | `resources/web`          |

The staged backend gets a **synthesized** `package.json` (not a copy of the repo root's — that one
carries dev-only tooling like husky's `prepare` script, which would fail outside a git checkout)
listing the root's external runtime deps plus `workspace:*` entries; `bun install --production` inside
`resources/backend` resolves those into a self-contained `node_modules`. It carries the **real**
release version (staged from the root `package.json`), so `GET /api/system` reports the correct
version, not `0.0.0`. This was verified end-to-end locally (stage → `bun install --production` → spawn
`bun run` against the staged tree → `NICOTIND_LISTENING` handshake) before shipping.

`electron-builder.yml`: `appId: ar.kevinroberts.nicotind.desktop`; `asarUnpack` + `extraResources`
keep the backend/bun/ffmpeg as real executables outside the asar; **linux** → AppImage + deb
(category Audio); **macOS** → dmg (x64 + arm64). The icon reuses the PWA brand mark
(`packages/web/public/icons/icon-512.png` → `build/icon.png`; a dedicated desktop icon is a
follow-up). `publish: github (kevinch3/NicotinD)`.

> **The deb target needs an explicit `artifactName`.** electron-builder's default deb
> filename is `${name}_${version}_${arch}.${ext}`, and our package `name` is the *scoped*
> `@nicotind/desktop` — fpm reads the `/` as a path separator and dies with
> *"Parent directory does not exist: release/@nicotind"*, failing the whole `desktop-linux`
> job (silently, since it's `continue-on-error`). Fixed by `deb.artifactName:
> ${productName}_${version}_${arch}.${ext}` (→ `NicotinD_<v>_amd64.deb`). AppImage was
> unaffected because its default already uses `${productName}`. Verified end-to-end on a
> real Linux desktop: `bunx electron-builder --linux` produces both AppImage + deb, and the
> **packaged** AppImage boots the full Variant-B sidecar chain (bundled `bun` runs the
> staged backend, binds a loopback port, `/api/health` answers, the SPA renders).

### macOS is ad-hoc signed (v1 — no Developer ID)

The dmg carries an **ad-hoc signature**: no `identity` key in `electron-builder.yml` plus
`CSC_IDENTITY_AUTO_DISCOVERY: false` in CI makes electron-builder fall back to ad-hoc signing.
**Never set `identity: null`** — that disables even the ad-hoc pass, and Apple Silicon refuses to
execute unsigned arm64 code entirely: the first v0.1.210-era arm64 dmg reported *"NicotinD is
damaged and can't be opened"* on every M-series Mac for exactly this reason. Ad-hoc signed, the
app launches with the normal un-notarized friction: **macOS 14 and earlier**: right-click → Open
once; **macOS 15 (Sequoia)**: System Settings → Privacy & Security → "Open Anyway" (or clear
quarantine: `xattr -dr com.apple.quarantine /Applications/NicotinD.app`). On-device check for the
next release tag: the arm64 app launches AND the bundled `resources/bin/bun` / `ffmpeg` execute —
if extraResources aren't covered by the ad-hoc pass, add an `afterSign` hook that
`codesign -s -` signs them. App Sandbox is **off**
(`build/entitlements.mac.plist`), so reading an arbitrary user-picked music volume needs no
security-scoped bookmarks. `mac.extendInfo.NSAppTransportSecurity` carries a **loopback-only** ATS
exception (not a blanket `NSAllowsArbitraryLoads`). Signing + notarization are a later release.

## Auto-update

`electron-updater` reads the same GitHub Releases feed the packaging publishes. `updateMode(platform,
signed)` gates behavior (pure, unit-tested in the electron-free `update-mode.ts`):

- **Linux (AppImage):** full download + apply (`quitAndInstall` on user confirm).
- **macOS (ad-hoc signed, no Developer ID):** **notify-only** — Squirrel.Mac can only apply
  updates to a Developer-ID-signed app (ad-hoc doesn't qualify), so the app shows a "new version
  available" prompt that opens the Releases page; it never calls `quitAndInstall`. (Flips to apply
  once real mac signing lands — `updateMode('darwin', true) → 'apply'`.)

Auto-update is a no-op in dev (`!app.isPackaged`) and wrapped so a failed/offline check never crashes
the app. This is why the packaging jobs use electron-builder's **`--publish always`**: only its own
publish uploads the `latest-*.yml` metadata the updater polls.

## Build & CI

Best-effort, tag-triggered jobs in `.github/workflows/deploy.yml` (mirroring the Android/iOS jobs,
`if: github.ref_type == 'tag'` + `continue-on-error: true`, so a packaging failure never blocks the
server deploy):

- `desktop-linux` (ubuntu) → `electron-builder --linux --publish always` (AppImage/deb + `latest-linux.yml`).
- `desktop-mac` (macos-14) → `electron-builder --mac --publish always` (dmg + `latest-mac.yml`).

Desktop **unit tests** (`bun:test`: `parseListeningPort`, `shouldRestart`, `updateMode`,
`mergeDesktopConfig`, dialog-result, prepare-resources helpers) run in CI via `ci.yml`'s test step
(`packages/desktop/electron packages/desktop/scripts`). A best-effort `desktop-smoke` job launches the
real app under `xvfb` via Playwright's `_electron` and asserts the SPA renders (`test/smoke.spec.ts`)
— it needs a real Electron binary + display, so it's `continue-on-error`. The Playwright `test/` dir
uses Playwright's runner (not bun's), so it's excluded from every `bun test` glob.

## Out of scope for v1 (later releases)

Soulseek (slskd) + Lidarr acquisition, URL acquisition (yt-dlp/spotdl/deno/bgutil), the Essentia ML
analysis sidecar, macOS signing/notarization (+ full macOS auto-update), Windows, and a dedicated
desktop app icon (currently reuses the PWA brand mark).
