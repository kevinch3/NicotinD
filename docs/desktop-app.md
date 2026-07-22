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

## Per-platform window chrome + tray

The renderer is the same Angular build on every shell; only the chrome
around it changes. Behavior lives in two cooperating modules:
`electron/window-options.ts` (the per-platform `BrowserWindow` shape,
extracted from `createMainWindow` for unit testing) and
`electron/tray.ts` (the OS tray icon + menu), plus the matching renderer
chrome bar in `packages/web/src/app/components/layout/`.

| Platform | `frame` | `titleBarStyle` | Result |
|----------|---------|-----------------|--------|
| `darwin` | (default) | `'hiddenInset'` | Native traffic lights stay at top-left (`trafficLightPosition: { x: 14, y: 14 }` so they clear the brand mark). Title bar text gone, height shrinks to 28 px so the Angular `<header>` paints right under them — looks like Spotify / Apple Music. |
| `linux` | `false` | `'hidden'` | Fully chromeless. The renderer draws the entire title bar. The existing `<header>` gets `[-webkit-app-region: drag]` and adds three SVG icon buttons (minimize / maximize-toggle / close) on the right; each child element that needs to be clickable also gets `[-webkit-app-region: no-drag]`. Double-click on the header toggles maximize (GTK convention). |
| future `win32` | `false` | `'hidden'` | Symmetric to Linux. No Windows target in `electron-builder.yml` yet, but the code path falls through to the same shape. |

### Why Linux gets an in-app chrome bar (macOS doesn't)

GNOME / KDE don't synthesize native close/min/max buttons for
`frame: false, titleBarStyle: 'hidden'` — the window would otherwise be
chromeless **without any controls**. The alternatives considered:

- `titleBarStyle: 'default'` everywhere — only partially fixed the File-menu complaint, still leaves the default icon and traditional title bar, not what a media player wants.
- Per-platform native chrome via `Menu.setApplicationMenu(null)` only — leaves the Linux window unable to close.
- The renderer's three-button bar (chosen) — same DOM as macOS's hidden-inset, just painted explicitly. Buttons are themed through `bg-theme-*` tokens so they follow light/dark.

The renderer-side bar is gated by `isElectronLinux()` (`lib/platform.ts`),
driven by the synchronous `process.platform` snapshot the preload exposes
on `window.nicotind.os`. macOS keeps its native traffic lights (no
visual duplication). The buttons themselves are one shared, self-gating
`DesktopWindowControlsComponent`, embedded in two hosts:

- the app-shell header (`components/layout/`), which doubles as the drag
  region for every authed route; and
- `DesktopTitleBarOverlayComponent` (mounted once in the app root) — a
  transparent fixed strip that covers the routes rendered **outside** the
  shell (`/setup`, `/login`, `/server`, `/share/:token`). Without it the
  first-run window (which lands on `/setup`) would have no drag region
  and no way to minimize/close at all. `DesktopChromeService.
  shellHeaderActive` (set by `LayoutComponent` on init/destroy) keeps the
  overlay and the shell header mutually exclusive, so the two never
  double-render.

### Hide-to-tray on close (Linux only) + tray menu

`main.ts` installs a `close` listener on `BrowserWindow` that calls
`shouldHideOnClose(platform, isQuitting)` from
`electron/should-hide-on-close.ts` (pure helper, unit-tested). It hides
on Linux/Windows when no quit is in progress; macOS is never intercepted
(Apple's "click-to-dock" convention preserves the running app when the
last window closes — the tray would be a second dismissal path that
confuses users). The `quitting` flag is module-level in `main.ts`,
shared with the tray "Quit" item and `app.before-quit`, so all three
paths agree on whether the next close is real or just a hide.

The tray itself (`electron/tray.ts`) installs at end of `createWindow()`
and exposes three items:

- **Open NicotinD** — show/restore/focus the existing window, or recreate it if a previous quit-on-Linux cleared all windows.
- **Reveal Logs** — calls `shell.showItemInFolder(sidecar.logFilePath())`. Mirrors the new Settings → "Reveal logs…" button (Electron-gated) so the entry is reachable both from the tray and from the in-app Settings page.
- **Quit NicotinD** — sets the shared `quitting` flag and calls `app.quit()`, which routes through `before-quit` → `sidecar.stop().finally(app.quit())`.

This shares one source of truth for the quit flow with the global
`app.before-quit` handler, so double-clicking "Quit" or invoking it via
the tray + then by `before-quit` in any combination can't loop or
wedge.

### Drag region contract

The `[-webkit-app-region: drag]` class on the header makes the **whole**
header a drag handle. To keep clicks reachable, every interactive child
(brand link, nav, version anchor, signout button, the new window
control buttons) explicitly opts back into `no-drag`. The pattern is
documented here so a future add to the header keeps the contract: if
it's interactive, tag it with `[-webkit-app-region: no-drag]`. The
smoke test (`packages/desktop/test/smoke.spec.ts`) asserts the Linux
shape rendered and the `data-electron-title-bar` attribute on the
header so a regression fails CI immediately rather than silently
shipping an undraggable / unloseable window. (It lands on `/setup`
against a fresh data dir, so the element it actually exercises is the
pre-auth overlay title bar, which carries the same testids/attribute.)

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

`bun run --filter @nicotind/desktop dist` = `build` (tsc) → `stage-icons` → `prepare-resources` → `electron-builder`.
`prepare-resources.ts` stages, at the paths `paths.ts` expects under `process.resourcesPath` (this
table is a hard contract — they must always agree):

| `paths.ts` (prod)                                        | staged into              |
| -------------------------------------------------------- | ------------------------ |
| `bunBinary()` → `<resourcesPath>/bin/bun`                | `resources/bin/bun`      |
| `ffmpegBinaryPath()` → `<resourcesPath>/bin/ffmpeg`      | `resources/bin/ffmpeg`   |
| `backendEntry()` → `<resourcesPath>/backend/src/main.ts` | `resources/backend/...`  |
| `webDistPath()` → `<resourcesPath>/web`                  | `resources/web`          |
| `appIconPath()`/`trayIconPath()` → `<resourcesPath>/icons/<N>x<N>.png` | `resources/icons` |

The staged backend gets a **synthesized** `package.json` (not a copy of the repo root's — that one
carries dev-only tooling like husky's `prepare` script, which would fail outside a git checkout)
listing the root's external runtime deps plus `workspace:*` entries; `bun install --production` inside
`resources/backend` resolves those into a self-contained `node_modules`. It carries the **real**
release version (staged from the root `package.json`), so `GET /api/system` reports the correct
version, not `0.0.0`. This was verified end-to-end locally (stage → `bun install --production` → spawn
`bun run` against the staged tree → `NICOTIND_LISTENING` handshake) before shipping.

`electron-builder.yml`: `appId: ar.kevinroberts.nicotind.desktop`; `asarUnpack` + `extraResources`
keep the backend/bun/ffmpeg as real executables outside the asar; **linux** → AppImage + deb
(category Audio); **macOS** → dmg (**arm64 only** — the Intel/x64 target was dropped: current
Apple hardware is all Apple Silicon, and building both doubled the ~10×-billed macOS CI time and
release size; Intel-Mac users build from source). The `dmg.artifactName` is pinned to
`${productName}-${version}-${arch}.${ext}` (→ `NicotinD-<v>-arm64.dmg`) for naming cohesion with
the AppImage/deb. The icon pack is the multi-size PWA set
(`packages/web/public/icons/`) staged into `build/icons/{16,24,32,48,64,128,256,512,1024}x{N}.png`
by `scripts/stage-icons.mjs` (regenerated on every `dist`; uses `ffmpeg` `scale=…:flags=lanczos`
— system ffmpeg first, falling back to the `ffmpeg-static` devDependency already present for the
sidecar's transcode, so no new runtime deps). The same pack is consumed twice: electron-builder's
`icon: build/icons` covers **packaging-time** icons (dock/dmg, deb install hooks under
`/usr/share/icons/hicolor/`), while `prepare-resources.ts stageIcons()` copies it to
`resources/icons/` for the **runtime** lookups (`appIconPath()`/`trayIconPath()` — without that
copy the packaged tray has no icon and silently never installs, stranding Linux hide-on-close
with no way back). electron-builder picks the directory up automatically; the deb install hook
stages icons to `/usr/share/icons/hicolor/<N>x<N>/apps/nicotind.png` and the dock icon uses
`512x512`/`1024x1024`. `publish: github (kevinch3/NicotinD)`.

> **The deb target needs an explicit `artifactName`.** electron-builder's default deb
> filename is `${name}_${version}_${arch}.${ext}`, and our package `name` is the *scoped*
> `@nicotind/desktop` — fpm reads the `/` as a path separator and dies with
> *"Parent directory does not exist: release/@nicotind"*, failing the whole `desktop-linux`
> job (which used to fail *silently* under `continue-on-error` — since dropped, see Build & CI).
> Fixed by `deb.artifactName:
> ${productName}_${version}_${arch}.${ext}` (→ `NicotinD_<v>_amd64.deb`). AppImage was
> unaffected because its default already uses `${productName}`. Verified end-to-end on a
> real Linux desktop: `bunx electron-builder --linux` produces both AppImage + deb, and the
> **packaged** AppImage boots the full Variant-B sidecar chain (bundled `bun` runs the
> staged backend, binds a loopback port, `/api/health` answers, the SPA renders).
>
> **electron-builder 26 hit the same scoped-name pitfall one level lower.** Bumping
> `electron-builder` 25→26 (alongside Electron 33→43) changed the Linux packager's
> `executableName` fallback from the sanitized `productName` to the sanitized package
> **name** (`app-builder-lib`'s `linuxPackager.js`), and 26 added a hard validation that
> rejects any `@`/`/` left in it — so every `desktop-linux` release job from v0.1.234
> onward failed at `building target=AppImage` with *"executableName contains characters
> that cannot be safely used in file paths: @nicotinddesktop"* before a single artifact
> was produced. Fixed the same way as the deb name: pin `executableName: NicotinD` at the
> top level of `electron-builder.yml` so both platforms resolve it from the explicit value
> instead of the scoped `@nicotind/desktop` package name.

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

Tag-triggered jobs in `.github/workflows/deploy.yml` (mirroring the Android/iOS jobs,
`if: github.ref_type == 'tag'`). They are **not** `continue-on-error` — a packaging failure turns
the release run **red** so a broken release is caught, instead of silently shipping a tag with no
artifacts (as the scoped-name deb bug did). They still never block the server `deploy` job: it runs
in parallel with no `needs` linkage, so its success is independent of packaging.

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
