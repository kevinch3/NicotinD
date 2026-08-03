import { test, expect } from '@playwright/test';
import { shot } from '../playground/shot';

/**
 * Settings-family screenshot gallery (Task 5, settings-cards unification).
 * Every route below was migrated onto the shared `app-settings-group`
 * collapsible card (Tasks 1-4); this flow captures each route TWICE — once
 * collapsed (the real default a user lands on) and once fully expanded (every
 * `settings-group-toggle`, and on Extensions every `plugin-card-toggle` too) —
 * so a human reviewer can eyeball cross-page visual consistency side by side.
 *
 * Runs under `playwright.screenshots.config.ts` in both a `mobile` (Pixel 7)
 * and a `desktop` (1280x900) project. The flow name is suffixed with the
 * project name so the two runs never collide on `shot()`'s deterministic
 * `screenshots/mobile/<flow>/NN-label.png` path (the constant `ROOT` there is
 * shared across projects; only the `<flow>` segment differentiates them).
 *
 * Step numbers are one running counter across all five routes so the output
 * folder sorts into a single readable story (01-settings-collapsed,
 * 02-settings-expanded, 03-admin-collapsed, ...).
 */
const ROUTES: Array<{ path: string; label: string }> = [
  { path: '/settings', label: 'settings' },
  { path: '/admin', label: 'admin' },
  { path: '/settings/plugins', label: 'plugins' },
  { path: '/settings/devices', label: 'devices' },
  { path: '/settings/agent-tokens', label: 'agent-tokens' },
];

/** Every persisted group-open key is prefixed `nicotind-group-` (see
 * `lib/group-state.ts`). Cleared + reloaded before each route's "collapsed"
 * shot so a prior route's expansion (or a leftover run) can never leak a
 * false "already open" state into this route's default-state capture. */
async function resetGroupState(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('nicotind-group-')) localStorage.removeItem(key);
    }
  });
  await page.reload();
}

async function expandAllToggles(
  page: import('@playwright/test').Page,
  testId: string,
): Promise<void> {
  const toggles = page.getByTestId(testId);
  const count = await toggles.count();
  for (let i = 0; i < count; i++) {
    const toggle = toggles.nth(i);
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
  }
}

test('capture settings gallery', async ({ page }, testInfo) => {
  const flow = `settings-gallery-${testInfo.project.name}`;
  let step = 1;

  for (const route of ROUTES) {
    await page.goto(route.path);
    await expect(page.locator('[data-group-id]').first()).toBeVisible();
    await resetGroupState(page);
    await expect(page.locator('[data-group-id]').first()).toBeVisible();
    await page.waitForTimeout(300);

    await shot(page, flow, step++, `${route.label}-collapsed`);

    await expandAllToggles(page, 'settings-group-toggle');
    if (route.path === '/settings/plugins') {
      await expandAllToggles(page, 'plugin-card-toggle');
    }
    await page.waitForTimeout(300);

    await shot(page, flow, step++, `${route.label}-expanded`, { fullPage: true });
  }
});
