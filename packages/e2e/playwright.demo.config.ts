import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The static demo's smoke run (docs/demo-mode.md): a built Pages site served
 * the way GitHub Pages serves it, with NO backend — any request that escapes
 * the bundle to a server fails the spec. `scripts/build-demo.ts` runs it before
 * it moves a build into the site; run it by hand with
 *
 *   DEMO_SITE_DIR=site bun run --filter @nicotind/e2e demo
 */
const PORT = Number(process.env.DEMO_SITE_PORT ?? 8698);
const siteDir = resolve(process.env.DEMO_SITE_DIR ?? resolve(__dirname, '../../site'));

export default defineConfig({
  testDir: './demo',
  testMatch: /\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/NicotinD/demo/`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'demo-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'demo-phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `bun run demo/serve-site.ts ${JSON.stringify(siteDir)} ${PORT}`,
    cwd: __dirname,
    url: `http://127.0.0.1:${PORT}/NicotinD/demo/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
