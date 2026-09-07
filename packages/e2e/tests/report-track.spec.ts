import { test, expect } from '@playwright/test';
import { FIXTURE, openAlbumCard } from '../helpers';

/**
 * Issue #987. Until now a defect reached curation only through operator-side
 * MCP tools and audit predicates — the person best placed to notice a track is
 * mistagged is the one listening to it, and that observation had nowhere to go.
 */
test.describe('report a track', () => {
  /**
   * The Admin card ships collapsed, and a collapsed section renders no rows —
   * so asserting "no listener flag" against a closed card passes whatever the
   * truth is. Expanding first is what makes both assertions mean anything.
   */
  async function openNeedsReview(page: import('@playwright/test').Page) {
    await page.goto('/admin');
    const toggle = page
      .getByTestId('settings-group-toggle')
      .filter({ hasText: 'Needs review' })
      .first();
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }

  async function openReportDialog(page: import('@playwright/test').Page) {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await page.getByTestId('track-row').first().getByTestId('track-row-title').click();
    await page.getByTestId('player-title').click();
    await expect(page.getByTestId('now-playing-body')).toBeVisible();

    // The context menu hangs off the Now Playing title.
    await page.getByTestId('now-playing-title').click({ button: 'right' });
    await page.getByTestId('track-menu-report').click();
    await expect(page.getByTestId('report-track-dialog')).toBeVisible();
  }

  test('a listener report lands in the curation inbox', async ({ page }) => {
    await openReportDialog(page);

    await page.getByTestId('report-reason-mistagged').click();
    await page.getByTestId('report-note').fill('the year is wrong');
    await page.getByTestId('report-submit').click();
    await expect(page.getByTestId('report-track-dialog')).toBeHidden();

    await openNeedsReview(page);
    await expect(page.getByText('mistagged: the year is wrong')).toBeVisible();
    await expect(page.getByTestId('flag-source-listener').first()).toBeVisible();
  });

  /**
   * The one reason that must not reach curation: nothing is wrong with the
   * track, so a flag would put an item on the worklist no curator can action.
   */
  test('"I don’t like it" files no curation flag', async ({ page }) => {
    await openNeedsReview(page);
    const before = await page.getByTestId('flag-source-listener').count();

    await openReportDialog(page);

    const feedback = page.waitForResponse(
      (r) => r.url().includes('/api/recommendations/feedback') && r.request().method() === 'POST',
    );
    await page.getByTestId('report-reason-not_for_me').click();
    await page.getByTestId('report-submit').click();
    await feedback;

    // Scoped to a delta, not an absolute count: the specs share one server, so
    // a flag another test filed would otherwise read as this one's.
    await openNeedsReview(page);
    await expect(page.getByTestId('flag-source-listener')).toHaveCount(before);
  });
});
