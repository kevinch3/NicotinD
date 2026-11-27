import { test, expect, FIXTURE, openAlbumCard, type Page } from '../helpers';

/**
 * #2074: iOS can keep a closed installed PWA alive and audible. Reopening the
 * app starts a second instance beside it, and offline nothing reaches the
 * first one — the playback socket is down. The installed iOS app therefore
 * announces each launch on a `BroadcastChannel` and an older instance stands
 * down. Two pages of one context share storage and origin, exactly as two
 * instances of one installed app do.
 */

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const audioPlaying = (p: Page): Promise<boolean> =>
  p
    .evaluate(() =>
      Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 0),
    )
    .catch(() => false);

async function playAlbum(page: Page): Promise<void> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect.poll(() => audioPlaying(page), { timeout: 15_000 }).toBe(true);
}

test.describe('a reopened installed iOS app (#2074)', () => {
  test.use({ userAgent: IPHONE_UA, viewport: { width: 393, height: 852 }, hasTouch: true });

  test('silences the instance it replaces', async ({ page, context }) => {
    // What iOS reports for an app launched from the home screen.
    await context.addInitScript(() =>
      Object.defineProperty(navigator, 'standalone', { get: () => true }),
    );
    await playAlbum(page);

    const reopened = await context.newPage();
    await reopened.goto('/');
    await expect(reopened.getByTestId('mosaic-home')).toBeVisible();

    await expect.poll(() => audioPlaying(page)).toBe(false);
  });

  test('leaves a second browser tab alone', async ({ page, context }) => {
    await playAlbum(page);

    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByTestId('mosaic-home')).toBeVisible();
    await second.waitForTimeout(1_500);

    expect(await audioPlaying(page)).toBe(true);
  });
});

test('a track refused offline leaves the transport on Play, not Pause (#2074)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await playAlbum(page);
  const transport = page.locator('app-player-transport-mini');
  await expect(transport.getByRole('button', { name: 'Pause' })).toBeVisible();

  await page.context().setOffline(true);
  // The DOM event is not reliably delivered under load (offline.spec.ts).
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await transport.getByRole('button', { name: 'Next track' }).click();

  await expect(page.getByText("isn't available offline")).toBeVisible();
  await expect(transport.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.context().setOffline(false);
});
