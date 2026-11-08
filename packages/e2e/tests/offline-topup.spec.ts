import { test, expect, FIXTURE, ADMIN, bearer, type Page } from '../helpers';

/**
 * #1751 part 3: rows preserved before a preserve stored everything (no credits,
 * genre, cover or lyrics) are completed once, the next time the app is online.
 * The row is planted the way an older build left it, then the app boots.
 */

type Row = { id: string; toppedUp?: number; artists?: unknown[]; genre?: string; albumId?: string };

const readStore = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ rows: Row[]; covers: string[]; lyrics: string[] }>((resolve, reject) => {
        const req = indexedDB.open('nicotind-preserve');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['tracks', 'covers', 'lyrics'], 'readonly');
          const rows = tx.objectStore('tracks').getAll();
          const covers = tx.objectStore('covers').getAllKeys();
          const lyrics = tx.objectStore('lyrics').getAllKeys();
          tx.oncomplete = () => {
            db.close();
            resolve({
              rows: rows.result as Row[],
              covers: covers.result as string[],
              lyrics: lyrics.result as string[],
            });
          };
        };
      }),
  );

test('an older saved row is filled in once the app is online', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', {
    data: { username: ADMIN.username, password: ADMIN.password },
  });
  const { token } = (await login.json()) as { token: string };
  const albums = (await (
    await request.get('/api/library/albums', { headers: bearer(token) })
  ).json()) as Array<{ id: string; name: string }>;
  const album = albums.find((a) => a.name === FIXTURE.album.title)!;
  const detail = (await (
    await request.get(`/api/library/albums/${album.id}`, { headers: bearer(token) })
  ).json()) as { song: Array<{ id: string; title: string }> };
  // The first track carries the seeded lyrics (helpers.ts).
  const song = detail.song[0]!;

  // Boot once so the store exists at the current version, then plant the row
  // the way a pre-#1658 build saved it: title/artist/album only.
  await page.goto('/library');
  await page.evaluate(
    ({ id, title }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('nicotind-preserve');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['tracks', 'blobs'], 'readwrite');
          tx.objectStore('tracks').put({
            id,
            title,
            artist: 'E2E Test Artist',
            album: 'E2E Test Album',
            size: 1,
            format: 'audio/flac',
            preservedAt: 1,
            lastAccessedAt: 1,
            source: 'user',
          });
          tx.objectStore('blobs').put({ id, audio: new Blob([new Uint8Array(1)]), cover: null });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    song,
  );

  await page.reload();
  await expect
    .poll(async () => (await readStore(page)).rows.find((r) => r.id === song.id)?.toppedUp)
    .toBe(1);
  const store = await readStore(page);
  const row = store.rows.find((r) => r.id === song.id)!;
  expect(row.artists?.length, 'credits filled in').toBeGreaterThan(0);
  expect(row.albumId, 'album id filled in').toBe(album.id);
  expect(store.covers, 'the album cover was added').toEqual([`album:${album.id}`]);
  expect(store.lyrics, 'the stored lyrics were added').toEqual([song.id]);
});
