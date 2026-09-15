import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Seed a managed server the way every spec assumes it: the first user (an
 * admin), a scanned fixture library, plain lyrics on the first fixture track,
 * and an authenticated `storageState` at `authFile` for the project to reuse.
 *
 * Shared by the `setup` and `tv-setup` projects (#1136) — the TV bundle runs on
 * its own server, which needs exactly this and must not drift from the phone
 * server's baseline. Idempotent across re-runs: if the DB was not wiped (e.g.
 * `reuseExistingServer` locally), it logs in instead of completing setup.
 */
export async function seedAdminAndLibrary(
  page: Page,
  request: APIRequestContext,
  authFile: string,
): Promise<void> {
  const status = (await (await request.get('/api/setup/status')).json()) as {
    needsSetup: boolean;
  };

  let token: string;
  if (status.needsSetup) {
    const res = await request.post('/api/setup/complete', {
      data: { admin: { username: ADMIN.username, password: ADMIN.password } },
    });
    expect(res.status(), 'setup/complete should create the first admin').toBe(201);
    token = ((await res.json()) as { token: string }).token;
  } else {
    const res = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(res.ok(), 'admin login should succeed on a reused server').toBeTruthy();
    token = ((await res.json()) as { token: string }).token;
  }

  // Kick a scan of the fixture music dir and wait for it to land. `scanAndWait`
  // is what makes "land" true: `waitForLibrary` alone only proves *an* album
  // exists, so setup could return while the scanner was still writing and the
  // first spec would race a half-scanned library (issue #655).
  await scanAndWait(request, token);
  await waitForLibrary(request, token);

  // Seed lyrics on the first fixture track so the karaoke overlays can render
  // (fixture tracks are silent FLAC with no LRCLIB match, so the panel would be
  // empty without pre-seeded text). The list endpoint carries no songs and
  // names the album `name`, so this goes through the detail — the previous
  // `a.title` / `song[0]` on the list never matched, and the seed silently
  // never happened. This one asserts, so it cannot go quiet again.
  const albums = (await (
    await request.get('/api/library/albums', { headers: bearer(token) })
  ).json()) as Array<{ id: string; name: string }>;
  const fixtureAlbum = albums.find((a) => a.name === FIXTURE.album.title);
  expect(fixtureAlbum, `the fixture album "${FIXTURE.album.title}" is scanned`).toBeTruthy();
  const detail = (await (
    await request.get(`/api/library/albums/${fixtureAlbum!.id}`, { headers: bearer(token) })
  ).json()) as { song: Array<{ id: string }> };
  const first = detail.song[0];
  expect(first, 'the fixture album has a first track to carry the lyrics').toBeTruthy();
  const seeded = await request.put(`/api/library/songs/${first!.id}/lyrics`, {
    headers: bearer(token),
    data: { plain: KARAOKE_FIXTURE_LYRICS },
  });
  expect(seeded.ok(), 'the karaoke lyrics seed lands').toBeTruthy();

  // Persist auth into localStorage (the web app reads nicotind_token/_username/_role)
  // and snapshot it for the project.
  await page.goto('/login');
  await page.evaluate(
    ({ t, u }) => {
      localStorage.setItem('nicotind_token', t);
      localStorage.setItem('nicotind_username', u);
      localStorage.setItem('nicotind_role', 'admin');
    },
    { t: token, u: ADMIN.username },
  );
  mkdirSync(dirname(authFile) || '.', { recursive: true });
  await page.context().storageState({ path: authFile });
}

/** The plain lyrics `seedAdminAndLibrary` puts on the first fixture track. */
export const KARAOKE_FIXTURE_LYRICS = 'karaoke warmup line\nsecond warmup line';

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
 * A track **as listed in a track list** — the row's title button, never the
 * player bar and never Now Playing.
 *
 * `page.getByText('Opening Static')` is not that assertion. Every play claims a
 * remote-playback session, and a context Playwright tears down fires no
 * `pagehide` (see "A context torn down by Playwright fires no `pagehide`" in
 * docs/e2e.md), so the previous spec's session can still be live when this spec
 * loads its first page. Its track then renders in `player-title` *and*
 * `now-playing-title`, and the bare text locator resolves to three elements —
 * a strict-mode failure inside a spec that never played anything. That is
 * issue #1110, and the repeated `library.spec.ts:5` failures of #1116,
 * including two on clean `master`.
 *
 * `NICOTIND_PLAYBACK_GRACE_MS=2000` narrows that window but cannot close it:
 * the grace is wall-clock and the collision is load-dependent, so the leftover
 * outlives it exactly when the box is busy. Scoping removes the dependency
 * instead of racing it — `track-row-title` is rendered only by
 * `app-track-row`, which the player bar and Now Playing do not use, so a
 * leftover session cannot satisfy this locator however late it clears.
 *
 * Pass a narrower `scope` (e.g. `page.getByTestId('artist-songs-list')`) when
 * the same title can legitimately appear in two lists on one page.
 */
export function trackTitle(scope: Page | Locator, title: string): Locator {
  return scope.getByTestId('track-row-title').filter({ hasText: title });
}

/**
 * One paired-device row, by the label shown on it.
 *
 * Same reason as `trackTitle`: a bare `getByTestId('device-row')` asserted with
 * `toContainText` is a strict-mode violation the moment the list holds more than
 * one device, and no spec owns that list. A browser session another spec left
 * open is still a paired device (see the pagehide note in docs/e2e.md), so the
 * count observed in CI was 2, 3 and 4 across attempts of the same test.
 *
 * Revoke through the row this returns, and assert the ROW is gone rather than
 * that the list is empty — emptiness is a claim about everyone else's devices.
 */
export function deviceRow(scope: Page | Locator, label: string): Locator {
  return scope.getByTestId('device-row').filter({ hasText: label });
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
 *
 * Issue #1109: the loop above is only idempotent while the page is still ON the
 * grid. An attempt whose click commits a navigation the identity assertion
 * rejects — the wrong-album landing #784 guards against, or a lazy route that
 * resolves just after the 2 s window — leaves the page on `/library/albums/…`,
 * where `data-testid="album-card"` does not exist (it is rendered only by the
 * two grid templates, never by album detail). Every later attempt then times
 * out reading `data-album-id` off a locator with nothing to resolve to, and the
 * loop burns its whole 15 s without ever looking at the grid again — the
 * reported `locator.getAttribute: Timeout 2000ms exceeded` with no visible
 * cause. Re-navigating back to the caller's own grid URL when the grid is gone
 * turns that dead end into one more retry.
 */
export async function openAlbumCard(page: Page, title?: string): Promise<void> {
  const grid = page.getByTestId('album-card');
  const card = (title ? grid.filter({ hasText: title }) : grid).first();
  await expect(card).toBeVisible();
  // The caller's exact grid state (/library, ?find=…, ?type=…) — restored
  // below rather than a generic /library, so a find-bar or filtered caller
  // doesn't lose that state on recovery.
  const gridUrl = page.url();
  await expect(async () => {
    // A stranded attempt: get back to the grid before trying to read from it.
    // `grid.count()` is a zero-wait snapshot, so the happy path (no strand)
    // pays nothing extra.
    if ((await grid.count()) === 0) await page.goto(gridUrl);
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
    'album detail did not load — page is likely showing album-not-found, ' + 'album-unavailable',
  ).toBeVisible();
}
