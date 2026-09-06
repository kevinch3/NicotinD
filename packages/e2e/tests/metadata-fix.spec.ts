import { test, expect } from '@playwright/test';
import { FIXTURE, openAlbumCard } from '../helpers';

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
  await openAlbumCard(page, FIXTURE.album.title);

  await page.getByTestId('optimize-metadata').click();
  await expect(page.getByTestId('metadata-fix-modal')).toBeVisible();

  // The cover section is always present (it offers at least the current cover);
  // Lidarr alternatives are absent here because the e2e server has a dead Lidarr.
  await expect(page.getByTestId('cover-picker')).toBeVisible();
  await expect(page.getByTestId('cover-option').first()).toBeVisible();
});

test('admin fixes album metadata via free-text and it re-buckets', async ({ page }) => {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);

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

/**
 * Song-scoped retag (issue #724). The write itself is covered by the API's own
 * tests and the component spec; what only e2e can prove is that the drawer
 * actually renders the form against the real API's Song — that it opens
 * prefilled rather than blank, and offers nothing to save until something
 * changed. Deliberately read-only: saving would rewrite a git-tracked fixture's
 * tags, and every other spec reads those.
 */
test('the track-info drawer opens a prefilled tag editor for a curator', async ({ page }) => {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);

  const row = page.getByTestId('track-row').first();
  await expect(row).toBeVisible();
  // Read the title off the row rather than hardcoding it: the two tests above
  // rename this album's artist and restore it, and the file is shared.
  const rowTitle = ((await row.getByTestId('track-row-title').textContent()) ?? '').trim();
  expect(rowTitle).not.toBe('');

  await row.getByTestId('track-row-menu-toggle').click();
  await row.getByTestId('track-action-Song info').click();

  const section = page.getByTestId('tags-section');
  await expect(section).toBeVisible();
  await section.getByTestId('edit-tags-button').click();

  await expect(section.getByTestId('tag-input-title')).toHaveValue(rowTitle);
  await expect(section.getByTestId('tag-input-album')).toHaveValue(FIXTURE.album.title);
  // Nothing edited yet, so there is nothing to write.
  await expect(section.getByTestId('save-tags-button')).toBeDisabled();

  await section.getByTestId('cancel-tags-button').click();
  await expect(section.getByTestId('tag-input-title')).toHaveCount(0);
});
