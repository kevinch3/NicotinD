import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWebBuild } from './ensure-web-build.js';
import { isMainProcess } from './fixture-music.js';
import { DEMO_MUSIC_DIR } from './tour/make-demo-library.js';
import { DEMO_ADDON_PORT, DEMO_LIDARR_PORT } from './tour/demo-services.js';
import { chromiumLaunchOptions } from './tour/chromium.js';

/**
 * The product tour (docs/product-tour.md): drives the real app over the demo
 * catalog and records it. Not part of CI — run it to cut a new video:
 *
 *   bun run --filter @nicotind/e2e tour        # record into tour-output/
 *   bun run packages/e2e/tour/cut-tour.ts      # assemble the README video
 *
 * The server is real and so is everything behind it except two stand-ins: the
 * demo Lidarr (catalog metadata) and the demo addon (the source), both serving
 * the generated catalog from `@nicotind/core`'s demo module.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const PORT = process.env.TOUR_PORT ?? '8690';
const baseURL = `http://localhost:${PORT}`;
const dataDir = resolve(__dirname, '.tmp-data-tour');
const musicDir = resolve(__dirname, '.tmp-music-tour');

if (isMainProcess()) {
  // Generating the catalog is async (ffmpeg, Chromium); the config is not.
  execFileSync('bun', ['run', resolve(__dirname, 'tour/make-demo-library.ts')], {
    stdio: 'inherit',
  });
  rmSync(dataDir, { recursive: true, force: true });
  // The server writes into its music dir (landed downloads, tags), so it gets a
  // throwaway copy and the generated library stays reusable across runs.
  rmSync(musicDir, { recursive: true, force: true });
  cpSync(DEMO_MUSIC_DIR, musicDir, { recursive: true });
}
ensureWebBuild();

export default defineConfig({
  testDir: './tour',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: './tour-output/raw',
  timeout: 180_000,
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off',
    launchOptions: chromiumLaunchOptions(),
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'tour-setup', testMatch: /tour\.setup\.ts$/ },
    {
      name: 'tour',
      testMatch: /\.tour\.ts$/,
      dependencies: ['tour-setup'],
      use: {
        storageState: '.auth/tour.json',
        video: { mode: 'on', size: { width: 1280, height: 720 } },
      },
    },
  ],
  webServer: [
    {
      command: 'bun run tour/demo-services.ts',
      cwd: __dirname,
      url: `http://127.0.0.1:${DEMO_ADDON_PORT}/addon/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
    },
    {
      command: 'bun run src/main.ts',
      cwd: repoRoot,
      url: `${baseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NICOTIND_PORT: PORT,
        NICOTIND_MODE: 'external',
        NICOTIND_SLSKD_URL: 'http://127.0.0.1:1',
        NICOTIND_LIDARR_URL: `http://127.0.0.1:${DEMO_LIDARR_PORT}`,
        LIDARR_API_KEY: 'demo',
        NICOTIND_DATA_DIR: dataDir,
        NICOTIND_MUSIC_DIR: musicDir,
      },
    },
  ],
});
