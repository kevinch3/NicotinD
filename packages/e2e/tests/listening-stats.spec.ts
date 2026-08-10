import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * Library "Stats" tab (docs/listening-history.md, phase 2). Seeds counted plays
 * through the API rather than by playing audio: fixtures are 30s, so a counted
 * play needs 15s of real playback, and the counting rule already has unit
 * coverage. What this asserts is the tab → fetch → render path.
 */
test.describe('listening stats', () => {
  test('the Stats tab renders totals, rankings and the clock', async ({ page, request }) => {
    // localStorage is origin-scoped, so navigate before reading the token.
    await page.goto('/library');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    const search = await request.get('/api/search?q=' + encodeURIComponent(FIXTURE.album.title), {
      headers: auth,
    });
    const songs = (
      (await search.json()) as { local: { songs: Array<{ id: string; title: string }> } }
    ).local.songs;
    expect(songs.length).toBeGreaterThan(0);

    // Two plays of the first track, one of the second — enough to rank.
    const now = Date.now();
    const events = [
      { song: songs[0], n: 1 },
      { song: songs[0], n: 2 },
      { song: songs[1] ?? songs[0], n: 3 },
    ].map(({ song, n }) => ({
      clientEventId: `e2e-stats-${now}-${n}`,
      songId: song.id,
      startedAt: now - n * 60_000,
      msPlayed: 250_000,
      durationMs: 300_000,
      reason: 'ended',
      source: 'album',
      device: 'browser',
      title: song.title,
      artist: FIXTURE.album.artist,
      album: FIXTURE.album.title,
    }));

    const post = await request.post('/api/history/plays', { headers: auth, data: { events } });
    expect(post.ok()).toBeTruthy();
    expect(await post.json()).toMatchObject({ inserted: 3 });

    await page.goto('/library');
    await page.getByTestId('library-tabs').getByRole('button', { name: 'Stats' }).click();

    const panel = page.getByTestId('library-stats');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('stats-totals')).toBeVisible();
    await expect(panel.getByTestId('stats-top-song').first()).toContainText(songs[0].title);
    await expect(panel.getByTestId('stats-top-artist').first()).toContainText(FIXTURE.album.artist);
    await expect(panel.getByTestId('stats-clock-bar')).toHaveCount(24);
  });

  test('switching period refetches without leaving the tab', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('library-tabs').getByRole('button', { name: 'Stats' }).click();

    const statsRequest = page.waitForRequest(
      (r) => r.url().includes('/api/history/stats') && r.url().includes('period=all'),
      { timeout: 10_000 },
    );
    await page.getByTestId('stats-period').filter({ hasText: 'All time' }).click();
    await statsRequest;

    await expect(page.getByTestId('library-stats')).toBeVisible();
  });
});
