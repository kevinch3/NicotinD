import { test, expect } from '@playwright/test';
import {
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_FLAC = join(HERE, '../fixtures/addon/addon-song.flac');
/**
 * `NICOTIND_MUSIC_DIR` is this **tracked** directory (playwright.config.ts), so
 * an import spec that does not clean up rewrites the repo's fixtures and leaves
 * the next run a duplicate album to trip over. Snapshotting the top level and
 * removing whatever appeared is self-maintaining — no hardcoded artist name to
 * drift when the fixture's tags change.
 */
const MUSIC_DIR = join(HERE, '../fixtures/music');

/**
 * The browser-upload import lane (docs/import.md).
 *
 * Drives the hidden `webkitdirectory` input rather than synthesising a
 * DataTransfer drop: Playwright's `setInputFiles` is the supported path, and it
 * exercises the same `stageFiles` → manifest → upload → commit flow the drop
 * handler feeds. The drop handler's own job is only turning entries into that
 * file list, which `dropped-files.ts` owns and unit tests cover.
 */
test.describe('import from a dropped folder', () => {
  let scratch: string;
  let musicBefore: Set<string>;

  test.beforeAll(() => {
    musicBefore = new Set(readdirSync(MUSIC_DIR));
    scratch = mkdtempSync(join(tmpdir(), 'e2e-import-upload-'));
    const album = join(scratch, 'Uploaded Album');
    mkdirSync(album, { recursive: true });
    copyFileSync(SRC_FLAC, join(album, '01 Uploaded One.flac'));
    copyFileSync(SRC_FLAC, join(album, '02 Uploaded Two.flac'));
    // Deliberate junk: the allowlist must drop it, and the card must say so.
    writeFileSync(join(album, 'notes.nfo'), 'not music');

    const junkOnly = join(scratch, 'Junk Only');
    mkdirSync(junkOnly, { recursive: true });
    writeFileSync(join(junkOnly, 'readme.txt'), 'still not music');
  });

  test.afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    for (const entry of readdirSync(MUSIC_DIR)) {
      if (!musicBefore.has(entry)) rmSync(join(MUSIC_DIR, entry), { recursive: true, force: true });
    }
  });

  test('a picked folder previews, uploads, and lands as an import job', async ({ page }) => {
    await page.goto('/get?tab=find');

    // A `webkitdirectory` input takes the directory itself — which is exactly
    // what the picker hands it in a real browser.
    await page
      .getByTestId('import-folder-input')
      .setInputFiles(join(scratch, 'Uploaded Album'));

    // A drop is a proposal: the card appears and waits rather than uploading.
    const card = page.getByTestId('import-drop-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('import-drop-summary')).toContainText('2');
    await expect(page.getByTestId('import-drop-skipped')).toBeVisible();

    await page.getByTestId('import-drop-start').click();

    // The card retires at commit and the work becomes an ordinary feed row —
    // two cards for one import would be #673's twin-row shape.
    await expect(card).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('get-tab-downloads')).toHaveAttribute('aria-current', 'page');

    const imported = page.locator('[data-testid="download-item"][data-method="import"]');
    await expect(imported.first()).toBeVisible({ timeout: 60_000 });
  });

  test('refuses a selection with no music, without opening a session', async ({ page }) => {
    await page.goto('/get?tab=find');
    await page.getByTestId('import-folder-input').setInputFiles(join(scratch, 'Junk Only'));

    // Nothing uploadable: the card still previews so the user learns why, and
    // its Add button is what would fail — not a silent no-op.
    await expect(page.getByTestId('import-drop-card')).toBeVisible();
    await expect(page.getByTestId('import-drop-skipped')).toBeVisible();
  });
});
