import { test, expect } from '@playwright/test';
import { FIXTURE, openAlbumCard } from '../helpers';

/**
 * Listening history (docs/listening-history.md). Two halves, tested separately
 * because the counting rule makes an end-to-end pass impractical here: the
 * fixtures are 30s, so a *counted* play needs 15s of real playback. Waiting that
 * long in CI to prove a threshold that already has unit coverage would be a poor
 * trade.
 *
 * So: assert the client actually reports (the wiring that unit tests can't see,
 * since it lives in PlayerComponent's audio handlers), and assert the shelf
 * renders a play the API already knows about.
 */
test.describe('listening history', () => {
  test('playing then skipping a track reports a session to the server', async ({ page }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);

    const reported = page.waitForRequest(
      (r) => r.url().includes('/api/history/plays') && r.method() === 'POST',
      { timeout: 15_000 },
    );

    await page.getByTestId('play-album').click();
    // Skip — the deliberate-skip edge, and the fastest way to close a session.
    await page.getByTestId('player-next').click();

    const req = await reported;
    const body = req.postDataJSON() as {
      events: Array<{ songId: string; reason: string; msPlayed: number }>;
    };

    expect(body.events.length).toBeGreaterThan(0);
    const [event] = body.events;
    expect(event.songId).toBeTruthy();
    expect(event.reason).toBe('skipped');
    // Raw facts only — the counting verdict is the server's, never the client's.
    expect(event).not.toHaveProperty('counted');
  });

  test('the landing shelf shows a counted play', async ({ page, request }) => {
    // Grab this session's token: the Playwright `request` fixture is
    // unauthenticated, so the JWT has to come from the logged-in page. The goto
    // is required — localStorage is origin-scoped and throws on about:blank.
    await page.goto('/');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    // Find a real library song to attribute the play to — /recent joins the
    // live library, so an invented id would (correctly) never render.
    const search = await request.get('/api/search?q=' + encodeURIComponent(FIXTURE.album.title), {
      headers: auth,
    });
    expect(search.ok()).toBeTruthy();
    const song = (
      (await search.json()) as { local: { songs: Array<{ id: string; title: string }> } }
    ).local.songs[0];
    expect(song).toBeTruthy();

    // A session long past the threshold, so the server counts it.
    const post = await request.post('/api/history/plays', {
      headers: auth,
      data: {
        events: [
          {
            clientEventId: `e2e-${Date.now()}`,
            songId: song.id,
            startedAt: Date.now(),
            msPlayed: 250_000,
            durationMs: 300_000,
            reason: 'ended',
            source: 'album',
            device: 'browser',
            title: song.title,
            artist: FIXTURE.album.artist,
            album: FIXTURE.album.title,
          },
        ],
      },
    });
    expect(post.ok()).toBeTruthy();
    expect(await post.json()).toMatchObject({ inserted: 1 });

    await page.goto('/');
    const shelf = page.getByTestId('recently-played');
    await expect(shelf).toBeVisible({ timeout: 10_000 });
    await expect(
      shelf.getByTestId('recently-played-item').filter({ hasText: song.title }).first(),
    ).toBeVisible();
  });
});

// The empty state ("no history yet → the shelf hides entirely") is asserted in
// recently-played.component.spec.ts rather than here: every spec file shares one
// server and DB, so an absence assertion would silently depend on suite ordering.
