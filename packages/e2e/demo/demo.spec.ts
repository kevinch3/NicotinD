/**
 * Smoke run of a built static demo (docs/demo-mode.md), served the way GitHub
 * Pages serves it and with no backend. `playwright.demo.config.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { loadManifest } from './manifest.js';

const manifest = loadManifest();
const libraryAlbum = manifest.albums.find((a) => !a.heldBack)!;
const heldBack = manifest.albums.find((a) => a.heldBack)!;

/** Fails the test on any request that leaves the static site. */
function guardNetwork(page: Page): string[] {
  const escaped: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/NicotinD/'))
      escaped.push(req.url());
  });
  return escaped;
}

test('lands signed in on Home with the demo banner', async ({ page }) => {
  const escaped = guardNetwork(page);
  await page.goto('./');
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await expect(page).not.toHaveURL(/login|setup/);
  await page.getByTestId('demo-credits-toggle').click();
  await expect(page.getByTestId('demo-credits')).toContainText(libraryAlbum.artist);
  expect(escaped).toEqual([]);
});

test('opens an album and plays it from the shipped audio', async ({ page }) => {
  const escaped = guardNetwork(page);
  const missingMedia: string[] = [];
  page.on('response', (res) => {
    if (res.url().includes('/demo-media/covers/') && res.status() >= 400)
      missingMedia.push(res.url());
  });
  await page.goto('library');
  await page.getByText(libraryAlbum.title, { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: libraryAlbum.title })).toBeVisible();
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('audio')?.currentTime ?? 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0.5);
  expect(missingMedia).toEqual([]);
  expect(escaped).toEqual([]);
});

test('a Get acquires a held-back album into the library', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('get');
  await page.getByTestId('search-input').fill(heldBack.artist);
  await page.getByTestId('search-submit').click();
  const card = page.getByRole('gridcell', {
    name: new RegExp(`^${heldBack.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
  });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId('catalog-album-cover').click();
  await expect
    .poll(
      async () => {
        await page.goto('library');
        return page.getByText(heldBack.title, { exact: true }).count();
      },
      { timeout: 150_000, intervals: [5_000] },
    )
    .toBeGreaterThan(0);
});

test('a deep link survives a reload through the Pages 404 page', async ({ page }) => {
  await page.goto('library');
  await page.reload();
  await expect(page).toHaveURL(/\/NicotinD\/demo\/library/);
  await expect(page.getByTestId('demo-banner')).toBeVisible();
});
