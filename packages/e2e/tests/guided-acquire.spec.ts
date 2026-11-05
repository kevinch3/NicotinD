import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, ADMIN, bearer } from '../helpers';
import { E2E_MUSIC_DIR } from '../fixture-music';
import {
  FIXTURE_ADDON_TOKEN,
  RICK_ASTLEY_PAYLOAD,
  startFixtureAddon,
  type FixtureAddon,
} from './helpers/fixture-addon';
import { resetFixtureLidarr, seedFixtureLidarr, type SeedArtist } from './helpers/fixture-lidarr';

const ADDON_ID = 'fixture-guided-addon';
const ALBUM = 'Whenever You Need Somebody';
const LANDED_DIR = join(E2E_MUSIC_DIR, 'Rick Astley');

const RICK: SeedArtist = {
  id: 7,
  foreignArtistId: 'mb-rick-astley',
  artistName: 'Rick Astley',
  albums: [
    {
      id: 77,
      foreignAlbumId: 'rg-whenever',
      title: ALBUM,
      year: 1987,
      tracks: ['Never Gonna Give You Up'],
    },
  ],
};

/**
 * The guided acquire path with a real server behind every step (#1547): search,
 * catalog card, resolve (adding the artist to Lidarr), hunt, Get, Activity, library.
 * Nothing of NicotinD's own API is stubbed; Lidarr and the source are fixtures at the
 * HTTP seam. A prod walkthrough found bugs on this exact surface that no lane could
 * see (#1536, #1539, #1543).
 */
test.describe('guided acquire through the catalog', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;
  let landedAlbumId = '';

  test.beforeAll(async ({ request }) => {
    addon = await startFixtureAddon({ id: ADDON_ID, payload: RICK_ASTLEY_PAYLOAD });
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(login.ok()).toBeTruthy();
    auth = bearer(((await login.json()) as { token: string }).token);
    const registered = await request.post('/api/plugins/addons', {
      headers: auth,
      data: { url: addon.url, token: FIXTURE_ADDON_TOKEN },
    });
    expect(registered.status()).toBe(201);
    const enabled = await request.post(`/api/plugins/${ADDON_ID}/enable`, {
      headers: auth,
      data: { consent: true },
    });
    expect(enabled.ok()).toBeTruthy();
  });

  test.beforeEach(() => seedFixtureLidarr([RICK]));

  test.afterAll(async ({ request }) => {
    await resetFixtureLidarr();
    if (landedAlbumId) {
      await request
        .delete(`/api/library/albums/${landedAlbumId}`, { headers: auth })
        .catch(() => {});
    }
    rmSync(LANDED_DIR, { recursive: true, force: true });
    await request.delete(`/api/plugins/addons/${ADDON_ID}`, { headers: auth });
    await addon.close();
  });

  const jobsNamed = async (
    request: import('@playwright/test').APIRequestContext,
    albumTitle: string,
  ) => {
    const res = await request.get('/api/downloads/jobs', { headers: auth });
    if (!res.ok()) return [];
    const jobs = (await res.json()) as Array<{
      id: string;
      method: string;
      albumTitle: string | null;
      stage: string;
      albumId: string | null;
    }>;
    // By addon too: an earlier spec's finished job can carry the same album title.
    return jobs.filter((j) => j.method === ADDON_ID && j.albumTitle === albumTitle);
  };

  test('search, a card with a real cover, Get, Activity, and into the library', async ({
    page,
    request,
  }) => {
    await page.goto('/get?tab=add');
    await page.getByTestId('search-input').fill('Rick Astley');
    await page.getByTestId('search-submit').click();

    const card = page.getByTestId('catalog-album').filter({ hasText: ALBUM });
    await expect(card).toBeVisible({ timeout: 15_000 });

    // #1536: every catalog cover 401ed, and only a browser decoding it can tell.
    const cover = card.getByTestId('catalog-album-cover').locator('img');
    await expect
      .poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 15_000 })
      .toBeGreaterThan(0);

    // The artist is not in Lidarr yet, so this also runs the real 202 add job.
    await card.click();

    // The hunt scores a 100% match, and the countdown toast Gets it by itself.
    await expect
      .poll(async () => (await jobsNamed(request, ALBUM)).length, { timeout: 30_000 })
      .toBe(1);

    await page.goto('/get?tab=activity');
    const feed = page.getByTestId('downloads-active');
    await expect(feed).toContainText(ALBUM, { timeout: 15_000 });

    addon.completeJobs();
    await expect
      .poll(
        async () => {
          const [job] = await jobsNamed(request, ALBUM);
          if (job?.albumId) landedAlbumId = job.albumId;
          return job?.stage ?? '';
        },
        { timeout: 30_000 },
      )
      .toBe('done');

    const detail = await request.get(`/api/library/albums/${landedAlbumId}`, { headers: auth });
    expect(detail.status()).toBe(200);
    expect(((await detail.json()) as { artist: string }).artist).toBe('Rick Astley');
  });

  test('a compilation Lidarr cannot resolve falls back to the raw network search', async ({
    page,
  }) => {
    const title = 'The Best Of Rick Astley';
    await seedFixtureLidarr([
      {
        ...RICK,
        albums: [{ id: 79, foreignAlbumId: 'rg-best-of', title, tracks: [], lookupOnly: true }],
      },
    ]);
    await page.goto('/get?tab=add');
    await page.getByTestId('search-input').fill('Rick Astley');
    await page.getByTestId('search-submit').click();
    await page.getByTestId('catalog-album').filter({ hasText: title }).click();
    await expect(page.getByTestId('raw-fallback-note')).toBeVisible({ timeout: 30_000 });
  });

  test('a folder grab and the catalog card for one album make one job (#1539)', async ({
    request,
  }) => {
    const title = 'Hold Me In Your Arms';
    await seedFixtureLidarr([
      {
        ...RICK,
        provisioned: true,
        albums: [
          {
            id: 78,
            foreignAlbumId: 'rg-hold-me',
            title,
            year: 1988,
            tracks: ['She Wants To Dance With Me'],
          },
        ],
      },
    ]);

    const grab = await request.post('/api/downloads', {
      headers: auth,
      data: {
        username: 'peer',
        album: { artist: 'Rick Astley', title },
        files: [{ filename: `Music\\Rick Astley - ${title}\\01 She Wants.flac`, size: 1 }],
      },
    });
    expect(grab.status()).toBe(201);

    const hunted = await request.post('/api/discography/albums/78/hunt-download', {
      headers: auth,
      data: {
        artistName: 'Rick Astley',
        albumTitle: title,
        selected: {
          username: 'other-peer',
          directory: `Other\\${title}`,
          files: [{ filename: `Other\\${title}\\01 She Wants.flac`, size: 1 }],
        },
        alternates: [],
      },
    });
    expect(hunted.status()).toBe(409);
    expect(((await hunted.json()) as { error: string }).error).toBe('already-downloading');
    expect(await jobsNamed(request, title)).toHaveLength(1);

    addon.completeJobs();
  });
});
