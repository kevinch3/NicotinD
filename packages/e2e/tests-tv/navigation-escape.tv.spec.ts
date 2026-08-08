/**
 * Can focus get out of a content region, and can the viewer always get home?
 *
 * This file used to assert that focus could escape a track list **downward into
 * the player chrome** — issue #436, where `TvNavGroupDirective` clamps at a
 * group edge and `preventDefault()`s unconditionally, suppressing the WebView's
 * spatial-navigation escape.
 *
 * The TV surface redesign (docs/tv-ux.md) removed the premise rather than the
 * clamp: there is no mini-player below the content any more, because the player
 * is its own route. So "escape downward into the chrome" is no longer a thing a
 * viewer needs to do, and asserting it would test something that does not exist.
 *
 * What still matters — and is what these tests now check — is that no screen is
 * a dead end: from anywhere in a content region, a viewer can always reach
 * another surface. On TV that is Back, which is the guaranteed exit.
 *
 * #436 itself is therefore **moot on the TV tree, not fixed**. It remains open
 * for any surface that still nests a bottom-most nav group under other chrome.
 */
import { test, expect, goto, startPlayback } from '../tv/fixtures.js';

test.describe('escape from a content region', () => {
  test('Back leaves the album tracklist and returns to browse', async ({ page, dpad, focusId }) => {
    await goto(page, '/library');
    await page.getByTestId('tv-album-card').first().click();
    await expect(page.getByTestId('tv-album')).toBeVisible();

    // Walk into the tracklist — the region that used to be a trap.
    const firstRow = page.getByTestId('tv-track-row').first();
    await firstRow.waitFor({ state: 'visible' });
    await firstRow.focus();
    await dpad('DOWN', 3);
    expect(await focusId()).toContain('tv-track-row');

    await dpad('BACK');
    await expect(page.getByTestId('tv-browse')).toBeVisible();
  });

  test('Back returns to Home from browse', async ({ page, dpad }) => {
    await goto(page, '/library');
    await expect(page.getByTestId('tv-browse')).toBeVisible();
    await dpad('BACK');
    await expect(page.getByTestId('tv-home')).toBeVisible();
  });

  test('the player is reachable from Home and Back returns', async ({ page, dpad }) => {
    await startPlayback(page);
    await expect(page.getByTestId('tv-player')).toBeVisible();
    await dpad('BACK');
    await expect(page.getByTestId('tv-player')).toBeHidden();
  });
});
