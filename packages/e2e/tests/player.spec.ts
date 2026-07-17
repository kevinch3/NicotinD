import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../helpers';

/** Max currentTime across the (double-buffered) audio elements. */
const audioTime = (page: Page) =>
  page.evaluate(() =>
    Math.max(0, ...Array.from(document.querySelectorAll('audio')).map((a) => a.currentTime)),
  );

const anyAudioPaused = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('audio'))
      .filter((a) => a.src)
      .every((a) => a.paused),
  );

/** Start the fixture album and wait until a track is loaded into the player. */
async function startAlbum(page: Page): Promise<void> {
  await page.goto('/library');
  await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
  await expect(page).toHaveURL(/\/library\/albums\//);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  // Wait for the audio to actually begin advancing before exercising controls.
  await expect.poll(() => audioTime(page), { timeout: 10_000 }).toBeGreaterThan(0);
}

test.describe('auto-preserve queue (PWA lock-screen resilience)', () => {
  /** Reset the IndexedDB nicotind-preserve database (awaits deletion). */
  const deletePreserveDb = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((res, rej) => {
          const req = indexedDB.deleteDatabase('nicotind-preserve');
          req.onsuccess = () => res();
          req.onerror = () => rej(req.error);
          req.onblocked = () => res();
        }),
    );

  /** Count `source === 'auto'` rows in IndexedDB — the user's intact offline
   *  collection stays put; only auto-source rows are counted. */
  const autoPreservedCount = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const req = indexedDB.open('nicotind-preserve');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('tracks')) {
              db.close();
              resolve(0);
              return;
            }
            const tx = db.transaction('tracks', 'readonly');
            const getAll = tx.objectStore('tracks').getAll();
            getAll.onsuccess = () => {
              const rows = (getAll.result as Array<{ source?: string }>) ?? [];
              db.close();
              resolve(rows.filter((r) => r.source === 'auto').length);
            };
            getAll.onerror = () => reject(getAll.error);
          };
        }),
    );

  test('Settings exposes the four auto-preserve modes and the explainer', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('auto-preserve-off')).toBeVisible();
    await expect(page.getByTestId('auto-preserve-5')).toBeVisible();
    await expect(page.getByTestId('auto-preserve-20')).toBeVisible();
    await expect(page.getByTestId('auto-preserve-full')).toBeVisible();
    await expect(page.getByTestId('auto-preserve-explain')).toBeVisible();
  });

  test('enabling "Next 5" auto-saves queued tracks; toggle-off confirms and clears', async ({
    page,
  }) => {
    // Reset both stores for a deterministic count.
    await page.goto('/');
    await deletePreserveDb(page);
    await page.evaluate(() => localStorage.removeItem('nicotind-auto-preserve'));
    await page.reload();

    // Enable auto-preserve on the next 5 tracks.
    await page.goto('/settings');
    await page.getByTestId('auto-preserve-5').click();
    await expect(page.getByTestId('auto-preserve-5')).toHaveAttribute('aria-pressed', 'true');

    // Play the album so the queue holds the 7 fixture tracks; the coordinator
    // keeps the current track + next 4 (cap = 5).
    await startAlbum(page);

    // Wait for the coordinator to save exactly 5 auto-source rows.
    await expect.poll(() => autoPreservedCount(page), { timeout: 30_000 }).toBe(5);

    // Toggle off — should prompt a confirm dialog with the count baked in.
    await page.goto('/settings');
    const dialog = page.getByTestId('confirm-dialog');
    await page.getByTestId('auto-preserve-off').click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('5 auto-saved track');

    await page.getByTestId('confirm-ok').click();

    // After confirm: auto-source rows are gone, mode persisted.
    await expect.poll(() => autoPreservedCount(page), { timeout: 5_000 }).toBe(0);
    await expect(page.getByTestId('auto-preserve-off')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('player controls', () => {
  test('pause and resume toggle playback', async ({ page }) => {
    await startAlbum(page);
    const btn = page.getByTestId('player-playpause');
    await expect(btn).toHaveAttribute('data-playing', 'true');

    await btn.click(); // pause
    await expect(btn).toHaveAttribute('data-playing', 'false');
    await expect.poll(() => anyAudioPaused(page)).toBe(true);

    await btn.click(); // resume
    await expect(btn).toHaveAttribute('data-playing', 'true');
    await expect.poll(() => anyAudioPaused(page)).toBe(false);
  });

  test('next advances to the following track', async ({ page }) => {
    await startAlbum(page);
    // Album track order is deterministic with shuffle off.
    await expect(page.getByTestId('player-title')).toHaveText('Opening Static');
    await page.getByTestId('player-next').click();
    await expect(page.getByTestId('player-title')).toHaveText('Second Wind');
  });

  test('seek jumps playback position', async ({ page }) => {
    await startAlbum(page);
    const bar = page.getByTestId('player-seek');
    const box = (await bar.boundingBox())!;
    // Click ~60% along the 30s track -> ~18s.
    await bar.click({ position: { x: box.width * 0.6, y: box.height / 2 } });
    await expect.poll(() => audioTime(page), { timeout: 5_000 }).toBeGreaterThan(10);
  });

  test('shuffle toggles on and off', async ({ page }) => {
    await startAlbum(page);
    const shuffle = page.getByTestId('player-shuffle');
    await expect(shuffle).toHaveAttribute('data-active', 'false');
    await shuffle.click();
    await expect(shuffle).toHaveAttribute('data-active', 'true');
    await shuffle.click();
    await expect(shuffle).toHaveAttribute('data-active', 'false');
  });

  test('reload leaves the player paused by default', async ({ page }) => {
    // The default `autoplay_on_load` user preference is false, so reloading the
    // page must restore the last track to the mini-player WITHOUT attempting to
    // play it. The browser would otherwise block the gesture-less play and
    // surface a "Tap to resume" banner over the mini-player (or, worse, autoplay
    // unexpectedly if Chrome had granted the Media Engagement exception).
    await startAlbum(page);
    // Sanity: audio is currently playing.
    await expect.poll(() => anyAudioPaused(page)).toBe(false);

    await page.reload();

    // The mini-player surfaces the restored track...
    await expect(page.getByTestId('player-title')).toBeVisible();
    // ...but the play/pause button reads paused and the audio element is paused.
    await expect(page.getByTestId('player-playpause')).toHaveAttribute('data-playing', 'false');
    await expect.poll(() => anyAudioPaused(page)).toBe(true);

    // And a manual press of play still resumes it (sanity check the wiring).
    await page.getByTestId('player-playpause').click();
    await expect(page.getByTestId('player-playpause')).toHaveAttribute('data-playing', 'true');
    await expect.poll(() => anyAudioPaused(page)).toBe(false);
  });

  test('vocal mute toggle preserves playback position (server-side transcode filter)', async ({
    page,
  }) => {
    // Vocal removal is server-side: ?vocals=off forces an ffmpeg center-channel
    // cancellation transcode, so the toggle DOES re-assign audio.src. Position is
    // preserved across that reload by `restoredTime` rather than by avoiding the
    // reload. The setup seeds lyrics on the first track so the overlay renders.
    await startAlbum(page);

    // Open the Now Playing sheet so the karaoke overlay can be reached.
    await page.getByTestId('player-title').click();
    await expect(page.getByText('Now Playing')).toBeVisible();

    // Seek to ~8s into the 30s fixture track. The toggle reloads the src, so
    // this is the position `restoredTime` must carry across; we just need a
    // starting point that's clearly past 0 for the assertion.
    await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('audio')).find(
        (el) => !el.paused && el.duration > 0,
      );
      if (a) a.currentTime = 8;
    });
    await expect.poll(() => audioTime(page), { timeout: 5_000 }).toBeGreaterThan(5);
    const posBefore = await audioTime(page);

    // Open the karaoke overlay: lyrics toggle → karaoke fullscreen.
    await page.getByTestId('now-playing-lyrics-toggle').click();
    await expect(page.getByTestId('now-playing-lyrics')).toBeVisible();
    await page.getByTestId('now-playing-karaoke-toggle').click();
    await expect(page.getByTestId('karaoke-overlay')).toBeVisible();

    // Toggle vocal mute on, then off. Both should be position-stable.
    const toggle = page.getByTestId('vocal-mute-toggle');
    await toggle.click();
    // The aria-label toggles between "Mute vocals" and "Unmute vocals".
    await expect(toggle).toHaveAttribute('aria-label', /Unmute vocals/);

    // Position should not have reset — restoredTime carries it across the src
    // reload. Allow a small advance for the audio continuing to play.
    await expect
      .poll(async () => {
        const t = await audioTime(page);
        return t >= posBefore - 1 && t < posBefore + 5;
      }, { timeout: 5_000 })
      .toBe(true);

    // Toggle off again — still no position reset.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', /Mute vocals/);
    await expect
      .poll(async () => {
        const t = await audioTime(page);
        return t >= posBefore - 1 && t < posBefore + 5;
      }, { timeout: 5_000 })
      .toBe(true);
  });
});
