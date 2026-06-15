import { defineConfig, devices } from '@playwright/test';

/**
 * Live mobile SCREENSHOT flows against a real backend (prod). Like
 * playwright.hunt.config.ts it never boots a managed server — it points at
 * E2E_BASE_URL and logs in via the shared playground.setup.ts. Unlike the hunt
 * config (which mutates prod by downloading), these flows are read-mostly: the
 * player/analysis and downloads/acquire journeys only navigate + snapshot, and
 * their few mutating sub-steps are gated behind PLAYGROUND_ANALYZE /
 * PLAYGROUND_ACQUIRE_URL.
 *
 * Because the flows use the playground `obs` fixture, this config wires the
 * playground reporter so a single run produces BOTH the per-flow screenshots
 * (screenshots/mobile/<flow>/) and the aggregated findings report
 * (playground-report/playground-report.{md,json}). Run with:
 *   E2E_BASE_URL=https://nicotined.kevinroberts.ar \
 *   PLAYGROUND_USERNAME=claude-e2e PLAYGROUND_PASSWORD=… \
 *   bun run --filter @nicotind/e2e screens:live
 */
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw new Error('E2E_BASE_URL is required for live screenshot flows.');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['./playground/reporter.ts']],
  use: { baseURL, trace: 'off', screenshot: 'off' },
  projects: [
    { name: 'setup', testMatch: /playground\.setup\.ts/ },
    {
      name: 'mobile',
      testMatch: /(player-analysis|downloads-acquire)\.screens\.ts/,
      use: { ...devices['Pixel 7'], storageState: '.auth/playground.json' },
      dependencies: ['setup'],
    },
  ],
  // No webServer: we run against the external live instance.
});
