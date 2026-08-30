import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Admin seeded by auth.setup.ts (first user => admin). */
export const ADMIN = { username: 'e2e-admin', password: 'e2e-password-123' } as const;

/** Where the setup project saves the authenticated storageState. */
export const AUTH_FILE = '.auth/admin.json';

/**
 * Mirrors fixtures/music — see scripts/make-fixtures.ts. The 7-track album is
 * classified `album` and shows in the Albums grid; the loose single surfaces on
 * the artist page / singles list.
 */
export const FIXTURE = {
  album: { artist: 'E2E Test Artist', title: 'E2E Test Album', trackCount: 7 },
  single: { artist: 'E2E Single Artist', title: 'E2E Lonesome Single' },
  /**
   * Same-artist pair sharing a title token ("Nocturne" / "Nocturne Drift") —
   * exists so playlist-proposals e2e coverage has a genuine token overlap:
   * adding the first seeds proposal tokens that are all substrings of the
   * second's title+artist (see `PlaylistService.proposals`).
   */
  proposalPair: {
    artist: 'E2E Playlist Seed Artist',
    seed: { title: 'Nocturne' },
    suggested: { title: 'Nocturne Drift' },
  },
} as const;

/** auth header for direct API calls in setup/teardown. */
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const MUSIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/music');

/**
 * Snapshot a music fixture and put it back once the calling spec file finishes.
 *
 * **Any spec that deletes a fixture from disk must call this.** The fixtures under
 * `fixtures/music` are **git-tracked**, and `scripts/make-fixtures.ts` needs ffmpeg —
 * which CI does not have — so they are generated once and committed, never
 * regenerated per run (`bun run e2e` is a bare `playwright test`). A spec that
 * deletes one therefore leaves the working tree one file short *permanently*: it
 * passes exactly once per `git checkout`, and every later run fails on a fixture
 * that is simply gone. Restoring here keeps runs repeatable and the tree clean.
 *
 * Registers its own `beforeAll`/`afterAll`, so just call it at describe scope.
 *
 * @param relPath path under `fixtures/music`, e.g. `'E2E_Test_Artist/E2E_Test_Album/04 - Quiet_Hours.flac'`
 */
export function preserveMusicFixture(relPath: string): void {
  const abs = join(MUSIC_ROOT, relPath);
  let snapshot: Buffer | null = null;

  test.beforeAll(() => {
    if (existsSync(abs)) snapshot = readFileSync(abs);
  });

  test.afterAll(() => {
    // Only rewrite when the spec actually removed it — never clobber a live file.
    if (snapshot && !existsSync(abs)) writeFileSync(abs, snapshot);
  });
}

/**
 * Expand a collapsible `<app-settings-group>` card (Admin + Settings pages —
 * see docs/web-ui.md) identified by its `groupId`, no-op if already open.
 * Every group renders collapsed by default and persists open/closed state to
 * localStorage per device, so a spec that needs to interact with a card's body
 * must expand it first.
 */
export async function expandGroup(page: Page, groupId: string): Promise<void> {
  const toggle = page.locator(`[data-group-id="${groupId}"]`).getByTestId('settings-group-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** Clears every persisted `nicotind-group-*` open/closed key (issue #377 —
 * this loop used to be copy-pasted per spec) so a leftover expanded state
 * from an earlier spec/run can never leak into a collapsed-by-default
 * assertion or screenshot. Reload after it when the page must re-render. */
export async function clearGroupState(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('nicotind-group-')) localStorage.removeItem(key);
    }
  });
}

/**
 * Trigger a library scan and **wait for it to finish**.
 *
 * `POST /api/system/scan` is deliberately fire-and-forget (`routes/system.ts`:
 * "the client can poll /scan/status"), so a bare `request.post(...)` returns
 * while the scanner is still reconciling `library_songs`/`library_albums`. With
 * `workers: 1` and one shared server, that reconcile then runs *underneath
 * whichever spec happens to be next*, and any assertion sampling mid-reconcile
 * sees a missing or half-written album. That is issue #655's "a different test
 * fails each run, and every one passes in isolation" — the victim is simply
 * whoever was running when the scan landed.
 *
 * **Any spec that scans must use this**, never a bare post. Leaving a scan in
 * flight is the e2e equivalent of a dangling promise.
 */
export async function scanAndWait(request: APIRequestContext, token: string): Promise<void> {
  await request.post('/api/system/scan', { headers: bearer(token) });
  // The POST flips `scanning` before it responds, so the first poll already
  // observes a truthful value — no need to wait for the flag to rise first.
  await expect
    .poll(
      async () => {
        const r = await request.get('/api/system/scan/status', { headers: bearer(token) });
        if (!r.ok()) return true; // treat an unreadable status as "still going"
        return ((await r.json()) as { scanning: boolean }).scanning;
      },
      { timeout: 60_000, intervals: [200, 500, 1000] },
    )
    .toBe(false);
}

/** Wait until the library scan has settled and at least one album is listed. */
export async function waitForLibrary(request: APIRequestContext, token: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await request.get('/api/library/albums', { headers: bearer(token) });
        if (!r.ok()) return 0;
        const albums = (await r.json()) as unknown[];
        return Array.isArray(albums) ? albums.length : 0;
      },
      { timeout: 30_000, intervals: [500, 1000, 1500] },
    )
    .toBeGreaterThan(0);
}

/**
 * Open an album from the library grid, tolerating the grid's re-chunk.
 *
 * Issue #726: the album grid chunks its cards into `role="row"` slices of
 * `TvNavGroupDirective.gridColumns()`, which **starts at `signal(1)`** and is
 * only measured after init. So the first paint is rows-of-one, and the measured
 * value (5 on desktop) immediately re-chunks the whole grid — rows are
 * `track $index` while albums redistribute across them, so every `<a>` is
 * destroyed and recreated.
 *
 * `toBeVisible()` passes against the rows-of-one DOM, and a click landing in
 * that window hits an anchor being replaced: the event fires on a detached node
 * and the router never sees it. That is why the spec passes standalone and
 * fails under full-suite load, where the window is wider.
 *
 * Retrying the click is the honest fix for the *spec* — the underlying grid
 * still has a one-frame window a fast human could hit, which is an app-side
 * change (measure columns before first paint) rather than a test one.
 *
 * Issue #784: the retry's URL assertion used to be `/\/library\/albums\//` — a
 * **shape** check that any album satisfies. Under full-suite state the grid also
 * holds albums other specs created, and the card locator re-resolves on every
 * `toPass` attempt, so a re-chunk between click and retry could navigate to a
 * *different* album and the helper still reported success. The caller then waited
 * for a track that album does not have, and failed somewhere else entirely with a
 * message that named neither the helper nor the real cause.
 *
 * The id is read from `data-album-id` (carried by both album-card anchors — the
 * browse grid and the find-bar results) **inside** each attempt, and that
 * attempt's own id is what the URL must match. Re-reading per attempt is
 * deliberate: pinning one id up front would make the documented re-chunk above a
 * hard failure instead of the thing the retry exists to absorb, while still
 * leaving the helper unable to claim an album it did not click.
 */
export async function openAlbumCard(page: Page, title?: string): Promise<void> {
  const grid = page.getByTestId('album-card');
  const card = (title ? grid.filter({ hasText: title }) : grid).first();
  await expect(card).toBeVisible();
  await expect(async () => {
    // Read and click in the same attempt so the assertion below is about the
    // element this iteration actually clicked, not one a re-chunk has replaced.
    const albumId = await card.getAttribute('data-album-id', { timeout: 2_000 });
    expect(albumId, 'album card must expose data-album-id').toBeTruthy();
    await card.click({ timeout: 2_000 });
    await expect(page).toHaveURL(new RegExp(`/library/albums/${albumId}(?:[/?#]|$)`), {
      timeout: 2_000,
    });
  }).toPass({ timeout: 15_000 });

  // Landing on the URL is not the same as the album being there to act on, and
  // every caller's next line assumes the latter. `play-album` is the sentinel:
  // unconditional inside the loaded-album block, so it is present exactly when
  // the album rendered — not role-gated, and not suppressed by an empty
  // tracklist. Waiting here absorbs the load race once instead of at 22 call
  // sites, and names the helper as the failure site rather than leaving a spec
  // to time out on some track title three lines later (issue #784).
  await expect(
    page.getByTestId('play-album'),
    'album detail did not load — page is likely showing album-not-found, ' +
      'album-unavailable, or the whole-page album-processing state',
  ).toBeVisible();
}
