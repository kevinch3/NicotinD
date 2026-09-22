import { test, expect } from '../helpers';
import { FIXTURE } from '../helpers';

/**
 * A song radio is about the song it started from (#1277). It used to hand the
 * server whatever was playing as the seed, so after the first fill every
 * top-up was one hop from its predecessor — a walk — and the Now Playing
 * heading renamed the session after every track.
 *
 * Two things are pinned here, on the real server and the real player:
 *   1. every `/api/radio/next` of the session carries the original `seedId`;
 *   2. what it serves stays in the seed's genre, and the heading keeps the seed.
 *
 * The queue is held at depth 5 for the spec: at the default 20 a single fill
 * swallows the whole fixture library and no top-up ever fires. The player reads
 * the depth once per page load, so it is set before the page that plays.
 */
test.describe('song radio stays about its seed (#1277)', () => {
  test('every top-up carries the original seed, stays in its genre, and the heading keeps it', async ({
    page,
    request,
  }) => {
    await page.goto('/library');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    const before = (await (await request.get('/api/settings/radio', { headers: auth })).json()) as {
      queueTarget?: number;
    };
    const shallow = await request.put('/api/settings/radio', {
      headers: auth,
      data: { queueTarget: 5 },
    });
    expect(shallow.ok()).toBeTruthy();

    const alpha = FIXTURE.genres.alpha.genre;
    const seedTitle = `${alpha} 1-1`;
    const fetches: Array<{ seedId: string | null; genres: Array<string | undefined> }> = [];
    page.on('response', (res) => {
      if (!res.url().includes('/api/radio/next') || !res.ok()) return;
      void res.json().then((body: { songs: Array<{ genre?: string }> } | Array<{ genre?: string }>) => {
        const songs = Array.isArray(body) ? body : body.songs;
        fetches.push({
          seedId: new URL(res.url()).searchParams.get('seedId'),
          genres: songs.map((s) => s.genre),
        });
      });
    });

    try {
      const search = await request.get('/api/search?q=' + encodeURIComponent(seedTitle), {
        headers: auth,
      });
      const hit = (
        (await search.json()) as {
          local: { songs: Array<{ id: string; title: string; albumId?: string }> };
        }
      ).local.songs.find((s) => s.title === seedTitle);
      expect(hit?.albumId, 'the seed fixture is indexed with its album').toBeTruthy();

      // A two-track release is not in the Albums grid (it classifies below
      // `album`), so open its detail page directly.
      await page.goto(`/library/albums/${hit!.albumId}`);
      const firstRow = page.getByTestId('track-row').first();
      await expect(firstRow).toContainText(seedTitle);
      await firstRow.getByTestId('track-row-menu-toggle').click();
      await page.getByTestId('track-action-Start radio').click();
      await expect.poll(() => fetches.length).toBeGreaterThan(0);

      // Three tracks on: each advance is one top-up, and the seed never moves.
      for (let i = 0; i < 3; i++) {
        const seen = fetches.length;
        await page.getByTestId('player-next').click();
        await expect.poll(() => fetches.length).toBeGreaterThan(seen);
      }
      await expect(page.getByTestId('player-title')).not.toHaveText(seedTitle);

      expect(fetches.length).toBeGreaterThanOrEqual(4);
      for (const f of fetches) expect(f.seedId).toBe(hit!.id);
      const served = fetches.flatMap((f) => f.genres);
      expect(served.length).toBeGreaterThanOrEqual(7);
      expect(served.every((g) => g === alpha)).toBe(true);

      // The heading names the seed, three tracks later.
      await page.getByTestId('player-title').click();
      await expect(page.getByTestId('now-playing-heading')).toContainText(seedTitle);
    } finally {
      // Workers run one at a time, but a leaked depth changes every later radio spec.
      await request.put('/api/settings/radio', {
        headers: auth,
        data: { queueTarget: before.queueTarget ?? 20 },
      });
    }
  });
});
