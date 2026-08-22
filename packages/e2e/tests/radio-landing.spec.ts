import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * The post-login landing (route '') is the radio/mood starter: a resume shortcut
 * for the last track plus one-tap vibe presets. The /acquire page (nav "Acquire",
 * formerly /search) is reachable from the desktop top-nav and mobile bottom-nav.
 * Acquisition stays default-off in e2e.
 */
test.describe('radio landing', () => {
  test('renders vibe presets', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    await expect(page.getByTestId('radio-preset').first()).toBeVisible();
  });

  test('resume-from-last-track appears after playback and disappears on tap', async ({ page }) => {
    // Play a fixture track so the player carries a "last track".
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('track-row').first()).toHaveAttribute(
      'data-playback-state',
      /buffering|playing/,
      { timeout: 15_000 },
    );

    // Land on the radio landing: the resume shortcut is offered.
    await page.goto('/');
    const resume = page.getByTestId('radio-resume');
    await expect(resume).toBeVisible();

    // Tapping it starts radio and the block disappears.
    await page.getByTestId('radio-resume-play').click();
    await expect(resume).toHaveCount(0);
  });

  // The "Keep the vibe" shelf is asserted at the API lane, not in the DOM: the
  // shelf seeds itself from the shared user's recently-played list, which every
  // spec's playback grows — a visibility assertion would silently depend on
  // suite ordering (the recently-played empty-state note has the same
  // reasoning). Rendering is pinned in keep-vibe.component.spec.ts.
  test('keep the vibe: list-seeded radio recommends variations, never the seeds', async ({
    page,
    request,
  }) => {
    // Grab this session's token — the Playwright `request` fixture is
    // unauthenticated, and /api/radio is behind the JWT middleware.
    await page.goto('/');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    // Two known library songs stand in for the recently-played seed list.
    const search = await request.get('/api/search?q=' + encodeURIComponent(FIXTURE.album.title), {
      headers: auth,
    });
    expect(search.ok()).toBeTruthy();
    const songs = ((await search.json()) as { local: { songs: Array<{ id: string }> } }).local
      .songs;
    expect(songs.length).toBeGreaterThanOrEqual(2);
    const seedIds = [songs[0].id, songs[1].id];

    const res = await request.get(`/api/radio/next?seedIds=${seedIds.join(',')}&count=5`, {
      headers: auth,
    });
    expect(res.ok()).toBeTruthy();
    const recs = (await res.json()) as Array<{ id: string }>;
    // The fixture library holds 10 songs, so excluding the 2 seeds still
    // leaves candidates — a variation must exist and must not be a seed.
    expect(recs.length).toBeGreaterThan(0);
    for (const seedId of seedIds) {
      expect(recs.map((r) => r.id)).not.toContain(seedId);
    }
  });
});
