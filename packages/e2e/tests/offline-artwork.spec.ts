import { test, expect, FIXTURE, openAlbumCard, type Page } from '../helpers';

/**
 * #1658: preserved artwork shows offline. Before, the preserve flow stored a
 * 600px cover per track and nothing read it back — offline every cover was the
 * gradient placeholder. Now one cover per album lives in the `covers` store
 * (owner decision) and is served as an object URL while the device is offline;
 * it goes only with the album's last preserved track.
 */

/** Rows and covers in the real preserve database. */
const readStore = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ tracks: number; covers: string[]; perTrackCovers: number }>(
        (resolve, reject) => {
          const req = indexedDB.open('nicotind-preserve');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['tracks', 'blobs', 'covers'], 'readonly');
            const tracks = tx.objectStore('tracks').count();
            const covers = tx.objectStore('covers').getAllKeys();
            const blobs = tx.objectStore('blobs').getAll();
            tx.oncomplete = () => {
              db.close();
              resolve({
                tracks: tracks.result,
                covers: (covers.result as string[]).slice().sort(),
                perTrackCovers: (blobs.result as Array<{ cover: Blob | null }>).filter(
                  (b) => b.cover,
                ).length,
              });
            };
          };
        },
      ),
  );

async function setOffline(page: Page, offline: boolean): Promise<void> {
  await page.context().setOffline(offline);
  // The DOM event is not reliably delivered under load (offline.spec.ts).
  await page.evaluate((t) => window.dispatchEvent(new Event(t)), offline ? 'offline' : 'online');
}

test.describe('offline artwork (#1658)', () => {
  test('a saved album keeps one cover, shown offline, until its last track goes', async ({
    page,
  }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const rows = page.getByTestId('track-row');
    const total = await rows.count();
    expect(total).toBeGreaterThan(1);

    await page.getByRole('button', { name: 'Download album' }).click();
    await expect(page.getByRole('button', { name: 'Downloaded — remove offline' })).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(async () => (await readStore(page)).tracks).toBe(total);
    let store = await readStore(page);
    // One cover for the album, none kept per track.
    expect(store.covers).toHaveLength(1);
    expect(store.covers[0]).toMatch(/^album:/);
    expect(store.perTrackCovers).toBe(0);

    // Offline, the album cover is the preserved copy, not a dead network URL.
    await setOffline(page, true);
    const img = page.getByTestId('album-cover').locator('img').first();
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await setOffline(page, false);
    await expect(img).toHaveAttribute('src', /\/api\/cover\//);

    // Removing one track keeps the album's cover; removing the album drops it.
    const first = rows.first();
    await first.getByTestId('track-row-menu-toggle').click();
    await page.getByTestId('track-action-Remove download').click();
    await expect.poll(async () => (await readStore(page)).tracks).toBe(total - 1);
    expect((await readStore(page)).covers).toHaveLength(1);

    // With one track gone the album is no longer fully saved (its button offers
    // Download again), so the rest go one row at a time.
    for (let i = 1; i < total; i++) {
      await rows.nth(i).getByTestId('track-row-menu-toggle').click();
      await page.getByTestId('track-action-Remove download').click();
      await expect.poll(async () => (await readStore(page)).tracks).toBe(total - 1 - i);
      if (i < total - 1) expect((await readStore(page)).covers).toHaveLength(1);
    }
    store = await readStore(page);
    expect(store.covers).toHaveLength(0);
  });

  test('a v3 store moves its per-track covers to one per album on upgrade', async ({ page }) => {
    // A same-origin page that does not boot the app, so the v3 schema is ours to write.
    await page.goto('/manifest.webmanifest');
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const del = indexedDB.deleteDatabase('nicotind-preserve');
          del.onerror = () => reject(del.error);
          del.onsuccess = () => {
            const req = indexedDB.open('nicotind-preserve', 3);
            req.onupgradeneeded = () => {
              req.result.createObjectStore('tracks', { keyPath: 'id' });
              req.result.createObjectStore('blobs', { keyPath: 'id' });
            };
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction(['tracks', 'blobs'], 'readwrite');
              const base = { artist: 'A', album: 'Al', size: 1, format: 'flac', source: 'user' };
              tx.objectStore('tracks').put({
                ...base,
                id: 't1',
                title: '1',
                coverArt: 'al1',
                albumId: 'al1',
                preservedAt: 1,
                lastAccessedAt: 1,
              });
              tx.objectStore('tracks').put({
                ...base,
                id: 't2',
                title: '2',
                coverArt: 'al1',
                albumId: 'al1',
                preservedAt: 2,
                lastAccessedAt: 2,
              });
              tx.objectStore('tracks').put({
                ...base,
                id: 't3',
                title: '3',
                coverArt: 'al2',
                albumId: 'al2',
                preservedAt: 3,
                lastAccessedAt: 3,
              });
              for (const id of ['t1', 't2', 't3']) {
                tx.objectStore('blobs').put({ id, audio: new Blob(['a']), cover: new Blob([id]) });
              }
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
            };
          };
        }),
    );

    // Booting the app opens the store at v4, which runs the migration.
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();
    await expect
      .poll(async () => (await readStore(page)).covers)
      .toEqual(['album:al1', 'album:al2']);
    const store = await readStore(page);
    expect(store.tracks).toBe(3);
    expect(store.perTrackCovers).toBe(0);
  });
});
