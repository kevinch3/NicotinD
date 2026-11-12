import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test as base } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { E2E_MUSIC_DIR } from './fixture-music';

export { expect };
export type { APIRequestContext, BrowserContext, Locator, Page } from '@playwright/test';

/** The bearer token a project's saved `storageState` carries, or null when the
 *  project has none (the never-seeded `onboarding` server). */
function storedToken(storageState: unknown): string | null {
  if (typeof storageState !== 'string' || !existsSync(storageState)) return null;
  const state = JSON.parse(readFileSync(storageState, 'utf8')) as {
    origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
  };
  for (const origin of state.origins ?? []) {
    const hit = origin.localStorage?.find((e) => e.name === 'nicotind_token');
    if (hit?.value) return hit.value;
  }
  return null;
}

/**
 * The suite's `test`: every spec imports it from here (the TV lane's
 * `tv-test.ts` composes on it).
 *
 * `freshPlaybackSession` is why. A context torn down by Playwright fires no
 * `pagehide`, so the remote-playback session a spec's tab claimed outlives the
 * spec on the server — and its *track* outlives even the release grace, which
 * only clears the output. The next spec's fresh tab then restores that track
 * into its player bar from the first `STATE_SYNC` and, if the dead output is
 * still in its grace, spends its first seconds "reconnecting" to it (#1182,
 * and the three-element title matches of #1110/#1116). The 2 s
 * `NICOTIND_PLAYBACK_GRACE_MS` on the e2e server only narrows that window;
 * this ends the session outright before every test, through the same
 * `POST /api/playback/session/reset` an operator uses on a stuck cast — so a
 * retry starts from the same clean slate as a first attempt, which is the
 * property a flake retry is supposed to have. Loud on failure by design: a
 * reset that silently stopped working would put every spec back on the timer.
 */
export const test = base.extend<{ freshPlaybackSession: void }>({
  freshPlaybackSession: [
    async ({ request }, use, testInfo) => {
      const token = storedToken(testInfo.project.use.storageState);
      if (token) {
        const res = await request.post('/api/playback/session/reset', { headers: bearer(token) });
        expect(res.status(), 'per-spec playback session reset').toBe(204);
      }
      await use();
    },
    { auto: true },
  ],
});

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
  /**
   * The only genre-tagged fixtures. Five Alpha artists x 2 tracks and two Beta
   * artists x 2, so a radio held at depth 5 can stay in Alpha for a whole spec
   * (#1277) and Beta is there to be drifted into. Titles are `<genre> <a>-<n>`.
   */
  genres: {
    alpha: { genre: 'E2E Alpha', artists: 5, tracks: 10 },
    beta: { genre: 'E2E Beta', artists: 2, tracks: 4 },
  },
} as const;

/** auth header for direct API calls in setup/teardown. */
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Snapshot a music fixture and put it back once the calling spec file finishes.
 *
 * **Any spec that deletes a fixture from disk must call this.** The server runs on
 * a per-run copy of `fixtures/music` (`E2E_MUSIC_DIR`, #1320), so the tracked tree
 * is safe — but the copy is shared by every spec in the run, and a later spec that
 * expects the file would otherwise find it gone.
 *
 * Registers its own `beforeAll`/`afterAll`, so just call it at describe scope.
 * The returned `restore` does the same put-back inside a test.
 *
 * Writing the file back is half of it: the server only sees a file a scan reads,
 * so the restore rescans too. Without that the deleted row stays gone, and a
 * delete that demoted its album (7 → 6 tracks is an EP) keeps it out of the
 * Albums grid for every later spec (#1713).
 *
 * @param relPath path under `fixtures/music`, e.g. `'E2E_Test_Artist/E2E_Test_Album/04 - Quiet_Hours.flac'`
 */
export function preserveMusicFixture(relPath: string): {
  restore: (request: APIRequestContext) => Promise<void>;
} {
  const abs = join(E2E_MUSIC_DIR, relPath);
  let snapshot: Buffer | null = null;

  const restore = async (request: APIRequestContext): Promise<void> => {
    // Only rewrite when the spec actually removed it — never clobber a live file.
    if (!snapshot || existsSync(abs)) return;
    writeFileSync(abs, snapshot);
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(login.ok(), 'admin login for the fixture rescan').toBeTruthy();
    const { token } = (await login.json()) as { token: string };
    await scanAndWait(request, token);
  };

  test.beforeAll(() => {
    if (existsSync(abs)) snapshot = readFileSync(abs);
  });

  test.afterAll(async ({ request }) => restore(request));

  return { restore };
}

/**
 * Put an album's lyrics back once the calling spec file finishes (#1800).
 *
 * `PUT /songs/:id/lyrics` stores a `customized` row and may write the text into
 * the file's tag, in the per-run copy every spec shares. A spec that writes
 * lyrics to every track left them for whatever ran next: `offline-lyrics`
 * expects only track 1 to carry lyrics, the row the setup seeds. So this
 * snapshots the album's rows and files first, and afterwards writes the rows
 * back as they were (deleting the ones that did not exist), writes back any
 * file whose bytes changed, and rescans.
 *
 * Call it at describe scope in a spec that writes lyrics to fixture songs.
 * Safe because the suite runs one spec file at a time per worker
 * (`fullyParallel: false`).
 *
 * @param relDir album folder under `fixtures/music`, e.g. `'E2E_Test_Artist/E2E_Test_Album'`
 */
export function preserveAlbumLyrics(relDir: string, albumTitle: string): void {
  const dir = join(E2E_MUSIC_DIR, relDir);
  const files = new Map<string, Buffer>();
  const rows = new Map<string, { plain: string | null; synced: string | null } | null>();

  async function adminToken(request: APIRequestContext): Promise<string> {
    const login = await request.post('/api/auth/login', { data: ADMIN });
    expect(login.ok(), 'admin login for the lyrics snapshot').toBeTruthy();
    return ((await login.json()) as { token: string }).token;
  }
  async function songIds(request: APIRequestContext, token: string): Promise<string[]> {
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(token) })
    ).json()) as Array<{ id: string; name: string }>;
    // The album DTO's title is `name`.
    const album = albums.find((a) => a.name === albumTitle);
    expect(album, `the fixture album "${albumTitle}" to snapshot`).toBeTruthy();
    const detail = (await (
      await request.get(`/api/library/albums/${album!.id}`, { headers: bearer(token) })
    ).json()) as { song: Array<{ id: string }> };
    return detail.song.map((s) => s.id);
  }

  test.beforeAll(async ({ request }) => {
    for (const name of readdirSync(dir)) files.set(name, readFileSync(join(dir, name)));
    const token = await adminToken(request);
    for (const id of await songIds(request, token)) {
      const res = await request.get(`/api/library/songs/${id}/lyrics`, { headers: bearer(token) });
      const row = (await res.json()) as { plain: string | null; synced: string | null } | null;
      rows.set(id, row ? { plain: row.plain, synced: row.synced } : null);
    }
  });

  test.afterAll(async ({ request }) => {
    const token = await adminToken(request);
    for (const [id, row] of rows) {
      if (row?.plain) {
        await request.put(`/api/library/songs/${id}/lyrics`, {
          headers: bearer(token),
          data: row.synced ? { plain: row.plain, synced: row.synced } : { plain: row.plain },
        });
      } else {
        await request.delete(`/api/library/songs/${id}/lyrics`, { headers: bearer(token) });
      }
    }
    let rewritten = false;
    for (const [name, bytes] of files) {
      const abs = join(dir, name);
      if (existsSync(abs) && readFileSync(abs).equals(bytes)) continue;
      writeFileSync(abs, bytes);
      rewritten = true;
    }
    if (rewritten) await scanAndWait(request, token);
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

/** What {@link measureHorizontalOverflow} found: the widest scroller overflow and who caused it. */
export interface HorizontalOverflow {
  /** Largest `scrollWidth - clientWidth` across `html`, `body` and `[data-scroll-root]`. */
  overflow: number;
  /** The outermost elements whose box crosses the viewport's left or right edge. */
  offenders: string[];
}

/**
 * Measure horizontal overflow the way a phone user meets it (#1807): the page
 * scrollers widening, plus the elements that widen them.
 *
 * The scrollers are `html`, `body` and the shell's `<main data-scroll-root>` —
 * `<main>`'s `overflow-y: auto` turns its `overflow-x` into `auto` too, so content
 * wider than the page slides the whole view sideways instead of being clipped.
 *
 * An offender is an element whose box sits more than 1px past the viewport's
 * left or right edge. Skipped: hidden and zero-size boxes, `position: fixed`
 * layers (sheets, toasts, the player — not part of the page), and anything
 * under an ancestor that does not let overflow through (`overflow-x` other than
 * `visible`): a scroll strip, a `section-flush` table, a `truncate` host. Only
 * the outermost offender is reported, so one overflowing row is one line, not
 * one line per button in it.
 *
 * Measured with the `[data-x-guard]` wrappers switched off: they clip the
 * overflow so a user never sees the page slide, which would also hide it here.
 */
export async function measureHorizontalOverflow(page: Page): Promise<HorizontalOverflow> {
  return page.evaluate(() => {
    // The page's overflow-x guards (`[data-x-guard]`, overflow-x: clip) would hide
    // every offender; measure with them off, then put them back.
    const guardsOff = document.createElement('style');
    guardsOff.textContent = '[data-x-guard]{overflow-x:visible!important}';
    document.head.appendChild(guardsOff);
    const roots = [
      document.documentElement,
      document.body,
      document.querySelector<HTMLElement>('[data-scroll-root]'),
    ].filter((el): el is HTMLElement => !!el);
    const overflow = roots.reduce((max, el) => Math.max(max, el.scrollWidth - el.clientWidth), 0);

    const vw = document.documentElement.clientWidth;
    const label = (el: Element): string => {
      const testid = el.getAttribute('data-testid');
      if (testid) return `${el.tagName.toLowerCase()}[data-testid=${testid}]`;
      const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).slice(0, 4).join('.');
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };
    const path = (el: Element): string => {
      const parts: string[] = [];
      for (
        let n: Element | null = el;
        n && n !== document.body && parts.length < 4;
        n = n.parentElement
      ) {
        parts.unshift(label(n));
        if (n.hasAttribute('data-testid') && n !== el) break;
      }
      return parts.join(' > ');
    };

    // The shell's own boxes clip (overflow-hidden) and <main> scrolls on both axes,
    // but they are the page itself: walk through them rather than stopping there.
    const shell = new Set<Element>();
    for (let n = document.querySelector('[data-scroll-root]'); n; n = n.parentElement) shell.add(n);

    const offenders: string[] = [];
    const walk = (el: Element): void => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.position === 'fixed') return;
      const r = el.getBoundingClientRect();
      const visible = style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      if (visible && (r.right > vw + 1 || r.left < -1)) {
        offenders.push(
          `${path(el)} (left ${Math.round(r.left)}, right ${Math.round(r.right)}, viewport ${vw})`,
        );
        return;
      }
      // A container that clips or scrolls owns its own overflow — not the page's.
      if (!shell.has(el) && style.overflowX !== 'visible') return;
      for (const child of Array.from(el.children)) walk(child);
    };
    for (const child of Array.from(document.body.children)) walk(child);
    guardsOff.remove();
    return { overflow, offenders: offenders.filter((o, i) => offenders.indexOf(o) === i) };
  });
}

/**
 * Assert the page has no horizontal overflow (#1807): no page scroller wider
 * than the viewport, and no element crossing its edge. The failure names the
 * outermost offending elements.
 */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const m = await measureHorizontalOverflow(page);
  expect(
    { overflow: m.overflow <= 1 ? 0 : m.overflow, offenders: m.offenders },
    `${label}: nothing wider than the viewport`,
  ).toEqual({ overflow: 0, offenders: [] });
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
const SCAN_TIMEOUT_MS = 60_000;
const LIBRARY_TIMEOUT_MS = 30_000;
const PROCESSING_IDLE_TIMEOUT_MS = 180_000;

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
      { timeout: SCAN_TIMEOUT_MS, intervals: [200, 500, 1000] },
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
  // The waits below are budgeted for a loaded box; under the default 30 s test
  // timeout the 180 s idle poll could never use its budget (#1338).
  test
    .info()
    .setTimeout(SCAN_TIMEOUT_MS + LIBRARY_TIMEOUT_MS + PROCESSING_IDLE_TIMEOUT_MS + 30_000);
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
  await waitForProcessingIdle(request, token);

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
      // A fresh device opens the Library on Songs; the suite browses from the
      // album grid, so the seeded user last left it on Albums (docs/e2e.md).
      // The Songs-first default itself is asserted in mobile-ux.spec.ts.
      localStorage.setItem('nicotind-library-mode', 'albums');
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
      { timeout: LIBRARY_TIMEOUT_MS, intervals: [500, 1000, 1500] },
    )
    .toBeGreaterThan(0);
}

/**
 * Wait for the eager enrichment pass a scan kicks off to drain.
 *
 * A landed scan is not a quiet server: `enrichNewSongsNow()` fires the moment
 * it completes and decodes every new file for BPM/key/loudness. On a two-core
 * runner, three servers doing that over 24 fixtures starve the first spec of
 * the shard — its `/api/library/albums` sat on "Loading albums" past the 5 s
 * locator timeout, twice (PR #1281). `phase` is `running` while a run is in
 * flight, but the service may report idle in the gap between two batches of
 * one run, so a single quiet sample proves nothing: three in a row, a second
 * apart, do. A 503 means no processing service, which is nothing to wait for.
 */
export async function waitForProcessingIdle(
  request: APIRequestContext,
  token: string,
): Promise<void> {
  const phase = async (): Promise<string> => {
    const r = await request.get('/api/admin/processing', { headers: bearer(token) });
    if (!r.ok()) return 'unavailable';
    const state = (await r.json()) as { status?: { phase?: string } };
    return state.status?.phase ?? 'unknown';
  };
  let quiet = 0;
  let last = 'none';
  await expect(async () => {
    last = await phase();
    quiet = last === 'running' ? 0 : quiet + 1;
    expect(
      quiet,
      `processing never went quiet 3 samples in a row; last phase: ${last}`,
    ).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: PROCESSING_IDLE_TIMEOUT_MS, intervals: [1000] });
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
 * Assert `.first()` is visible — **at least one, never exactly one**. A device's
 * label can come from the user agent, so this spec's own row is
 * indistinguishable from a leftover; and a retried attempt leaves its own row
 * behind. Pinning the count is the same "I own this list" mistake as the bare
 * locator, one layer down.
 *
 * Revoke through a row and assert the list SHRANK, rather than that it is empty
 * — emptiness is a claim about everyone else's devices. If the test then asserts
 * something about the revoked device (a dead JWT), revoke every matching row:
 * with a leftover present there is no ordering guarantee about which is yours.
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

/**
 * Make every vibe preset look playable (#1739). The pages probe each vibe's
 * filter with a one-song `GET /api/library/songs?size=1…` and hide the vibes
 * nothing matches. The fixture library is silent FLACs with no mood, energy or
 * BPM data, so without this every vibe is (correctly) hidden. Specs that are
 * about the vibe tiles themselves answer the probes with one song; every other
 * songs request still reaches the server.
 */
export async function vibesPlayable(page: Page): Promise<void> {
  await page.route('**/api/library/songs?**', (route) => {
    const size = new URL(route.request().url()).searchParams.get('size');
    return size === '1' ? route.fulfill({ json: [{ id: 'vibe-probe' }] }) : route.continue();
  });
}

/**
 * Open the album page's ⋯ menu (docs/web-ui.md "Album page header"). Select, Fix
 * metadata, Remove album and Complete this album live in it, not in the header.
 */
export async function openAlbumMenu(page: Page): Promise<void> {
  await page.getByTestId('album-menu-toggle').click();
  await expect(page.getByTestId('album-menu')).toBeVisible();
}

/** Open the album's fix-metadata modal through the ⋯ menu. */
export async function openAlbumMetadataFix(page: Page): Promise<void> {
  await openAlbumMenu(page);
  await page.getByTestId('album-action-Fix metadata').click();
}
