/**
 * Modal reachability on a phone (#1522). On an iPhone the identity and genre
 * modals rendered their title + close button under the sticky app header, and
 * Save sat at the end of one long scroll. The old geometry e2e asserted
 * `panel.y >= 0`, which held while the header covered the panel — so this one
 * hit-tests instead: the element painted at the button's centre must BE the
 * button, without scrolling anything.
 */
import { test, expect, type Locator, type Page } from '../helpers';
import { ADMIN, FIXTURE, bearer, openAlbumCard } from '../helpers';

// iPhone SE: short enough that the identity modal's body overflows once the
// mini-player and tab bar take their share — the case a pinned footer is for.
const PHONE = { width: 375, height: 667 };

/** True when `locator`'s centre point hits the element itself (nothing on top). */
async function isTopmostAtCentre(page: Page, locator: Locator): Promise<boolean> {
  const box = (await locator.boundingBox())!;
  const handle = await locator.elementHandle();
  return page.evaluate(
    ([el, x, y]) => {
      const hit = document.elementFromPoint(x as number, y as number);
      return hit !== null && (el as Element).contains(hit);
    },
    [handle, box.x + box.width / 2, box.y + box.height / 2] as const,
  );
}

test.describe('modal header and footer stay reachable on a phone', () => {
  test.use({ viewport: PHONE });

  test('identity modal: close and Save are on screen and tappable with a track playing', async ({
    page,
    request,
  }) => {
    const login = await request.post('/api/auth/login', { data: ADMIN });
    const { token } = (await login.json()) as { token: string };
    const artists = (await (
      await request.get('/api/library/artists', { headers: bearer(token) })
    ).json()) as Array<{ id: string; name: string }>;
    const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;

    // Start playback so the mini-player + tab bar chrome is present.
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title')).toBeVisible();

    await page.goto(`/library/artists/${artist.id}`);
    await page.getByTestId('artist-identity-fix').click();
    // The tallest state: the member editor open under the four choices.
    await page.getByTestId('identity-mode-split').check();
    await page.getByTestId('identity-add-member').click();
    await page.getByTestId('identity-add-member').click();

    const panel = page.getByTestId('artist-identity-panel');
    const header = (await page.getByTestId('app-header').boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.y, 'panel starts below the sticky header').toBeGreaterThanOrEqual(
      header.y + header.height - 1,
    );

    // The body is what scrolls — otherwise this test proves nothing about pinning.
    const body = page.getByTestId('artist-identity-body');
    const overflows = await body.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(overflows, 'the body overflows at this viewport').toBe(true);

    const close = page.getByTestId('artist-identity-close');
    const save = page.getByTestId('identity-save');
    expect(await isTopmostAtCentre(page, close), 'close button is not covered').toBe(true);
    expect(await isTopmostAtCentre(page, save), 'Save is not covered').toBe(true);

    await close.click();
    await expect(page.getByTestId('artist-identity-modal')).toHaveCount(0);
  });
});
