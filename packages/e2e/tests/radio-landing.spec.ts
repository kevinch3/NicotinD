import { test, expect } from '@playwright/test';
import { FIXTURE, openAlbumCard } from '../helpers';

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
    await openAlbumCard(page, FIXTURE.album.title);
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

  // The two tones are the whole point of the Start-a-radio block, and this is
  // the only layer that can assert them: the web unit harness never binds a
  // nested component's signal inputs, so <app-vibe-tile> renders its defaults
  // there (see radio-landing.component.spec.ts).
  test('vibe tiles are colored and 2x wide; genre tiles stay muted and narrow', async ({
    page,
  }) => {
    await page.goto('/');
    const preset = page.getByTestId('radio-preset').first().locator('button');
    await expect(preset).toBeVisible();
    await expect(preset).toHaveClass(/bg-gradient-to-br/);
    await expect(preset).toHaveClass(/text-white/);
    await expect(preset).toHaveClass(/w-40/);

    // The fixture library always has at least one genre, so the row renders.
    const genre = page.getByTestId('radio-genre').first().locator('button');
    await expect(genre).toBeVisible();
    await expect(genre).toHaveClass(/bg-theme-surface-2/);
    await expect(genre).not.toHaveClass(/bg-gradient-to-br/);

    // The wide tile really is wider on screen, not just in class names.
    const presetBox = await preset.boundingBox();
    const genreBox = await genre.boundingBox();
    expect(presetBox!.width).toBeGreaterThan(genreBox!.width * 1.5);
  });

  test('taste breakers shelf renders and a tap starts playback', async ({ page }) => {
    await page.goto('/');
    const shelf = page.getByTestId('taste-breakers');
    // Never order-dependent: the pick list demotes recent plays rather than
    // excluding them, so the shelf survives a suite that played every fixture
    // song (the 10-song library would otherwise be fully covered by the last
    // 20 plays and the shelf would vanish).
    await expect(shelf).toBeVisible({ timeout: 10_000 });
    expect(await shelf.getByTestId('taste-breakers-item').count()).toBeGreaterThan(0);

    await shelf.getByTestId('taste-breakers-item').first().click();
    await expect(page.getByTestId('player-title')).not.toHaveText('', { timeout: 15_000 });
  });

  test('tastemakers shelf appears after curated shelves exist and a tap starts playback', async ({
    page,
    request,
  }) => {
    // Materialize the auto-recipe shelves (admin "Generate now") — a fresh e2e
    // server has zero curated playlists, so the shelf is hidden until this
    // runs. Safe mid-suite: workers=1, and no spec asserts playlist counts.
    await page.goto('/');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    const refresh = await request.post('/api/admin/playlists/auto/refresh', { headers: auth });
    expect(refresh.ok()).toBeTruthy();
    const shelves = ((await refresh.json()) as { shelves: Array<{ slug: string; count: number }> })
      .shelves;
    // "Fresh this week" is `where: '1=1'`, so the fixture library always fills it.
    const fresh = shelves.find((s) => s.slug === 'fresh-this-week');
    expect(fresh?.count ?? 0).toBeGreaterThan(0);

    await page.goto('/');
    const shelf = page.getByTestId('tastemakers');
    await expect(shelf).toBeVisible({ timeout: 10_000 });
    expect(await shelf.getByTestId('tastemaker-item').count()).toBeGreaterThan(0);

    // On the 10-song fixture library every playlist member is also a seed, so
    // the list-radio variations come back empty and the tap exercises the
    // picks-only degradation path — assert playback starts, not queue length.
    await shelf.getByTestId('tastemaker-item').first().click();
    await expect(page.getByTestId('player-title')).not.toHaveText('', { timeout: 15_000 });
  });
});
