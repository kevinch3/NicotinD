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
