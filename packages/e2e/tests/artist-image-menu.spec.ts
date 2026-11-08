import { test, expect } from '../helpers';
import { bearer, openAlbumCard } from '../helpers';

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
    await openAlbumCard(page);
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

  // #1666: `/api/cover/<id>` is cached by URL for a day, so a replaced portrait
  // must move the URL. The upload answers the new cover rev and the page's
  // portrait re-keys to `v=<rev>` in a real browser, then survives a reload
  // (the rev is on the DTO, not in a page-local counter).
  test('an uploaded portrait moves the portrait URL, and a reload keeps it', async ({
    page,
    request,
  }) => {
    await page.goto('/library');
    await openAlbumCard(page);
    await page.locator('a[href^="/library/artists/"]').first().click();
    await expect(page).toHaveURL(/\/library\/artists\//);
    const artistId = new URL(page.url()).pathname.split('/').pop()!;
    const portrait = page.locator(
      `img:not([data-testid="cover-art-held"])[src*="/api/cover/${artistId}?size=200"]`,
    );
    // Reset over the API before and after, not through the UI: a failed
    // attempt must not leave an override that turns the precondition below
    // into the failure on CI's retry, or leak into later specs on the shared
    // library. The token is read up front so the reset works on a broken page.
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    const resetPortrait = async () => {
      const res = await request.delete(`/api/library/artists/${artistId}/image`, {
        headers: bearer(token ?? ''),
      });
      expect(res.ok(), 'portrait reset should succeed').toBe(true);
    };
    await resetPortrait();
    await page.reload();

    try {
      // A fixture artist has no portrait: its URL 404s and the placeholder
      // takes the <img>'s place, which is exactly what a stale URL would keep
      // doing after the upload.
      await expect(page.getByTestId('artist-image-menu-trigger').first()).toBeVisible();
      await expect(portrait).toHaveCount(0);

      const uploaded = page.waitForResponse(
        (r) =>
          r.url().includes(`/api/library/artists/${artistId}/image`) &&
          r.request().method() === 'PUT',
      );
      await page
        .getByTestId('artist-image-file')
        .first()
        .setInputFiles({
          name: 'portrait.png',
          mimeType: 'image/png',
          buffer: Buffer.from(ONE_PX_PNG, 'base64'),
        });
      const { coverRev } = (await (await uploaded).json()) as { coverRev: number };
      expect(coverRev).toBeGreaterThan(0);

      await expect(portrait).toHaveAttribute('src', new RegExp(`[?&]v=${coverRev}&`));

      await page.reload();
      await expect(portrait).toHaveAttribute('src', new RegExp(`[?&]v=${coverRev}&`));
    } finally {
      await resetPortrait();
    }
  });
});

/** A valid 1x1 PNG, enough for the override route and the cover resizer. */
const ONE_PX_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
