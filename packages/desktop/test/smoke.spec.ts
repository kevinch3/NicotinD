/**
 * Packaged boot smoke test (Task 13).
 *
 * Launches the *built* Electron main process (`dist/main.js`, in dev-mode
 * path resolution — see `electron/paths.ts`) via Playwright's `_electron`
 * runner and asserts the whole boot chain actually works end to end:
 * `Sidecar.start()` spawns `bun run src/main.ts`, the backend binds a port
 * and emits the `NICOTIND_LISTENING <port>` handshake, `createMainWindow()`
 * loads the served SPA, and the Angular app renders past its initial
 * `/api/setup/status` check into a real route.
 *
 * NOT runnable in a headless/no-display sandbox: this requires a real
 * Electron binary and a display (Xvfb in CI). It is intentionally excluded
 * from `bun test` (see `package.json`'s `test` script and the
 * `--path-ignore-patterns 'test/**'` flag) and is wired into CI under xvfb
 * in Task 14 via the `test:smoke` script.
 *
 * Prerequisites for a real run:
 *  - `packages/desktop` built (`bun run build` → `dist/main.js` exists).
 *  - `packages/web` built (`packages/web/dist` exists) — dev-mode
 *    `webDistPath()` serves straight from the repo checkout.
 *  - `bun` on PATH — dev-mode `bunBinary()` spawns `bun run <entry>`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, _electron as electron, expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const mainJs = path.resolve(__dirname, '..', 'dist', 'main.js');
const fixturesMusicDir = path.resolve(repoRoot, 'packages', 'e2e', 'fixtures', 'music');

// A stable, known-early-load testid: a fresh `--user-data-dir` has no
// backend DB yet, so `/api/setup/status` reports `needsSetup: true` and
// `App`'s constructor effect (packages/web/src/app/app.ts) redirects to
// `/setup`, whose first field carries this testid
// (packages/web/src/app/pages/setup/setup.component.html). Reaching it
// proves: sidecar spawned, bound a port, passed its own health check,
// `createMainWindow` loaded the loopback URL, and the Angular SPA booted
// and completed its first authenticated-status API round-trip.
const EARLY_LOAD_TESTID = '[data-testid="setup-username"]';

const BOOT_TIMEOUT_MS = 60_000;

test.describe('packaged boot smoke test', () => {
  test.skip(!existsSync(mainJs), `${mainJs} not built — run "bun run build" in packages/desktop first`);

  let electronApp: ElectronApplication | undefined;
  let userDataDir: string;

  test.beforeEach(() => {
    // Fresh throwaway --user-data-dir per test run: Electron honors this
    // standard Chromium switch out of the box (no app code needed), and
    // `paths.ts`'s `userDataDir()` (= `app.getPath('userData')`) is what
    // `Sidecar.buildEnv()` hands the backend as `NICOTIND_DATA_DIR` — so
    // this one switch gives both Electron's own storage AND the backend's
    // SQLite/config a hermetic, empty directory (guaranteeing `needsSetup`).
    userDataDir = mkdtempSync(path.join(tmpdir(), 'nicotind-desktop-smoke-'));
  });

  test.afterEach(async () => {
    await electronApp?.close();
    electronApp = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('boots the sidecar and renders the SPA shell', async () => {
    electronApp = await electron.launch({
      // CI-only Chromium switches for a headless GitHub runner under Xvfb:
      //  --no-sandbox           runners don't ship a root-owned SUID sandbox
      //                         helper, so Electron aborts on launch otherwise.
      //  --disable-gpu          no GPU under Xvfb — without this the GPU process
      //                         hangs and `ready-to-show` never fires, so
      //                         Playwright's `firstWindow()` times out even
      //                         though the window was created.
      //  --disable-dev-shm-usage  CI containers have a tiny /dev/shm; avoids
      //                         Chromium crashing when it fills up.
      // Local/on-device runs keep the real OS sandbox + GPU (matching the
      // shipped `sandbox: true` config). The CJS preload works either way.
      args: [
        ...(process.env.CI ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []),
        mainJs,
        `--user-data-dir=${userDataDir}`,
      ],
      env: {
        ...process.env,
        // Surface Electron's own logging so a CI failure here is diagnosable
        // (GPU/sandbox aborts, main-process console.error from a failed
        // sidecar start) rather than an opaque `firstWindow` timeout.
        ELECTRON_ENABLE_LOGGING: 'true',
        // Points the sidecar's dev-mode `bun run src/main.ts` at the e2e
        // suite's committed silent-FLAC fixtures, so the backend has a real
        // (tiny) library to scan instead of an empty configured dir.
        // `Sidecar.buildEnv()` spreads `...process.env` first and only
        // overrides `NICOTIND_MUSIC_DIR` itself when a desktop-config value
        // is set (never true for a fresh --user-data-dir), so this passes
        // straight through.
        NICOTIND_MUSIC_DIR: fixturesMusicDir,
      },
    });

    // Tee the Electron process's own stdout/stderr into the test output so a
    // launch/boot failure is visible in CI logs (see ELECTRON_ENABLE_LOGGING).
    const proc = electronApp.process();
    proc.stdout?.on('data', (d: Buffer) => console.log('[electron]', d.toString().trimEnd()));
    proc.stderr?.on('data', (d: Buffer) => console.error('[electron]', d.toString().trimEnd()));

    const window: Page = await electronApp.firstWindow();

    // The window is first loaded against an inline `data:` "Starting
    // NicotinD…" placeholder (`main.ts`) while the sidecar cold-starts a
    // full Bun backend + scans the fixtures; only once that resolves does
    // it navigate to the real loopback URL and render the Angular shell.
    // Generous timeout: this is a real backend boot, not a mocked one.
    const field = window.locator(EARLY_LOAD_TESTID);
    await expect(field).toBeVisible({ timeout: BOOT_TIMEOUT_MS });

    // The window's URL is the sidecar's real bound loopback origin once
    // navigation away from the placeholder has happened (guaranteed by the
    // assertion above) — reuse it to hit /api/health directly instead of
    // threading the dynamic port out through some extra test-only hook.
    const origin = new URL(window.url()).origin;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await fetch(`${origin}/api/health`);
    expect(health.ok).toBe(true);
    const body = (await health.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });
});
