import {
  test,
  expect,
  FIXTURE,
  KARAOKE_FIXTURE_LYRICS,
  openAlbumCard,
  type Page,
} from '../helpers';

/**
 * #1751: a saved track keeps its lyrics, so the Lyrics tab and karaoke work
 * with no network. The preserve stores the song's stored row in the `lyrics`
 * store; offline, LyricsService reads it instead of the server.
 */

/** The lyrics rows in the real preserve database, by track id. */
const readLyrics = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Record<string, string | null>>((resolve, reject) => {
        const req = indexedDB.open('nicotind-preserve');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('lyrics')) {
            db.close();
            resolve({});
            return;
          }
          const rows = db.transaction('lyrics', 'readonly').objectStore('lyrics').getAll();
          rows.onsuccess = () => {
            db.close();
            const out: Record<string, string | null> = {};
            for (const r of rows.result as Array<{ id: string; dto: { plain: string | null } }>) {
              out[r.id] = r.dto.plain;
            }
            resolve(out);
          };
        };
      }),
  );

async function setOffline(page: Page, offline: boolean): Promise<void> {
  await page.context().setOffline(offline);
  // The DOM event is not reliably delivered under load (offline.spec.ts).
  await page.evaluate((t) => window.dispatchEvent(new Event(t)), offline ? 'offline' : 'online');
}

test('a saved track shows its lyrics and karaoke offline (#1751)', async ({ page }) => {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  const total = await page.getByTestId('track-row').count();

  await page.getByRole('button', { name: 'Download album' }).click();
  await expect(page.getByRole('button', { name: 'Downloaded — remove offline' })).toBeVisible({
    timeout: 30_000,
  });
  // Only the first track carries lyrics in the fixture; the rest store none.
  await expect
    .poll(async () => Object.values(await readLyrics(page)))
    .toEqual([KARAOKE_FIXTURE_LYRICS]);
  expect(total).toBeGreaterThan(1);

  await setOffline(page, true);
  await page.getByTestId('play-album').click();
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();
  await page.getByTestId('now-playing-tab-lyrics').click();
  const panel = page.getByTestId('now-playing-lyrics');
  await expect(panel).toContainText('karaoke warmup line');

  await page.getByTestId('now-playing-karaoke-toggle').click();
  await expect(page.getByTestId('karaoke-overlay')).toContainText('second warmup line');
  await setOffline(page, false);
});
