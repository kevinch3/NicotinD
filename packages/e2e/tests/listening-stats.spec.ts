import { test, expect, type APIRequestContext } from '../helpers';
import { ADMIN, FIXTURE, bearer } from '../helpers';

type Auth = Record<string, string>;

async function songsMatching(request: APIRequestContext, auth: Auth, q: string) {
  const res = await request.get('/api/search?q=' + encodeURIComponent(q), { headers: auth });
  return ((await res.json()) as { local: { songs: Array<{ id: string; title: string }> } }).local
    .songs;
}

/** Same seed as artist-genre-about.spec.ts, so the specs agree whichever runs first. */
async function seedFixtureArtistGenres(request: APIRequestContext): Promise<void> {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  const jwt = ((await login.json()) as { token: string }).token;
  const artists = (await (
    await request.get('/api/library/artists', { headers: bearer(jwt) })
  ).json()) as Array<{ id: string; name: string }>;
  const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
  expect(artist, 'fixture artist must exist').toBeTruthy();
  const applied = await request.post(`/api/library/artists/${artist.id}/genre`, {
    headers: bearer(jwt),
    data: { genres: 'Folclore; Chacarera; Zamba', note: 'e2e artist-genre-about' },
  });
  expect(applied.ok()).toBe(true);
}

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

  test('genre shares add up to 100 and the top is not share-of-top (#1670)', async ({
    page,
    request,
  }) => {
    await seedFixtureArtistGenres(request);
    await page.goto('/library');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    const auth = { Authorization: `Bearer ${token}` };

    const albumSongs = await songsMatching(request, auth, FIXTURE.album.title);
    const single = (await songsMatching(request, auth, FIXTURE.single.title))[0];
    expect(albumSongs.length).toBeGreaterThan(1);
    expect(single, 'untagged single fixture').toBeTruthy();

    const now = Date.now();
    const events = [albumSongs[0], albumSongs[1], single].map((song, n) => ({
      clientEventId: `e2e-genre-share-${now}-${n}`,
      songId: song.id,
      startedAt: now - (n + 1) * 60_000,
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

    await page.goto('/library');
    await page.getByTestId('library-tabs').getByRole('button', { name: 'Stats' }).click();
    await page.getByTestId('stats-period').filter({ hasText: 'All time' }).click();

    const section = page.getByTestId('stats-top-genres');
    await expect(section.getByTestId('genre-share-bar')).toBeVisible();
    const rows = section.getByTestId('stats-genre-row');
    await expect(rows.first()).toBeVisible();

    const read = await rows.evaluateAll((els) =>
      els.map((el) => ({
        genre: (el.getAttribute('data-genre') ?? '').toLowerCase(),
        percent: Number(el.getAttribute('data-percent')),
      })),
    );
    expect(read.reduce((sum, r) => sum + r.percent, 0)).toBe(100);
    // Secondary genres are not shares: each play counts once, under Folclore.
    expect(read.map((r) => r.genre)).not.toContain('chacarera');
    expect(read.map((r) => r.genre)).not.toContain('zamba');
    const folclore = read.find((r) => r.genre === 'folclore');
    expect(folclore, 'the primary genre has a row').toBeTruthy();
    expect(folclore!.percent).toBeLessThan(100);
    expect(read.some((r) => r.genre === 'untagged')).toBe(true);

    // The overlapping count is its own mode, and it carries no percentages.
    await section.locator('[data-testid="stats-genre-mode"][data-mode="all"]').click();
    await expect(section.getByTestId('stats-genre-all-row').first()).toBeVisible();
    await expect(
      section.getByTestId('stats-genre-all-row').filter({ hasText: 'Zamba' }),
    ).toHaveCount(1);
    await expect(section).not.toContainText('%');
  });
});
