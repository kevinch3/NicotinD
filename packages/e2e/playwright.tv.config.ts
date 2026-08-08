import { defineConfig } from '@playwright/test';

/**
 * Android TV emulator lane. Run it with `bun run e2e:tv`, which handles the
 * emulator/APK/server lifecycle first — invoking `playwright test` against this
 * config directly will fail in the `device` fixture with a pointer back here.
 *
 * Deliberately declares NO browser project and no `use.browserName`: the `page`
 * fixture in `tv/fixtures.ts` returns the emulator's WebView page, so Playwright
 * must not also launch a local browser.
 *
 * See docs/e2e-tv-emulator.md.
 */
export default defineConfig({
  testDir: './tests-tv',
  testMatch: /\.tv\.spec\.ts$/,
  fullyParallel: false,
  // One device, one app, one WebView — parallelism here would have workers
  // fighting over the same focus state.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A local pre-release gate, not CI: a retry would mask exactly the flaky
  // focus behaviour this lane exists to surface.
  retries: 0,
  reporter: 'list',
  // Generous: every action crosses adb to an emulator.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
