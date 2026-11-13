/**
 * Artist page "Popular" block (docs/popularity.md "Artist page: Popular") — the
 * real DOM against the real API.
 *
 * No fixture carries a ListenBrainz score, so local plays are the only signal
 * here. Plays are seeded through the API, as listening-stats.spec.ts does: a
 * counted play needs 15 s of real playback and the counting rule has unit
 * coverage. Other specs play the fixture album too, so the order is asserted
 * against the endpoint's own answer rather than against the counts seeded here.
 */
import { test, expect, FIXTURE, bearer, type APIRequestContext } from '../helpers';

type Artist = { id: string; name: string };
type Song = { id: string; title: string };

async function topSongs(
  request: APIRequestContext,
  auth: Record<string, string>,
  artistId: string,
): Promise<Song[]> {
  const res = await request.get(`/api/library/artists/${artistId}/top-songs`, { headers: auth });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Song[];
}

test('shows no block for an artist nothing ranks, and the played songs for one that is', async ({
  page,
  request,
}) => {
  await page.goto('/library');
  const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
  expect(token).toBeTruthy();
  const auth = bearer(token!);

  const artists = (await (
    await request.get('/api/library/artists', { headers: auth })
  ).json()) as Artist[];

  // An artist with neither a score nor a play: the block must not exist.
  let unranked: Artist | undefined;
  for (const a of artists) {
    if (a.name !== FIXTURE.album.artist && (await topSongs(request, auth, a.id)).length === 0) {
      unranked = a;
      break;
    }
  }
  expect(unranked, 'the fixture library must hold an artist nothing ranks').toBeTruthy();
  const emptyAnswer = page.waitForResponse(
    (r) => r.url().includes(`/artists/${unranked!.id}/top-songs`) && r.ok(),
  );
  await page.goto(`/library/artists/${unranked!.id}`);
  await emptyAnswer;
  await expect(page.getByTestId('artist-album-count')).toBeVisible();
  await expect(page.getByTestId('artist-top-songs')).toHaveCount(0);

  // Two counted plays for the fixture artist rank at least two songs.
  const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
  const songs = (
    (await (
      await request.get('/api/search?q=' + encodeURIComponent(FIXTURE.album.title), {
        headers: auth,
      })
    ).json()) as { local: { songs: Song[] } }
  ).local.songs;
  expect(songs.length).toBeGreaterThan(1);
  const now = Date.now();
  const events = [songs[0], songs[0], songs[1]].map((song, n) => ({
    clientEventId: `e2e-popular-${now}-${n}`,
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
  expect(post.ok()).toBe(true);

  const expected = await topSongs(request, auth, artist.id);
  expect(expected.length).toBeGreaterThanOrEqual(2);
  expect(expected.length).toBeLessThanOrEqual(5);
  expect(expected.map((s) => s.id)).toEqual(expect.arrayContaining([songs[0].id, songs[1].id]));

  await page.goto(`/library/artists/${artist.id}`);
  const block = page.getByTestId('artist-top-songs');
  await expect(block).toBeVisible();
  await expect(block.getByTestId('track-row-title')).toHaveCount(expected.length);
  for (const [i, song] of expected.entries()) {
    await expect(block.getByTestId('track-row-title').nth(i)).toContainText(song.title);
  }
});
