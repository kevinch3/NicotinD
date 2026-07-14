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

  test('vocal mute toggle preserves playback position (client-side Web Audio filter)', async ({
    page,
  }) => {
    // Vocal removal is now client-side via Web Audio API: the <audio> element's
    // src and currentTime are never touched on toggle, so position is
    // structurally preserved (no reload, no seek). The setup seeds lyrics
    // on the first track so the karaoke overlay renders.
    await startAlbum(page);

    // Open the Now Playing sheet so the karaoke overlay can be reached.
    await page.getByTestId('player-title').click();
    await expect(page.getByText('Now Playing')).toBeVisible();

    // Seek to ~8s into the 30s fixture track. With the client-side filter
    // there is no reload, so the position is stable; we just need a
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

    // Position should not have reset — the client-side filter swap is
    // inaudible. Allow a small advance for the audio continuing to play.
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
