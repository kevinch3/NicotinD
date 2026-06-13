import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

/**
 * When E2E_BASE_URL is set we run against an already-running instance (e.g. prod
 * smoke: E2E_BASE_URL=https://nicotined.kevinroberts.ar) and skip the webServer.
 */
const externalBaseUrl = process.env.E2E_BASE_URL;
// Dedicated port for the managed test server so it never collides with a
// developer's running instance on the default 8484.
const PORT = process.env.E2E_PORT ?? '8585';
const baseURL = externalBaseUrl ?? `http://localhost:${PORT}`;

// Fresh DB per run so the first user is always our admin (deterministic setup).
// Done at config-eval time — before Playwright launches the webServer — because
// the webServer opens the SQLite DB on boot and a globalSetup hook would be too
// late. Only wipe the local throwaway dir, never when pointed at an external URL.
const dataDir = resolve(__dirname, '.tmp-data');
if (!externalBaseUrl) {
  rmSync(dataDir, { recursive: true, force: true });
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: '.auth/admin.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'bun run src/main.ts',
        cwd: repoRoot,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          NICOTIND_PORT: PORT,
          NICOTIND_MODE: 'external', // never spawn slskd; no Soulseek creds set
          // Point at a dead slskd so the test server can't reach (or mutate) any
          // real instance on the default :5030. Acquisition is default-off anyway;
          // boot tolerates an unreachable slskd.
          NICOTIND_SLSKD_URL: 'http://127.0.0.1:1',
          NICOTIND_LIDARR_URL: 'http://127.0.0.1:1', // likewise isolate from a real Lidarr
          NICOTIND_DATA_DIR: dataDir,
          NICOTIND_MUSIC_DIR: resolve(__dirname, 'fixtures/music'),
        },
      },
});
