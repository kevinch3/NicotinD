import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * User-driven metadata fix — free-text fallback path. The e2e server runs with a
 * dead Lidarr (external mode), so the candidate search degrades; the manual
 * "Enter manually" path needs no Lidarr and must still let an admin correct an
 * album. We rename the artist (the "<Desconocido>" complaint) and assert the
 * corrected name surfaces — proving the override + canonical re-bucketing works
 * end-to-end through the real API. Title is left unchanged.
 *
 * The suite shares one mutable backend (workers:1), so afterEach restores the
 * fixture artist by API regardless of how the test ends — other specs assert the
 * original name (e.g. mobile-ux track-info).
 */
const NEW_ARTIST = 'E2E Renamed Artist';

test.afterEach(async ({ page }) => {
  const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
  if (!token) return;
  const headers = { Authorization: `Bearer ${token}` };
  const list = await page.request.get('/api/library/albums', { headers });
  if (!list.ok()) return;
  const albums = (await list.json()) as Array<{ id: string; name: string; artist: string }>;
  const album = albums.find(
    (a) => a.name === FIXTURE.album.title && a.artist !== FIXTURE.album.artist,
  );
  if (!album) return;
  await page.request.post(`/api/library/albums/${album.id}/metadata`, {
    headers,
    data: { artist: FIXTURE.album.artist, album: FIXTURE.album.title, source: 'manual' },
  });
});

test('the fix modal shows the cover picker with the current cover', async ({ page }) => {
  await page.goto('/library');
  const card = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/library\/albums\//);

  await page.getByTestId('optimize-metadata').click();
  await expect(page.getByTestId('metadata-fix-modal')).toBeVisible();

  // The cover section is always present (it offers at least the current cover);
  // Lidarr alternatives are absent here because the e2e server has a dead Lidarr.
  await expect(page.getByTestId('cover-picker')).toBeVisible();
  await expect(page.getByTestId('cover-option').first()).toBeVisible();
});

test('admin fixes album metadata via free-text and it re-buckets', async ({ page }) => {
  await page.goto('/library');
  const card = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/library\/albums\//);

  // Open the fix modal (admin-only "Fix metadata" button).
  await page.getByTestId('optimize-metadata').click();
  await expect(page.getByTestId('metadata-fix-modal')).toBeVisible();

  // Use the manual fallback (no Lidarr needed). Expand it and rename the artist.
  await page.getByText('Enter manually').click();
  const artistInput = page.getByTestId('manual-artist');
  await expect(artistInput).toBeVisible();
  await artistInput.fill(NEW_ARTIST);
  await page.getByTestId('apply-manual').click();

  // The corrected album lives under a new id (artist changed) → the view reloads
  // in place and the URL syncs; the new artist + unchanged title both show.
  await expect(page.getByText(NEW_ARTIST).first()).toBeVisible();
  await expect(page.getByText(FIXTURE.album.title, { exact: false }).first()).toBeVisible();
});
