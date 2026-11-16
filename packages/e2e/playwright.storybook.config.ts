import { defineConfig } from '@playwright/test';

/**
 * Visual regression over the Storybook catalog (#473): one screenshot per
 * story, compared with a baseline committed under `storybook/baselines/`.
 *
 *   bun run visual:storybook           compare (what CI and `verify` run)
 *   bun run visual:storybook:update    rewrite the baselines after a visual change
 *
 * It reads `packages/web/storybook-static`, so `bun run build:storybook` comes
 * first. In-repo baselines rather than a hosted service: no third party sees
 * the renders and no token sits in CI. → docs/storybook.md "Visual regression"
 */
const PORT = Number(process.env.STORYBOOK_VISUAL_PORT ?? 6116);

export default defineConfig({
  testDir: './storybook',
  testMatch: /\.visual\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A retry would hide a story that renders differently every other time.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  // Much tighter than the e2e screenshot baselines (3 % of pixels at a 0.3
  // colour threshold), and measured to need to be. At those numbers a story
  // passed against ANOTHER story's baseline: on a dark theme a surface differs
  // from the page by less than the colour threshold, so only text counts, and
  // text is under 3 % of an 800x600 frame. At 0.5 % a story still passed
  // against a sibling that differed by two captions (1,707 pixels). An
  // absolute 100 pixels fails both and passes the unchanged catalog.
  expect: {
    toHaveScreenshot: { maxDiffPixels: 100, threshold: 0.2, caret: 'hide' },
  },
  snapshotPathTemplate: '{testDir}/baselines/{arg}{ext}',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    channel: 'chromium',
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'node scripts/serve-storybook.mjs',
    url: `http://127.0.0.1:${PORT}/index.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
