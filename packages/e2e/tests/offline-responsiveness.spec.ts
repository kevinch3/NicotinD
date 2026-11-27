import { test, expect, type Page } from '../helpers';

/**
 * #2072: going offline mid-session froze the iOS PWA. The mosaic home swapped
 * to one tile per saved track, and `packMosaic` is ~quadratic in tiles: 600
 * saves blocked the main thread for 4.6 s on a desktop CPU, 1200 for 25.8 s.
 * This seeds a realistic preserve store and times the longest main-thread gap
 * across the offline flip.
 */

const TRACKS = 600;
const ALBUMS = 60;
/** Measured ~100 ms after the fix and 4.6 s before it; generous for CI load. */
const MAX_BLOCK_MS = 1500;

/** Writes `TRACKS` rows (tiny blobs) and `ALBUMS` covers into the app's store. */
const seedPreserveStore = (page: Page) =>
  page.evaluate(
    async ({ tracks, albums }) => {
      const db = await new Promise<IDBDatabase>((ok, ko) => {
        const q = indexedDB.open('nicotind-preserve');
        q.onsuccess = () => ok(q.result);
        q.onerror = () => ko(q.error);
      });
      const tx = db.transaction(['tracks', 'blobs', 'covers'], 'readwrite');
      const cover = new Blob([new Uint8Array(2_000)], { type: 'image/png' });
      const now = Date.now();
      for (let a = 0; a < albums; a++) {
        tx.objectStore('covers').put({
          key: `album:al${a}`,
          cover,
          coverArt: `al${a}`,
          coverRev: 0,
        });
      }
      for (let i = 0; i < tracks; i++) {
        const a = i % albums;
        tx.objectStore('tracks').put({
          id: `seed${i}`,
          title: `Seeded ${i}`,
          artist: `Artist ${a}`,
          album: `Album ${a}`,
          coverArt: `al${a}`,
          albumId: `al${a}`,
          coverRev: 0,
          size: 1_000,
          format: 'audio/flac',
          preservedAt: now - i,
          lastAccessedAt: now - i,
          source: i % 3 ? 'auto' : 'user',
          toppedUp: 1,
        });
        tx.objectStore('blobs').put({
          id: `seed${i}`,
          audio: new Blob([new Uint8Array(1_000)]),
          cover: null,
        });
      }
      await new Promise<void>((ok, ko) => {
        tx.oncomplete = () => ok();
        tx.onerror = () => ko(tx.error);
      });
      db.close();
    },
    { tracks: TRACKS, albums: ALBUMS },
  );

test('going offline with hundreds of saved tracks never blocks the main thread (#2072)', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __maxGap: number };
    w.__maxGap = 0;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      w.__maxGap = Math.max(w.__maxGap, now - last);
      last = now;
    }, 50);
  });

  // Boot once so PreserveService creates the store, then fill it and reload so
  // the app reads the full set the way a phone with a big offline library does.
  await page.goto('/');
  await expect(page.getByTestId('mosaic-home')).toBeVisible();
  await seedPreserveStore(page);
  await page.reload();
  await expect(page.getByTestId('mosaic-home')).toBeVisible();
  await page.waitForTimeout(2_000);
  await page.evaluate(() => ((window as unknown as { __maxGap: number }).__maxGap = 0));

  await page.context().setOffline(true);
  // The DOM event is not reliably delivered under load (offline.spec.ts).
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  // Long enough for the offline load, the repack and the frames after it.
  await page.waitForTimeout(3_000);

  const maxGap = await page.evaluate(() => (window as unknown as { __maxGap: number }).__maxGap);
  expect(maxGap).toBeLessThan(MAX_BLOCK_MS);
  await page.context().setOffline(false);
});
