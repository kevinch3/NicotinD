import { test, expect } from '@playwright/test';

const OUT = 'screenshots/mobile';
const QUERY = process.env.NET_QUERY ?? 'Zara Larsson Poster Girl';
const WANT_ALBUM = /poster\s*girl/i;
const PREFER_FLAC = process.env.NET_FORMAT !== 'mp3';

/**
 * Escape-hatch album download via the Advanced (raw Soulseek) network lane —
 * the guided catalog→hunt path is broken for this artist (§A6). Searches
 * "Zara Larsson Poster Girl", opens the Advanced disclosure, switches to the
 * Folders view, picks a FLAC folder for the album, and downloads it. Captures
 * screenshots at every meaningful step for the UX report.
 */
test('network album download (Poster Girl, FLAC)', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/search');
  await page.getByTestId('search-input').fill(QUERY);
  await page.getByTestId('search-submit').click();

  // Reveal the raw-network lane (it only auto-opens when there's no catalog hit).
  const advancedToggle = page.getByTestId('advanced-toggle');
  await advancedToggle.waitFor({ state: 'visible', timeout: 30_000 });
  await advancedToggle.click();

  // Switch to Folders view once network results arrive.
  const foldersBtn = page.getByTestId('network-view-folders');
  await foldersBtn.waitFor({ state: 'visible', timeout: 90_000 });
  // Wait until the folders count is non-zero (label reads "Folders (N)").
  await expect
    .poll(async () => {
      const t = (await foldersBtn.innerText().catch(() => 'Folders (0)')).match(/\((\d+)\)/);
      return t ? Number(t[1]) : 0;
    }, { timeout: 90_000, intervals: [1000, 1500, 2000] })
    .toBeGreaterThan(0);
  await foldersBtn.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/12-network-folders.png`, fullPage: true });

  // Pick a folder: prefer one whose contents are FLAC and that matches the album.
  const advanced = page.getByTestId('advanced-network-search');
  const groups = advanced.locator('div.rounded-lg.border');
  const n = await groups.count();
  console.log(`[net] ${n} folder group(s) for "${QUERY}"`);

  let chosen = -1;
  let chosenLabel = '';
  let fallback = -1;
  for (let i = 0; i < n; i++) {
    const text = (await groups.nth(i).innerText()).replace(/\s+/g, ' ').trim();
    const isAlbum = WANT_ALBUM.test(text);
    const isFlac = /\.flac\b/i.test(text) || /\bflac\b/i.test(text);
    console.log(`[net] folder #${i}: album=${isAlbum} flac=${isFlac} :: ${text.slice(0, 90)}`);
    if (isAlbum && fallback < 0) fallback = i;
    if (isAlbum && (!PREFER_FLAC || isFlac) && chosen < 0) {
      chosen = i;
      chosenLabel = text;
    }
  }
  if (chosen < 0) chosen = fallback; // album matched but no FLAC → take MP3
  if (chosen < 0) chosen = 0; // last resort: first folder
  if (!chosenLabel) chosenLabel = (await groups.nth(chosen).innerText()).replace(/\s+/g, ' ').trim();
  console.log(`[net] chosen folder #${chosen}: ${chosenLabel.slice(0, 110)}`);

  const folder = groups.nth(chosen);
  await folder.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/13-chosen-folder.png`, fullPage: false });

  // The first <button> in the folder header is the download-folder action.
  const dlBtn = folder.getByRole('button').first();
  const before = (await dlBtn.innerText()).trim();
  const alreadyDone = await dlBtn.isDisabled();
  if (alreadyDone) {
    // Idempotent: a prior run already grabbed this album ("✓ Done"/disabled).
    console.log(`[net] folder already downloaded (button "${before}") — skipping click`);
  } else {
    await dlBtn.click();
    console.log(`[net] clicked folder download (was "${before}")`);
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/14-download-started.png`, fullPage: false });

  // Confirm the download registered on the Downloads page.
  await page.goto('/downloads');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/15-downloads-page.png`, fullPage: true });
  console.log(`[net] done — see screenshots 12–15`);
});
