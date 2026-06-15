import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';

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
      testMatch: /mobile-screenshots\.screens\.ts/,
      use: { ...devices['Pixel 7'], storageState: '.auth/admin.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'bun run src/main.ts',
    cwd: repoRoot,
    url: `${baseURL}/api/health`,
    reuseExistingServer: true,
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
    },
  },
});
