import { test, expect } from '../playground/fixtures';
import { appeared, firstPresent } from '../playground/screens-ui';

/**
 * Downloads feed feedback flow. Read-only — the page is now Active-feed-only
 * ("Recently Added" + "Saved Offline" moved to the Library Songs tab), so this
 * counts feed items, notes retry/cancel/remove affordances, and records console
 * health + a terminal outcome. Safe against prod (no mutations).
 * See docs/testing-routines.md.
 */
test('downloads-feed', async ({ page, obs }) => {
  const j = obs.journey();

  await obs.time('open /downloads', async () => {
    await page.goto('/downloads');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
  j.step('open /downloads');

  // Count whatever the feed currently shows (zero is fine on a clean stack).
  const items = await page.getByTestId('download-item').count();
  obs.record({
    kind: 'metric',
    title: 'Download feed items (current tab)',
    value: items,
    unit: 'count',
    severity: 'info',
  });

  // Note the lifecycle affordances exist when there *is* something to act on.
  if (items > 0) {
    const hasActions =
      (await firstPresent(
        page.getByRole('button', { name: /retry/i }),
        page.getByRole('button', { name: /cancel/i }),
        page.getByRole('button', { name: /remove|dismiss/i }),
      )) !== null;
    if (!hasActions) {
      j.fallback('no retry/cancel/remove control on a feed item');
    }
  }

  const empty = await appeared(page.getByText(/no .*downloads|nothing here/i), 2000);
  obs.outcome(items > 0 || empty ? 'success' : 'partial', `${items} feed item(s)`);
  expect(true).toBe(true); // a playground flow records, never asserts pass/fail
});
