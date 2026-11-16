import { test, expect } from '../helpers';
import { FIXTURE, preserveMusicFixture, openAlbumCard } from '../helpers';

/**
 * The unified `⋯` song row menu (SongMenuService.build) on an album detail
 * page: common actions, album-page-specific suppression of "Go to album",
 * the Song info sheet, and the admin remove-from-library flow (global
 * ConfirmHost → deleteSongs → deletedSongIds filtering).
 */
test.describe('song row menu', () => {
  // The remove-from-library test below deletes this fixture from the run's music
  // dir; later specs in the run still expect it. See preserveMusicFixture.
  const quietHours = preserveMusicFixture('E2E_Test_Artist/E2E_Test_Album/04 - Quiet_Hours.flac');

  // #2011: the row's menu is one menu, however it is opened.
  test('right-click on a row opens the same items as its ⋯ menu, at the pointer', async ({
    page,
  }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const row = page.getByTestId('track-row').first();
    await expect(row).toBeVisible();

    await row.getByTestId('track-row-menu-toggle').click();
    const fromToggle = await row
      .locator('[data-testid^="track-action-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(13)));
    expect(fromToggle.length).toBeGreaterThan(5);
    await page.keyboard.press('Escape');
    await expect(row.getByTestId('track-row-menu')).toBeHidden();

    const box = (await row.boundingBox())!;
    const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    await page.mouse.click(at.x, at.y, { button: 'right' });
    const menu = page.getByTestId('entity-menu');
    await expect(menu).toBeVisible();
    const fromRightClick = await menu
      .locator('[data-testid^="entity-action-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(14)));
    expect(fromRightClick).toEqual(fromToggle);
    // Opened where the pointer was, not anchored to the ⋯ button at the row's end.
    const menuBox = (await menu.boundingBox())!;
    expect(Math.abs(menuBox.x - at.x)).toBeLessThan(24);
    // And it did not play the row.
    await expect(row).not.toHaveAttribute('data-playback-state', 'playing');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test("the keyboard menu key opens the focused row's menu", async ({ page }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const row = page.getByTestId('track-row').first();
    await row.getByTestId('track-row-menu-toggle').focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByTestId('entity-menu')).toBeVisible();
    await expect(page.getByTestId('entity-action-Add to queue')).toBeVisible();
  });

  test('shows the common actions and hides "Go to album" on an album page', async ({ page }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);

    const row = page.getByTestId('track-row').first();
    await expect(row).toBeVisible();
    await row.getByTestId('track-row-menu-toggle').click();

    const menu = row.getByTestId('track-row-menu');
    await expect(menu).toBeVisible();

    for (const label of [
      'Add to queue',
      'Play next',
      'Start radio',
      'Go to artist',
      'Add to playlist',
      'Save offline',
      'Song info',
      'Report this track',
    ]) {
      await expect(row.getByTestId(`track-action-${label}`)).toBeVisible();
    }

    // Album detail passes { hideGoToAlbum: true } — redundant on the page you're
    // already viewing.
    await expect(row.getByTestId('track-action-Go to album')).toHaveCount(0);
  });

  test('"Song info" opens the track-info sheet', async ({ page }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);

    const row = page.getByTestId('track-row').first();
    await row.getByTestId('track-row-menu-toggle').click();
    await row.getByTestId('track-action-Song info').click();

    await expect(page.getByTestId('track-info-sheet')).toBeVisible();
    await expect(page.getByTestId('track-info-identity')).toBeVisible();
  });

  test('admin "Remove from library" confirms via the global ConfirmHost and removes the row', async ({
    page,
    request,
  }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);

    const rows = page.getByTestId('track-row');
    // `count()` is an instant snapshot with no auto-retry, so reading it straight
    // after navigation races the tracklist render and intermittently returns 0.
    // Wait on a retrying assertion first.
    await expect(rows.first()).toBeVisible();
    const countBefore = await rows.count();
    expect(countBefore).toBeGreaterThan(0);

    // Pick a middle track ("Quiet Hours") rather than the first/last row: other
    // specs assert the bookend tracks ("Opening Static"/"Closing Time") and one
    // asserts on "Second Wind" — deleting this one keeps the fixture album intact
    // enough for any spec that happens to run later in the shared server session.
    const removedTitle = 'Quiet Hours';
    const row = rows.filter({ hasText: removedTitle });
    await expect(row).toHaveCount(1);
    await row.getByTestId('track-row-menu-toggle').click();
    // Remove lives in the Curate submenu (#2017).
    await row.getByTestId('track-action-Curate').click();
    await page.getByTestId('menu-flyout').getByTestId('track-action-Remove from library').click();

    // Scoped to the global ConfirmHost overlay — the legacy per-page
    // app-confirm-dialog also exposes a confirm-ok testid, so anchor on the
    // overlay-unique confirm-dialog testid and assert exactly one match.
    const dialog = page.locator('[data-testid="confirm-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCount(1);
    await expect(dialog.getByText(removedTitle, { exact: false })).toBeVisible();

    await dialog.getByTestId('confirm-ok').click();

    await expect(dialog).toHaveCount(0);
    await expect(rows).toHaveCount(countBefore - 1);
    await expect(page.getByText(removedTitle, { exact: true })).toHaveCount(0);

    // The put-back later specs rely on (#1713): the delete left a 6-track album,
    // which the curator calls an EP, so it is off the Albums grid until the
    // restored file is scanned. Through the grid card, as the next spec opens it.
    await quietHours.restore(request);
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await expect(rows).toHaveCount(countBefore);
  });

  // #2017: a curator reaches the tag editor in two taps, not several scrolls.
  test('Curate ▸ Edit tags opens Song info with the tag editor open', async ({ page }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const row = page.getByTestId('track-row').first();
    await row.getByTestId('track-row-menu-toggle').click();
    await row.getByTestId('track-action-Curate').click();
    const flyout = page.getByTestId('menu-flyout');
    await expect(flyout.getByTestId('track-action-Set genre')).toBeVisible();
    await flyout.getByTestId('track-action-Edit tags').click();

    const sheet = page.getByTestId('track-info-sheet');
    await expect(sheet).toBeVisible();
    // The editor is open: its Edit button is gone and the section is on screen.
    await expect(sheet.getByTestId('edit-tags-button')).toHaveCount(0);
    await expect(sheet.getByTestId('tags-section')).toBeInViewport();
    await expect(sheet.getByTestId('tags-section').locator('input').first()).toBeVisible();
  });
});
