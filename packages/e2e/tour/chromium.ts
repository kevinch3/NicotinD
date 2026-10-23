import type { LaunchOptions } from '@playwright/test';

/**
 * `TOUR_CHROMIUM_PATH` points the tour at a Chromium other than the one the
 * pinned Playwright expects — for a machine whose preinstalled browser build
 * does not match it. Unset, Playwright's own browser is used.
 */
export function chromiumLaunchOptions(): LaunchOptions {
  const executablePath = process.env.TOUR_CHROMIUM_PATH;
  return executablePath ? { executablePath } : {};
}
