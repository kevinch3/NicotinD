import { test, expect } from '../helpers';
import { E2E_MUSIC_DIR } from '../fixture-music';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, bearer, openAlbumMetadataFix, scanAndWait, waitForLibrary } from '../helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The uniquely tagged one-track album `library-live.spec.ts` also plants (workers: 1, so the two
 *  never overlap). A cover upload writes into the album's folder, so it must never be a
 *  git-tracked fixture album, whose cover every screenshot spec would then show. */
const PLANT_DIR = join(E2E_MUSIC_DIR, 'Live Probe Artist');
const PLANTED = join(PLANT_DIR, 'Live Probe Album', '01 - Live Probe Song.flac');
const SOURCE = join(HERE, '../fixtures/plant/live-probe.flac');
const PLANT_ALBUM = 'Live Probe Album';

/**
 * #1666: `/api/cover/<id>` is cached by URL for a day, so a replaced album cover must move the
 * URL on every surface. The album page's upload answers the new cover rev; the hero re-keys to
 * `v=<rev>` at once, keeps it across a reload (the rev is on the DTO, not a page-local counter),
 * and the player bar — built from the album's tracks — carries it too.
 */
test.describe('album cover revision', () => {
  test.afterAll(async ({ request }) => {
    rmSync(PLANT_DIR, { recursive: true, force: true });
    // Prune the planted row so later specs see the fixture library as shipped.
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    if (login.ok()) {
      const { token } = (await login.json()) as { token: string };
      await scanAndWait(request, token).catch(() => {});
    }
  });

  test('an uploaded album cover moves the hero and player-bar URLs, and a reload keeps it', async ({
    page,
    request,
  }) => {
    await page.goto('/library');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    expect(token).toBeTruthy();
    await waitForLibrary(request, token!);
    if (!existsSync(PLANTED)) {
      mkdirSync(dirname(PLANTED), { recursive: true });
      copyFileSync(SOURCE, PLANTED);
    }
    await scanAndWait(request, token!);

    const search = await request.get(
      '/api/library/songs?size=200&q=' + encodeURIComponent(PLANT_ALBUM),
      { headers: bearer(token!) },
    );
    expect(search.ok()).toBeTruthy();
    const found = ((await search.json()) as Array<{ albumId?: string; album?: string }>).find(
      (s) => s.album === PLANT_ALBUM && s.albumId,
    );
    expect(found?.albumId).toBeTruthy();
    const albumId = found!.albumId!;

    await page.goto(`/library/albums/${albumId}`);
    await expect(page.getByTestId('play-album')).toBeVisible();
    // The hero is the page's one 300px cover; a held previous image is not it.
    const hero = page.locator(
      'img:not([data-testid="cover-art-held"])[src*="/api/cover/"][src*="size=300"]',
    );

    await openAlbumMetadataFix(page);
    await expect(page.getByTestId('cover-picker')).toBeVisible();
    const uploaded = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/library/albums/${albumId}/cover`) && r.request().method() === 'PUT',
    );
    await page.getByTestId('cover-upload-file').setInputFiles({
      name: 'cover.png',
      mimeType: 'image/png',
      buffer: Buffer.from(ONE_PX_PNG, 'base64'),
    });
    const res = await uploaded;
    expect(res.ok(), 'cover upload should succeed').toBe(true);
    const { coverRev } = (await res.json()) as { coverRev: number };
    expect(coverRev).toBeGreaterThan(0);
    const versioned = new RegExp(`[?&]v=${coverRev}&`);

    await expect(hero).toHaveAttribute('src', versioned);

    await page.reload();
    await expect(page.getByTestId('play-album')).toBeVisible();
    await expect(hero).toHaveAttribute('src', versioned);

    await page.getByTestId('play-album').click();
    await expect(
      page.locator('[data-testid="player-cover-art"] img:not([data-testid="cover-art-held"])'),
    ).toHaveAttribute('src', versioned);
  });
});

/** A valid 1x1 PNG, enough for the upload route and the cover resizer. */
const ONE_PX_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
