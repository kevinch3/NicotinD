import type { App } from 'electron';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Loaded lazily (not as a static `import`) so this module can be imported —
// transitively, e.g. by `sidecar.ts` — from a plain `bun:test` process that
// never boots Electron. Outside an actual Electron runtime, requiring
// `'electron'` resolves to a plain path string rather than the real API, so
// this must only ever be called from within the app (never at module-eval
// time); every exported function below only touches it inside its body.
const electronRequire = createRequire(import.meta.url);
function getApp(): App {
  return (electronRequire('electron') as { app: App }).app;
}

/**
 * Path resolution for the Bun sidecar and its supporting binaries.
 *
 * Two layouts are supported:
 *  - **dev**: `bun run --filter @nicotind/desktop dev` runs straight out of
 *    the monorepo checkout — the backend entry is the repo's `src/main.ts`
 *    and `bun`/`ffmpeg` are resolved from PATH.
 *  - **prod** (packaged app, Variant B): the packager (Task 11) stages the
 *    `bun` binary, backend source, and `web/dist` under
 *    `process.resourcesPath` so the sidecar can `spawn(bun, ['run', entry])`
 *    without a compiled binary. Layout:
 *      <resourcesPath>/bin/bun
 *      <resourcesPath>/bin/ffmpeg
 *      <resourcesPath>/backend/src/main.ts
 *      <resourcesPath>/web
 */

/** True when NOT running from a packaged (`electron-builder`/`electron-forge`) app. */
export function isDev(): boolean {
  return !getApp().isPackaged;
}

/**
 * Repo root, resolved relative to this file (`packages/desktop/electron/`)
 * — only meaningful in dev; unused in prod.
 */
function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

/** Absolute path to the backend entrypoint `bun run` should execute. */
export function backendEntry(): string {
  if (isDev()) {
    return path.join(repoRoot(), 'src', 'main.ts');
  }
  return path.join(process.resourcesPath, 'backend', 'src', 'main.ts');
}

/** Absolute path (or bare command, resolved via PATH in dev) to the `bun` binary. */
export function bunBinary(): string {
  if (isDev()) {
    return 'bun';
  }
  return path.join(process.resourcesPath, 'bin', 'bun');
}

/** Absolute path to a bundled `ffmpeg`, or `undefined` to let the backend fall back to PATH (dev). */
export function ffmpegBinaryPath(): string | undefined {
  if (isDev()) {
    return undefined;
  }
  return path.join(process.resourcesPath, 'bin', 'ffmpeg');
}

/** Absolute path to the built Angular SPA the backend should serve. */
export function webDistPath(): string {
  if (isDev()) {
    return path.join(repoRoot(), 'packages', 'web', 'dist');
  }
  return path.join(process.resourcesPath, 'web');
}

/** Per-user writable data directory (config, SQLite DB, downloads staging, etc.). */
export function userDataDir(): string {
  return getApp().getPath('userData');
}

/** Directory sidecar logs are written to; created if missing. */
export function logsDir(): string {
  const dir = path.join(userDataDir(), 'logs');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * App-level icon (window corner / dock), per platform.
 *
 * In prod the multi-size pack is staged under `<resourcesPath>/icons/`
 * (see `scripts/stage-icons.mjs` + `electron-builder.yml icon:`). In dev
 * we fall back to the raw PWA source so `bun run dev:desktop` shows the
 * real brand mark instead of the OS default Electron icon.
 *
 * Returns `undefined` when nothing exists on disk; `BrowserWindow`
 * silently drops the option in that case.
 */
export function appIconPath(platform: NodeJS.Platform): string | undefined {
  const prodPath = isDev()
    ? undefined
    : path.join(process.resourcesPath, 'icons', `${platformIconFileName(platform)}.png`);
  if (prodPath && existsSync(prodPath)) {
    return prodPath;
  }
  const devPath = path.join(
    repoRoot(),
    'packages',
    'web',
    'public',
    'icons',
    'icon-512.png',
  );
  return existsSync(devPath) ? devPath : undefined;
}

/**
 * Tray status icon (~32 px is the canonical Linux tray size; macOS
 * templates bitmaps but a regular small PNG works in dev).
 *
 * The same staged multi-size pack covers both this and `appIconPath`; the
 * paths only differ in which size they pick. In dev we resolve the same
 * PWA set.
 */
export function trayIconPath(platform: NodeJS.Platform): string | undefined {
  const prodPath = isDev()
    ? undefined
    : path.join(process.resourcesPath, 'icons', `${platformTrayFileName(platform)}.png`);
  if (prodPath && existsSync(prodPath)) {
    return prodPath;
  }
  const devPath = path.join(
    repoRoot(),
    'packages',
    'web',
    'public',
    'icons',
    'icon-32.png',
  );
  return existsSync(devPath) ? devPath : undefined;
}

/** Per-platform preferred window-icon filename from the staged icon pack. */
function platformIconFileName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '512x512';
  // Linux/Windows package icon — electron-builder's default is 256.
  return '256x256';
}

/** Preferred tray-icon filename from the staged icon pack (~32 px is the
 *  canonical tray size on every platform we target). */
function platformTrayFileName(_platform: NodeJS.Platform): string {
  return '32x32';
}
