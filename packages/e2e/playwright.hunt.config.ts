import { defineConfig, devices } from '@playwright/test';

/**
 * One-off mobile HUNT flow against a LIVE backend (prod). Unlike the screenshots
 * config this never boots a managed server — it points at E2E_BASE_URL and logs
 * in with PLAYGROUND_USERNAME / PLAYGROUND_PASSWORD via the shared
 * playground.setup.ts. Drives search -> Zara Larsson -> album-hunt modal and
 * captures screenshots for UX review. Run with:
 *   E2E_BASE_URL=https://nicotined.kevinroberts.ar \
 *   PLAYGROUND_USERNAME=claude-e2e PLAYGROUND_PASSWORD=… \
 *   bunx playwright test --config=playwright.hunt.config.ts
 */
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw new Error('E2E_BASE_URL is required for the hunt flow (live backend).');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL, trace: 'off', screenshot: 'off' },
  projects: [
    { name: 'setup', testMatch: /playground\.setup\.ts/ },
    {
      name: 'mobile',
      testMatch: /(hunt-mobile|network-album-download)\.screens\.ts/,
      use: { ...devices['Pixel 7'], storageState: '.auth/playground.json' },
      dependencies: ['setup'],
    },
  ],
  // No webServer: we run against the external live instance.
});
