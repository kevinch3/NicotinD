import { test, expect, expandGroup, type Page } from '../helpers';

/**
 * #2076: "Delete N auto-saved tracks" removed them one at a time, and each
 * removal re-read every row to decide whether its cover was still shared —
 * quadratic, plus one database open per track. With 1927 auto-saved tracks on
 * a phone it never finished. One transaction now.
 */

const AUTO = 1500;
const ALBUMS = 50;

const seed = (page: Page) =>
  page.evaluate(
    async ({ auto, albums }) => {
      const db = await new Promise<IDBDatabase>((ok, ko) => {
        const q = indexedDB.open('nicotind-preserve');
        q.onsuccess = () => ok(q.result);
        q.onerror = () => ko(q.error);
      });
      const tx = db.transaction(['tracks', 'blobs', 'covers'], 'readwrite');
      const cover = new Blob([new Uint8Array(500)], { type: 'image/png' });
      const row = (id: string, a: number, source: 'user' | 'auto') => {
        tx.objectStore('tracks').put({
          id,
          title: id,
          artist: 'A',
          album: `Album ${a}`,
          coverArt: `al${a}`,
          albumId: `al${a}`,
          coverRev: 0,
          size: 500,
          format: 'audio/flac',
          preservedAt: 1,
          lastAccessedAt: 1,
          source,
          toppedUp: 1,
        });
        tx.objectStore('blobs').put({ id, audio: new Blob([new Uint8Array(500)]), cover: null });
      };
      for (let a = 0; a < albums; a++) {
        tx.objectStore('covers').put({
          key: `album:al${a}`,
          cover,
          coverArt: `al${a}`,
          coverRev: 0,
        });
      }
      for (let i = 0; i < auto; i++) row(`auto${i}`, i % albums, 'auto');
      // The person's own save shares album 0's cover with auto-saved tracks.
      row('mine', 0, 'user');
      await new Promise<void>((ok, ko) => {
        tx.oncomplete = () => ok();
        tx.onerror = () => ko(tx.error);
      });
      db.close();
    },
    { auto: AUTO, albums: ALBUMS },
  );

const readStore = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ tracks: string[]; blobs: number; covers: string[] }>((resolve, reject) => {
        const req = indexedDB.open('nicotind-preserve');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['tracks', 'blobs', 'covers'], 'readonly');
          const tracks = tx.objectStore('tracks').getAllKeys();
          const blobs = tx.objectStore('blobs').count();
          const covers = tx.objectStore('covers').getAllKeys();
          tx.oncomplete = () => {
            db.close();
            resolve({
              tracks: tracks.result as string[],
              blobs: blobs.result,
              covers: covers.result as string[],
            });
          };
        };
      }),
  );

test('clearing 1500 auto-saved tracks finishes, and keeps the person’s own save and its cover', async ({
  page,
}) => {
  // The defect is one database open (and one full-table read) per track; a
  // desktop CPU hides the time, so count the opens rather than the seconds.
  await page.addInitScript(() => {
    const w = window as unknown as { __idbOpens: number };
    w.__idbOpens = 0;
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
      w.__idbOpens++;
      return open(...args);
    };
  });
  await page.goto('/settings');
  await expect(page.getByTestId('desktop-nav')).toBeAttached();
  await seed(page);
  await page.reload();
  await expandGroup(page, 'settings-playback');

  const clear = page.getByTestId('auto-preserve-clear');
  await expect(clear).toContainText(String(AUTO));
  await clear.click();
  await page.evaluate(() => ((window as unknown as { __idbOpens: number }).__idbOpens = 0));
  await page.getByTestId('confirm-ok').click();

  await expect
    .poll(async () => (await readStore(page)).tracks, { timeout: 10_000 })
    .toEqual(['mine']);
  const store = await readStore(page);
  expect(store.blobs).toBe(1);
  expect(store.covers).toEqual(['album:al0']);
  await expect(clear).toHaveCount(0);
  const opens = await page.evaluate(() => (window as unknown as { __idbOpens: number }).__idbOpens);
  expect(opens).toBeLessThan(50);
});
