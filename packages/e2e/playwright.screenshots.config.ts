import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { ensureWebBuild } from './ensure-web-build.js';

/**
 * One-off mobile screenshot harness (not part of CI). Boots the managed test
 * server against the committed fixtures, seeds the admin via the shared
 * auth.setup.ts, then drives the SPA in a mobile viewport capturing the key
 * screens for UX review. Run with:
 *   bunx playwright test --config=playwright.screenshots.config.ts
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const PORT = process.env.E2E_PORT ?? '8585';
const baseURL = `http://localhost:${PORT}`;

const dataDir = resolve(__dirname, '.tmp-data');
rmSync(dataDir, { recursive: true, force: true });

// Same managed-server/prebuilt-dist hazard as the main config (issue #253): a
// screenshot harness silently capturing the previous bundle is the whole point
// of the harness defeated.
ensureWebBuild();

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL, trace: 'off', screenshot: 'off' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'mobile',
      testMatch: /(mobile-screenshots|settings-gallery)\.screens\.ts/,
      use: { ...devices['Pixel 7'], storageState: '.auth/admin.json' },
      dependencies: ['setup'],
    },
    // Desktop-viewport counterpart of the gallery only (mobile-screenshots.screens.ts
    // is a mobile-only UX review flow, not part of this project). shot()'s `<flow>`
    // segment is suffixed with the project name (see settings-gallery.screens.ts), so
    // the two projects' outputs land in separate folders under the shared
    // `screenshots/mobile` root and never collide.
    {
      name: 'desktop',
      testMatch: /settings-gallery\.screens\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        storageState: '.auth/admin.json',
      },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'bun run src/main.ts',
    cwd: repoRoot,
    url: `${baseURL}/api/health`,
    // See playwright.config.ts: this config also wipes `dataDir` at eval time, so
    // reusing a server that still holds the deleted DB open would serve stale data.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NICOTIND_PORT: PORT,
      NICOTIND_MODE: 'external',
      NICOTIND_SLSKD_URL: 'http://127.0.0.1:1',
      NICOTIND_LIDARR_URL: 'http://127.0.0.1:1',
      NICOTIND_DATA_DIR: dataDir,
      NICOTIND_MUSIC_DIR: resolve(__dirname, 'fixtures/music'),
      // Bypass the process-before-landing gate (see playwright.config.ts's
      // makeServer for the full rationale): the silent-FLAC fixtures can't
      // yield a confident BPM/key, so without this the fixtures stay
      // quarantined forever and every screen this harness captures is empty
      // (issue #352 — this config was never updated when the landing gate
      // shipped, unlike the main e2e config).
      NICOTIND_DISABLE_LANDING_GATE: '1',
    },
  },
});
