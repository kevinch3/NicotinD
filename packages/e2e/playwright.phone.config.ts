import { defineConfig } from '@playwright/test';

/**
 * Android phone emulator lane. Run it with `bun run e2e:phone`, which handles the
 * emulator/APK/server lifecycle first (android/preflight.ts) — invoking
 * `playwright test` against this config directly fails in the `device` fixture
 * with a pointer back here.
 *
 * Like the TV lane: NO browser project and no `use.browserName`, because the
 * `page` fixture in `phone/fixtures.ts` returns the emulator's WebView page.
 *
 * See docs/e2e-tv-emulator.md, "The phone lane".
 */
export default defineConfig({
  testDir: './tests-phone',
  testMatch: /\.phone\.spec\.ts$/,
  fullyParallel: false,
  // One device, one app, one vibrator history.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A local gate: a retry would hide a tick that fires only sometimes.
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
