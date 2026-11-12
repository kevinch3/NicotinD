import { test, expect } from '../helpers';

// The e2e server serves the PROD bundle, prod Sentry DSN included. Before
// `isNonUserSession`, every test here opened a Sentry session (and a replay on any
// error), draining the account's replay quota. Nothing under test may reach Sentry.
test('an automated browser on localhost never contacts Sentry', async ({ page }) => {
  const sentryRequests: string[] = [];
  await page.route(/sentry\.io/, (route) => {
    sentryRequests.push(route.request().url());
    return route.abort();
  });

  await page.goto('/');
  // Bootstrapped: loadSentry runs in bootstrap's `.then()`, and an initialized SDK
  // sends its session envelope at once. The app holds a live socket, so
  // `networkidle` never settles — an absence needs a bounded window instead.
  await expect(page.getByTestId('home-view-switch')).toBeVisible();
  await page.waitForTimeout(3000);

  expect(sentryRequests).toEqual([]);
});
