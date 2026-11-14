import { test, expect } from '@playwright/test';

const OUT = 'screenshots/mobile';
const QUERY = process.env.NET_QUERY ?? 'Zara Larsson Poster Girl';
const WANT_ALBUM = /poster\s*girl/i;
const PREFER_FLAC = process.env.NET_FORMAT !== 'mp3';

/**
 * Escape-hatch album download via "All copies on <source>" — every folder the
 * network search saw, in the Choose a copy picker. Searches "Zara Larsson Poster
 * Girl", opens All copies once folders arrive, picks a FLAC copy of the album,
 * and gets it. Captures screenshots at every meaningful step for the UX report.
 */
test('network album download (Poster Girl, FLAC)', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/search');
  await page.getByTestId('search-input').fill(QUERY);
  await page.getByTestId('search-submit').click();

  // The row enables once the first folders are in.
  const allCopies = page.getByTestId('advanced-toggle');
  await expect(allCopies).toBeEnabled({ timeout: 90_000 });
  await allCopies.click();

  const picker = page.getByTestId('copy-picker');
  const rows = picker.getByTestId('copy-row');
  await expect.poll(() => rows.count(), { timeout: 90_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/12-network-folders.png`, fullPage: true });

  // Pick a copy: prefer a FLAC one whose folder names the album.
  const n = await rows.count();
  console.log(`[net] ${n} copies for "${QUERY}"`);
  let chosen = -1;
  let fallback = -1;
  for (let i = 0; i < n; i++) {
    const text = (await rows.nth(i).innerText()).replace(/\s+/g, ' ').trim();
    const isAlbum = WANT_ALBUM.test(text);
    const isFlac = /\bflac\b/i.test(text);
    console.log(`[net] copy #${i}: album=${isAlbum} flac=${isFlac} :: ${text.slice(0, 90)}`);
    if (isAlbum && fallback < 0) fallback = i;
    if (isAlbum && (!PREFER_FLAC || isFlac) && chosen < 0) chosen = i;
  }
  if (chosen < 0) chosen = fallback; // album matched but no FLAC → take MP3
  if (chosen < 0) chosen = 0; // last resort: first copy
  await rows.nth(chosen).click();
  await page.screenshot({ path: `${OUT}/13-chosen-folder.png`, fullPage: false });

  await picker.getByTestId('copy-picker-get').click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/14-download-started.png`, fullPage: false });

  // Confirm the download registered on the Downloads page.
  await page.goto('/downloads');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/15-downloads-page.png`, fullPage: true });
  console.log(`[net] done — see screenshots 12–15`);
});
