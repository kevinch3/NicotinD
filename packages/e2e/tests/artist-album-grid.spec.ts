/**
 * One album grid per artist tab (docs/web-ui.md).
 *
 * The e2e server has no Lidarr, so `GET /api/discography/artists/:id` fails and the
 * merge runs with an empty discography. That is the case worth an e2e: it is what
 * every install without Lidarr sees, and a merge bug would blank the grid entirely
 * rather than fall back to the library. The three-state tile itself is covered by
 * album-tile.component.spec.ts, which can drive the states this environment cannot
 * produce.
 */
import { test, expect, type APIRequestContext, type Page } from '../helpers';
import { ADMIN, FIXTURE, bearer } from '../helpers';

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

test.describe('artist album grid', () => {
  test('falls back to the library when no discography is available', async ({ page, request }) => {
    const jwt = await token(request);
    const artists = (await (
      await request.get('/api/library/artists', { headers: bearer(jwt) })
    ).json()) as Array<{ id: string; name: string }>;
    const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
    expect(artist, 'fixture artist must exist').toBeTruthy();

    await page.goto(`/library/artists/${artist.id}`);

    // The grid renders the album we own, as a navigable tile.
    const tiles = page.getByTestId('album-tile');
    await expect(tiles.first()).toBeVisible();
    const owned = tiles.first();
    await expect(owned).toHaveAttribute('data-status', 'owned');

    // Nothing was reported missing, so nothing offers to acquire and the toggle
    // that reveals the non-studio tail has nothing to reveal.
    await expect(page.getByTestId('album-tile-action')).toHaveCount(0);
    await expect(page.getByTestId('toggle-all-releases')).toHaveCount(0);

    // No discography loaded means no summary line — and, crucially, no second grid.
    await expect(page.getByTestId('discography-summary')).toHaveCount(0);
    await expect(page.getByText('Full Discography')).toHaveCount(0);

    // The tile is a real link into the album page, not a decorative cell.
    await owned.click();
    await expect(page).toHaveURL(/\/library\/albums\//);
  });

  // #1627: the header and the tile read one completeness rule. The discography and
  // the job feed are stubbed (there is no release to hunt here, docs/e2e.md), so
  // the server half is covered by discography.service.test.ts.
  test.describe('one completeness rule (#1627)', () => {
    async function fixtureAlbum(request: APIRequestContext) {
      const jwt = await token(request);
      const artists = (await (
        await request.get('/api/library/artists', { headers: bearer(jwt) })
      ).json()) as Array<{ id: string; name: string }>;
      const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
      const detail = (await (
        await request.get(`/api/library/artists/${artist.id}`, { headers: bearer(jwt) })
      ).json()) as { albums: Array<{ id: string; name: string }> };
      const album = detail.albums.find((a) => a.name === FIXTURE.album.title)!;
      expect(album, 'fixture album must exist').toBeTruthy();
      return { artist, album };
    }

    /** The release as the server grades it: a local folder holding none of its tracklist. */
    const release = (localAlbumId: string, landed: boolean) => ({
      lidarrId: 1627,
      foreignAlbumId: 'mb-1627',
      title: FIXTURE.album.title,
      releaseDate: '2020-01-01',
      albumType: 'Album',
      secondaryTypes: [],
      totalTracks: 14,
      localTrackCount: landed ? 14 : 0,
      status: landed ? 'present' : 'missing',
      localAlbumId,
      tracks: [],
    });

    async function stubDiscography(
      page: Page,
      artistId: string,
      albumId: string,
      landed: () => boolean,
    ): Promise<{ reads: number }> {
      const counter = { reads: 0 };
      await page.route(`**/api/discography/artists/${artistId}`, (route) => {
        counter.reads++;
        return route.fulfill({
          json: { artistId, lidarrId: 9, mbid: 'mb', albums: [release(albumId, landed())] },
        });
      });
      return counter;
    }

    test('a folder holding none of its tracklist is missing in the header and on its tile', async ({
      page,
      request,
    }) => {
      const { artist, album } = await fixtureAlbum(request);
      await stubDiscography(page, artist.id, album.id, () => false);

      await page.goto(`/library/artists/${artist.id}`);

      await expect(page.getByTestId('discography-summary')).toContainText(
        '0 complete · 0 partial · 1 missing',
      );
      const tile = page.getByTestId('album-tile').filter({ hasText: FIXTURE.album.title });
      await expect(tile).toHaveAttribute('data-status', 'missing');
      // The old tile said "Complete album" here — a partial the header never counted.
      await expect(tile.getByTestId('album-tile-action')).toHaveText('Get album');
      // Still a link: the folder's songs are the user's.
      await tile.getByText(FIXTURE.album.title).click();
      await expect(page).toHaveURL(new RegExp(`/library/albums/${album.id}`));
    });

    test('a tile re-reads its status when its job lands', async ({ page, request }) => {
      const { artist, album } = await fixtureAlbum(request);
      let landed = false;
      const discography = await stubDiscography(page, artist.id, album.id, () => landed);
      const job = (done: boolean) => ({
        id: 'e2e-1627',
        kind: 'album-hunt',
        method: 'fixture-addon',
        state: done ? 'done' : 'active',
        stage: done ? 'done' : 'downloading',
        artistName: artist.name,
        albumTitle: FIXTURE.album.title,
        displayTitle: null,
        lidarrAlbumId: 1627,
        albumId: album.id,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        error: null,
        progress: {
          expected: 14,
          delivered: done ? 14 : 3,
          unavailable: 0,
          failed: 0,
          canonical: 14,
        },
        items: [],
        sources: [],
        destinationAlbums: [],
      });
      await page.route('**/api/downloads/jobs', (route) => route.fulfill({ json: [job(landed)] }));

      await page.goto(`/library/artists/${artist.id}`);
      const tile = page.getByTestId('album-tile').filter({ hasText: FIXTURE.album.title });
      await expect(tile.getByTestId('album-tile-hunt-status')).toHaveText(/^Downloading/, {
        timeout: 15_000,
      });
      const readsBefore = discography.reads;

      // The job lands; the next feed read (what `job.changed` triggers) says done.
      landed = true;
      await expect(tile).toHaveAttribute('data-status', 'owned', { timeout: 30_000 });
      await expect(tile.getByTestId('album-tile-action')).toHaveCount(0);
      await expect(page.getByTestId('discography-summary')).toContainText(
        '1 complete · 0 partial · 0 missing',
      );
      expect(discography.reads).toBeGreaterThan(readsBefore);
    });
  });
});
