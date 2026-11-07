import { test, expect, type Page } from '../helpers';
import { E2E_MUSIC_DIR } from '../fixture-music';
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_FLAC = join(HERE, '../fixtures/addon/addon-song.flac');
/**
 * `NICOTIND_MUSIC_DIR` is the run's copy of the fixtures (fixture-music.ts), so
 * an import spec that does not clean up leaves every later spec in the run a
 * duplicate album to trip over. Snapshotting the top level and
 * removing whatever appeared is self-maintaining — no hardcoded artist name to
 * drift when the fixture's tags change.
 */
const MUSIC_DIR = E2E_MUSIC_DIR;

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

    const background = join(scratch, 'Background Album');
    mkdirSync(background, { recursive: true });
    copyFileSync(SRC_FLAC, join(background, '01 Background One.flac'));

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
    await page.goto('/get?tab=add');

    // A `webkitdirectory` input takes the directory itself — which is exactly
    // what the picker hands it in a real browser.
    await page.getByTestId('import-folder-input').setInputFiles(join(scratch, 'Uploaded Album'));

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
    await page.goto('/get?tab=add');
    await page.getByTestId('import-folder-input').setInputFiles(join(scratch, 'Junk Only'));

    // Nothing uploadable: the card still previews so the user learns why, and
    // its Add button is what would fail — not a silent no-op.
    await expect(page.getByTestId('import-drop-card')).toBeVisible();
    await expect(page.getByTestId('import-drop-skipped')).toBeVisible();
  });

  // #1664: import is an Add-tab action.
  test('the Activity tab offers no import and ignores a dropped file', async ({ page }) => {
    await page.goto('/get?tab=activity');
    await expect(page.getByTestId('get-tab-downloads')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('import-browse')).toHaveCount(0);
    await expect(page.getByTestId('import-folder-input')).toHaveCount(0);

    const prevented = await dispatchFileDrag(page, ['dragenter', 'dragover', 'drop']);
    // Swallowed (else the browser navigates to the file), but not taken.
    expect(prevented.drop).toBe(true);
    // A taken drop stages its files only after an async DataTransfer walk, so a
    // negative assertion polled straight away would pass before it could fail.
    // Let that walk settle first, then require the page to have stayed put.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 250)));
    await expect(page).toHaveURL(/tab=activity/);
    await expect(page.getByTestId('import-drop-overlay')).toHaveCount(0);
    await expect(page.getByTestId('import-drop-card')).toHaveCount(0);
    await expect(page.getByTestId('get-tab-downloads')).toHaveAttribute('aria-current', 'page');
  });

  test('the Add tab shows the entry, and a drag over it lights it up', async ({ page }) => {
    await page.goto('/get?tab=add');
    const entry = page.getByTestId('import-browse');
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute('data-dragging', 'false');

    await dispatchFileDrag(page, ['dragenter']);
    await expect(page.getByTestId('import-drop-overlay')).toBeVisible();
    await expect(entry).toHaveAttribute('data-dragging', 'true');

    await dispatchFileDrag(page, ['dragleave']);
    await expect(page.getByTestId('import-drop-overlay')).toHaveCount(0);
    await expect(entry).toHaveAttribute('data-dragging', 'false');
  });

  test('an upload keeps running on Activity, with a progress row and a badge', async ({ page }) => {
    // Hold the chunk upload so the switch provably lands mid-upload.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/import/uploads/*/chunk*', async (route) => {
      await held;
      await route.continue();
    });
    // The feed is shared across specs (an earlier test's import may still be
    // running), so a bare "badge visible" proves nothing. Empty both feeds the
    // badge sums, leaving the upload as the only thing it can count.
    await page.route(EMPTY_FEEDS, (route) => route.fulfill({ json: [] }));

    await page.goto('/get?tab=add');
    await page.getByTestId('import-folder-input').setInputFiles(join(scratch, 'Background Album'));
    await page.getByTestId('import-drop-start').click();
    // The bar is a 0-width box while the chunk is held, so assert the label.
    await expect(page.getByTestId('import-drop-percent')).toHaveText('0%');

    await page.getByTestId('get-tab-downloads').click();
    await expect(page.getByTestId('import-browse')).toHaveCount(0);
    await expect(page.getByTestId('import-progress-row')).toBeVisible();
    await expect(page.getByTestId('import-progress-percent')).toHaveText('0%');
    // With both feeds empty, a badge of exactly 1 can only be the upload.
    await expect.poll(() => badgeCount(page)).toBe(1);

    release();
    // At commit the feed's own import row takes over, so this one retires.
    await expect(page.getByTestId('import-progress-row')).toHaveCount(0, { timeout: 60_000 });
    await page.unroute('**/api/import/uploads/*/chunk*');
    await page.unroute(EMPTY_FEEDS);
  });
});

/** The two feeds the Activity badge sums besides an in-flight upload. */
const EMPTY_FEEDS = /\/api\/(downloads|acquire)\/jobs(\?|$)/;

/** The Activity tab badge's number; absent means nothing is in flight. */
async function badgeCount(page: Page): Promise<number> {
  const badge = page.getByTestId('get-tab-downloads-badge');
  if ((await badge.count()) === 0) return 0;
  return Number((await badge.textContent())?.trim() ?? 0);
}

/**
 * Dispatch synthetic file-drag events on the Get workspace. Playwright has no
 * OS-level file drag, so this builds the `DataTransfer` a real one carries and
 * reports, per event, whether the page called `preventDefault`.
 */
async function dispatchFileDrag(page: Page, types: string[]): Promise<Record<string, boolean>> {
  return page.getByTestId('get-tabs').evaluate((el, eventTypes) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'dropped.flac', { type: 'audio/flac' }));
    const out: Record<string, boolean> = {};
    for (const type of eventTypes) {
      const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      out[type] = ev.defaultPrevented;
    }
    return out;
  }, types);
}
