import { test, expect } from '@playwright/test';
import { FIXTURE, ADMIN, bearer } from '../helpers';

test.describe('playback', () => {
  test('streams audio when an album is played', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    // The player streams via GET /api/stream/:id?token= (range -> 206, or 200).
    const streamResponse = page.waitForResponse(
      (r) => r.url().includes('/api/stream/') && [200, 206].includes(r.status()),
      { timeout: 15_000 },
    );

    await page.getByTestId('play-album').click();
    const res = await streamResponse;
    expect([200, 206]).toContain(res.status());

    // A double-buffered <audio> element should load and begin advancing.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll('audio')).some(
              (a) => a.readyState >= 2 || a.currentTime > 0,
            ),
          ),
        { timeout: 10_000, intervals: [250, 500] },
      )
      .toBe(true);
  });

  test('track row acknowledges the click and settles into playing state', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    const firstRow = page.getByTestId('track-row').first();
    await firstRow.getByTestId('track-row-title').click();

    // Instant acknowledgment: the row carries a playback state right away
    // (buffering while bytes arrive on slow disks, or straight to playing).
    await expect(firstRow).toHaveAttribute('data-playback-state', /buffering|playing/, {
      timeout: 2_000,
    });

    // And settles to playing once audio actually starts.
    await expect(firstRow).toHaveAttribute('data-playback-state', 'playing', {
      timeout: 15_000,
    });
  });

  // Regression for the "track plays 1-2 s then advances" bug. With transcoding
  // forced on, a 30 s FLAC fixture must produce a 30 s playback — the seek
  // bar must NOT reach 100 % in the first few seconds, and the queue must
  // NOT advance to the next track before the audio has actually finished.
  test('force-transcoded track plays its full duration (no premature end)', async ({
    page,
    request,
  }) => {
    // Login as admin to flip the streaming setting.
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    const token = ((await login.json()) as { token: string }).token;
    const settingsRes = await request.put('/api/settings/streaming', {
      headers: bearer(token),
      data: {
        transcodeEnabled: true,
        forceTranscode: true,
        format: 'mp3',
        maxBitRate: 128,
      },
    });
    expect(settingsRes.ok(), 'admin should be able to enable force transcode').toBe(true);

    try {
      await page.goto('/library');
      await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
      await expect(page).toHaveURL(/\/library\/albums\//);

      const firstRow = page.getByTestId('track-row').first();
      await firstRow.getByTestId('track-row-title').click();

      // Wait for the browser to start advancing the active audio element.
      await expect(firstRow).toHaveAttribute('data-playback-state', 'playing', {
        timeout: 15_000,
      });

      // After 5 seconds of playback, the track must STILL be the same one and
      // the seek bar must NOT be at 100 %. (The bug was the track ending in
      // ~1-2 s and the queue advancing.)
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const audios = Array.from(document.querySelectorAll('audio'));
              const playing = audios.find((a) => !a.paused && a.currentTime > 0);
              return playing ? { currentTime: playing.currentTime, duration: playing.duration } : null;
            }),
          { timeout: 10_000, intervals: [500, 1000] },
        )
        .toMatchObject({ currentTime: expect.any(Number) });

      const snap = await page.evaluate(() => {
        const audios = Array.from(document.querySelectorAll('audio'));
        const playing = audios.find((a) => !a.paused && a.currentTime > 0);
        return playing
          ? { currentTime: playing.currentTime, duration: playing.duration }
          : null;
      });
      expect(snap).not.toBeNull();
      // 5+ s in, the browser-reported duration must be at least 25 s (the
      // fixture is 30 s). Anything less would be the false-short-duration
      // race that triggered the reported bug.
      expect(snap!.duration, 'browser-reported duration').toBeGreaterThan(25);
      expect(snap!.currentTime, 'playback advanced past 5 s').toBeGreaterThan(5);
    } finally {
      // Reset the admin setting so the rest of the suite is unaffected.
      await request.put('/api/settings/streaming', {
        headers: bearer(token),
        data: { transcodeEnabled: false, forceTranscode: false, format: 'mp3', maxBitRate: 192 },
      });
    }
  });
});
