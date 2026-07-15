import { defineConfig } from '@playwright/test';

/**
 * Minimal Playwright config for the desktop package's packaged-boot smoke
 * test (Task 13). Unlike `packages/e2e/playwright.config.ts` there is no
 * `webServer` entry — the app under test IS the server (Electron spawns the
 * Bun backend itself via `Sidecar.start()`), so nothing needs to be booted
 * ahead of time beyond `packages/desktop` (`bun run build`) and
 * `packages/web` (`ng build`) already being built on disk.
 *
 * Not part of the `packages/e2e` suite: this drives a real Electron window
 * (`_electron`), not a browser page, and needs a real display (Xvfb in CI —
 * wired up in Task 14) rather than Playwright's bundled Chromium.
 */
export default defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  reporter: process.env.CI ? [['list']] : 'list',
});
