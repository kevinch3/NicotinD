import { test, expect } from '@playwright/test';

/**
 * The artist-photo edit control, on both surfaces that host it.
 *
 * This exists because the control shipped **invisible**: its trigger was projected
 * with `trigger` instead of `menuTrigger`, and `MenuPanelComponent` drops content
 * that matches neither slot without complaining. The component's own 14-case suite
 * stayed green throughout, because every case called a method on the class and none
 * rendered it — and no e2e referenced the control at all. A real click in a real
 * browser is the check that would have caught it, so it belongs here rather than
 * only in jsdom.
 */
test.describe('artist image menu', () => {
  test('is reachable and opens on the artist page', async ({ page }) => {
    // Album detail → artist link, the same route library.spec.ts walks.
    await page.goto('/library');
    await page.getByTestId('album-card').first().click();
    await expect(page).toHaveURL(/\/library\/albums\//);
    await page.locator('a[href^="/library/artists/"]').first().click();
    await expect(page).toHaveURL(/\/library\/artists\//);

    const trigger = page.getByTestId('artist-image-menu-trigger').first();
    await expect(trigger).toBeVisible();

    await trigger.click();
    await expect(page.getByTestId('artist-image-upload')).toBeVisible();
  });

  test('is reachable on an Artists-grid tile too', async ({ page }) => {
    // The compact variant. Library tab state is localStorage-backed rather than a
    // URL param, so drive the real tab button.
    await page.goto('/library');
    await page
      .getByTestId('library-tabs')
      .getByRole('button', { name: /artists/i })
      .click();

    await expect(page.getByTestId('artist-image-menu-trigger').first()).toBeVisible();
  });
});
