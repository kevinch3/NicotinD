import { test, expect } from '@playwright/test';

const OUT = 'screenshots/mobile';
const QUERY = process.env.HUNT_QUERY ?? 'Zara Larsson';

/**
 * Mobile HUNT flow against a live backend (prod). Captures the search page
 * (multiple inputs), runs a catalog search, opens the album-hunt modal for the
 * first available album, screenshots it, and downloads the top candidate.
 * Records what it observed via console + screenshots for the UX report.
 */
test('mobile hunt flow', async ({ page }) => {
  test.setTimeout(240_000); // live Lidarr lookup + Soulseek hunt are slow

  // 1) Search page — capture the multiple inputs (search box, advanced network
  //    direct-search disclosure, optional URL-acquire box).
  await page.goto('/search');
  await expect(page.getByTestId('search-input')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/07-search-page.png`, fullPage: true });

  // 2) Catalog search for the artist.
  await page.getByTestId('search-input').fill(QUERY);
  await page.getByTestId('search-submit').click();

  // Wait for the catalog "Albums" section to render (live Lidarr/MusicBrainz).
  const albumsHeading = page.getByRole('heading', { name: 'Albums', exact: true });
  await albumsHeading.waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(800); // cover art settle
  await page.screenshot({ path: `${OUT}/08-search-results.png`, fullPage: true });

  // The album cards are the <button> elements in the grid following the heading.
  const cards = albumsHeading.locator('xpath=following-sibling::div//button');
  const count = await cards.count();
  console.log(`[hunt] catalog returned ${count} album card(s) for "${QUERY}"`);
  expect(count).toBeGreaterThan(0);

  // 3) Walk EVERY card. For each, the click either (a) opens the hunt modal, or
  //    (b) fails resolution with an inline red error banner. Detect which fast so
  //    we can find the first card that actually reaches a hunt dialog.
  const downloadBtn = page.getByTestId('hunt-download');
  const noResults = page.getByTestId('hunt-no-results');
  const searching = page.getByTestId('hunt-searching');
  const errorBanner = page.locator('p.text-red-400').first();
  const errors: string[] = [];
  let downloaded = false;
  let modalSeen = false;

  for (let i = 0; i < count && !downloaded; i++) {
    const card = cards.nth(i);
    const label = (await card.innerText()).replace(/\s+/g, ' ').trim();
    console.log(`[hunt] card #${i}: ${label}`);
    await card.click();

    // Race: modal opens vs resolve error banner vs nothing (12s).
    const outcome = await Promise.race([
      searching.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'modal' as const).catch(() => null),
      downloadBtn.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'modal' as const).catch(() => null),
      noResults.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'modal' as const).catch(() => null),
      errorBanner.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'error' as const).catch(() => null),
    ]);

    if (outcome === 'error') {
      const msg = (await errorBanner.innerText().catch(() => '')).trim();
      console.log(`[hunt]   -> resolve error: ${msg}`);
      errors.push(`#${i} "${label.split(' ').slice(0, 4).join(' ')}…": ${msg}`);
      await errorBanner.locator('xpath=following-sibling::button').click().catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }

    if (outcome !== 'modal') {
      console.log(`[hunt]   -> no modal, no error (timeout)`);
      continue;
    }

    // We reached a real hunt dialog — capture + drive it.
    modalSeen = true;
    console.log(`[hunt]   -> HUNT MODAL opened`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/09-hunt-dialog-searching.png`, fullPage: false });

    const settled = await Promise.race([
      downloadBtn.waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'download' as const).catch(() => 'timeout' as const),
      noResults.waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'none' as const).catch(() => 'timeout' as const),
    ]);
    console.log(`[hunt]   -> settled: ${settled}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/10-hunt-dialog-result.png`, fullPage: false });

    if (settled === 'download') {
      console.log(`[hunt]   -> DOWNLOADING top candidate for: ${label}`);
      await downloadBtn.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${OUT}/11-hunt-download-started.png`, fullPage: false });
      downloaded = true;
      break;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  console.log(`[hunt] ── summary ───────────────────────────`);
  console.log(`[hunt] cards tried: ${count}, hunt modal ever opened: ${modalSeen}, download initiated: ${downloaded}`);
  for (const e of errors) console.log(`[hunt] ${e}`);
});
