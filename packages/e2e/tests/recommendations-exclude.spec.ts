import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * "Don't recommend this" holds a song out of every feed for the listener
 * (docs/radio.md "Per-user exclusions"): excluded via the API the song menu
 * calls, listed on Settings → Recommendations, absent from radio, and let back
 * in from that page.
 */
test.describe('per-user recommendation exclusions', () => {
  test('an excluded song leaves radio and comes back from Settings', async ({ page, request }) => {
    await page.goto('/settings');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    const search = await request.get('/api/search?q=' + encodeURIComponent(FIXTURE.album.title), {
      headers: auth,
    });
    expect(search.ok()).toBeTruthy();
    const songs = ((await search.json()) as { local: { songs: Array<{ id: string }> } }).local
      .songs;
    expect(songs.length).toBeGreaterThanOrEqual(2);
    const [seed, rejected] = [songs[0]!.id, songs[1]!.id];

    const vote = await request.post('/api/recommendations/feedback', {
      headers: auth,
      data: { songId: rejected, kind: 'exclude' },
    });
    expect(vote.status()).toBe(201);

    // Radio never serves it, however many times it is asked. The fixture
    // library is 10 songs, so a count of 20 would otherwise return everything.
    for (let i = 0; i < 3; i++) {
      const res = await request.get(`/api/radio/next?seedId=${seed}&count=20`, { headers: auth });
      expect(res.ok()).toBeTruthy();
      const ids = ((await res.json()) as Array<{ id: string }>).map((s) => s.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).not.toContain(rejected);
    }

    // Settings lists it, and the row's remove control is the undo.
    await page.goto('/settings/recommendations');
    const toggle = page.getByTestId('settings-group-toggle').first();
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const row = page.locator(
      `[data-testid="recommendations-excluded-row"][data-song-id="${rejected}"]`,
    );
    await expect(row).toBeVisible();
    await row.getByTitle('Remove').click();
    await expect(row).toHaveCount(0);

    const excluded = await request.get('/api/recommendations/excluded', { headers: auth });
    expect(((await excluded.json()) as { excluded: unknown[] }).excluded).toHaveLength(0);
  });
});
