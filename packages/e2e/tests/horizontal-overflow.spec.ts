import { test, expect, type APIRequestContext, type Page } from '../helpers';
import { ADMIN, FIXTURE, bearer, clearGroupState, expectNoHorizontalOverflow } from '../helpers';

/**
 * #1807: nothing on any page is wider than a phone. Content wider than its
 * container used to scroll `<main>` sideways (its `overflow-y: auto` makes
 * `overflow-x` a scroller too), sliding the whole view — the gutters gone, a
 * button cut off. Fixes came one view at a time; this sweeps every route.
 *
 * Every route is opened at 320, 360 and 390 px (re-measured on a resize, not a
 * reload) in English and in Spanish, whose labels are the longest the app
 * ships. Settings groups render their bodies only while open, so every group on
 * a page is expanded first — a collapsed card is a card nobody measured.
 * The data-dependent rows exist because they are seeded: an open and a closed
 * radio poll, a playlist, a share link.
 *
 * Chromium only: an iOS-only overflow is still a device check (docs/e2e.md).
 */
const WIDTHS = [320, 360, 390] as const;
const LANGS = ['en', 'es'] as const;
const HEIGHT = 800;

interface Seeded {
  token: string;
  albumId: string;
  artistId: string;
  playlistId: string;
  shareToken: string;
  pollIds: string[];
  pollToken: string;
}

async function seed(request: APIRequestContext): Promise<Seeded> {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  expect(login.ok(), 'admin login').toBeTruthy();
  const token = ((await login.json()) as { token: string }).token;
  const headers = bearer(token);

  const albums = (await (await request.get('/api/library/albums', { headers })).json()) as Array<{
    id: string;
    name: string;
    artistId?: string;
  }>;
  const album = albums.find((a) => a.name === FIXTURE.album.title);
  expect(album, 'the fixture album').toBeTruthy();
  const artists = (await (await request.get('/api/library/artists', { headers })).json()) as Array<{
    id: string;
    name: string;
  }>;
  const artist = artists.find((a) => a.name === FIXTURE.album.artist);
  expect(artist, 'the fixture artist').toBeTruthy();
  const detail = (await (
    await request.get(`/api/library/albums/${album!.id}`, { headers })
  ).json()) as { song?: Array<{ id: string }>; songs?: Array<{ id: string }> };
  const songIds = (detail.song ?? detail.songs ?? []).map((s) => s.id);
  expect(songIds.length, 'the fixture album has songs').toBeGreaterThan(0);

  const playlist = await request.post('/api/playlists', {
    headers,
    data: { name: 'Lista de reproducción de prueba con un nombre largo', songIds },
  });
  expect(playlist.ok(), 'seed a playlist').toBeTruthy();
  const playlistId = ((await playlist.json()) as { playlist: { id: string } }).playlist.id;

  const share = await request.post('/api/share', {
    headers,
    data: { resourceType: 'album', resourceId: album!.id },
  });
  expect(share.ok(), 'seed a share link').toBeTruthy();
  const shareToken = new URL(((await share.json()) as { url: string }).url).pathname
    .split('/')
    .pop()!;

  // One open poll (four action buttons, the #1807 repro) and one closed.
  const pollIds: string[] = [];
  let pollToken = '';
  for (const name of ['Encuesta de gusto abierta', 'Encuesta de gusto cerrada']) {
    const created = await request.post('/api/admin/radio-polls', {
      headers,
      data: { name, scenarioCount: 2, nextUpCount: 2 },
    });
    expect(created.status(), 'seed a radio poll').toBe(201);
    const body = (await created.json()) as { id: string; token: string };
    pollIds.push(body.id);
    pollToken ||= body.token;
  }
  const closed = await request.post(`/api/admin/radio-polls/${pollIds[1]}/close`, { headers });
  expect(closed.ok(), 'close the second poll').toBeTruthy();

  return {
    token,
    albumId: album!.id,
    artistId: artist!.id,
    playlistId,
    shareToken,
    pollIds,
    pollToken,
  };
}

/**
 * Open every collapsed settings group on the page, so its body renders. A DOM
 * click, not a pointer one: this spec measures layout, and a toggle that lands
 * under the fixed tab bar mid-reflow would only make it wait on actionability.
 */
async function expandAllGroups(page: Page): Promise<void> {
  const collapsed = page.locator('[data-testid="settings-group-toggle"][aria-expanded="false"]');
  // Each open re-renders the page below it; re-query rather than iterate a stale list.
  for (let guard = 0; guard < 40 && (await collapsed.count()) > 0; guard++) {
    await collapsed.first().evaluate((el: HTMLElement) => el.click());
  }
  await expect(collapsed).toHaveCount(0);
}

interface View {
  name: string;
  /** Path relative to the base URL. */
  path: (s: Seeded) => string;
  /** Something that proves the page rendered its content. */
  ready: (page: Page) => Promise<void>;
  /** Settings-style page: expand every group before measuring. */
  groups?: boolean;
  /** Outside the shell and public: opened without the admin session. */
  anonymous?: boolean;
  /** Extra states to measure after the first (tabs, …): each one is measured too. */
  states?: (page: Page) => AsyncGenerator<string>;
}

const h1 = (page: Page) => expect(page.locator('h1').first()).toBeVisible();

async function* libraryModes(page: Page): AsyncGenerator<string> {
  const tabs = page.getByTestId('library-tabs').locator('button[data-mode]');
  const modes = await tabs.evaluateAll((els) => els.map((e) => e.getAttribute('data-mode')!));
  expect(modes.length, 'library tabs').toBeGreaterThan(1);
  for (const mode of modes) {
    await page.getByTestId('library-tabs').locator(`button[data-mode="${mode}"]`).click();
    await expect(
      page.getByTestId('library-tabs').locator(`button[data-mode="${mode}"]`),
    ).toHaveAttribute('aria-current', 'true');
    await page.waitForTimeout(300);
    yield `library ${mode} tab`;
  }
}

const VIEWS: View[] = [
  { name: 'home', path: () => '/', ready: (p) => expect(p.locator('main')).toBeVisible() },
  {
    name: 'library',
    path: () => '/library',
    ready: (p) => expect(p.getByTestId('library-tabs')).toBeVisible(),
    states: libraryModes,
  },
  { name: 'album', path: (s) => `/library/albums/${s.albumId}`, ready: h1 },
  { name: 'artist', path: (s) => `/library/artists/${s.artistId}`, ready: h1 },
  {
    name: 'genre',
    path: () => `/library/genres/${encodeURIComponent(FIXTURE.genres.alpha.genre)}`,
    ready: h1,
  },
  { name: 'playlist', path: (s) => `/library/playlists/${s.playlistId}`, ready: h1 },
  { name: 'curate', path: () => '/library/curate', ready: h1 },
  {
    name: 'get add',
    path: () => '/get?tab=add',
    ready: (p) => expect(p.getByTestId('get-tabs')).toBeVisible(),
  },
  {
    name: 'get activity',
    path: () => '/get?tab=activity',
    ready: (p) => expect(p.getByTestId('get-tabs')).toBeVisible(),
  },
  { name: 'settings', path: () => '/settings', ready: h1, groups: true },
  { name: 'settings about', path: () => '/settings/about', ready: h1, groups: true },
  { name: 'settings devices', path: () => '/settings/devices', ready: h1, groups: true },
  { name: 'settings privacy', path: () => '/settings/privacy', ready: h1, groups: true },
  {
    name: 'settings recommendations',
    path: () => '/settings/recommendations',
    ready: h1,
    groups: true,
  },
  { name: 'settings agent tokens', path: () => '/settings/agent-tokens', ready: h1, groups: true },
  { name: 'settings subsonic', path: () => '/settings/subsonic', ready: h1, groups: true },
  { name: 'settings plugins', path: () => '/settings/plugins', ready: h1, groups: true },
  {
    name: 'admin',
    path: () => '/admin',
    ready: (p) => expect(p.getByTestId('settings-group-toggle').first()).toBeVisible(),
    groups: true,
  },
  {
    name: 'public poll',
    path: (s) => `/poll/${s.pollToken}`,
    ready: (p) => expect(p.locator('main, h1').first()).toBeVisible(),
    anonymous: true,
  },
  {
    name: 'public share',
    path: (s) => `/share/${s.shareToken}`,
    ready: (p) => expect(p.locator('h1, h2').first()).toBeVisible(),
    anonymous: true,
  },
  {
    name: 'login',
    path: () => '/login',
    ready: (p) => expect(p.getByRole('button').first()).toBeVisible(),
    anonymous: true,
  },
];

/** Measure the current state at every width, narrowest last so a reflow back is covered too. */
async function measureAtEveryWidth(page: Page, label: string): Promise<void> {
  for (const width of [...WIDTHS].reverse()) {
    await page.setViewportSize({ width, height: HEIGHT });
    // Let a resize-driven reflow (ResizeObserver, media queries) settle.
    await page.waitForTimeout(150);
    await expectNoHorizontalOverflow(page, `${label} at ${width}px`);
  }
}

test.describe('no horizontal overflow on a phone (#1807)', () => {
  // A page load per view and language, measured at three widths: well past
  // the default budget, but a single sequential pass over the app.
  test.describe.configure({ timeout: 120_000 });

  let seeded: Seeded;

  test.beforeAll(async ({ request }) => {
    seeded = await seed(request);
  });

  test.afterAll(async ({ request }) => {
    const headers = bearer(seeded.token);
    for (const id of seeded.pollIds)
      await request.delete(`/api/admin/radio-polls/${id}`, { headers });
    await request.delete(`/api/playlists/${seeded.playlistId}`, { headers });
  });

  for (const lang of LANGS) {
    for (const view of VIEWS) {
      test(`${view.name} (${lang})`, async ({ page, browser, baseURL }) => {
        let target = page;
        if (view.anonymous) {
          const ctx = await browser.newContext({ baseURL: baseURL ?? undefined });
          target = await ctx.newPage();
        }
        await target.setViewportSize({ width: WIDTHS[WIDTHS.length - 1], height: HEIGHT });
        await target.addInitScript((l) => localStorage.setItem('nicotind-lang', l), lang);
        await target.goto(view.path(seeded));
        await view.ready(target);
        if (view.groups) await expandAllGroups(target);
        // Lazy rows and covers land after the first paint.
        await target.waitForTimeout(500);
        await measureAtEveryWidth(target, `${view.name} (${lang})`);
        if (view.states) {
          for await (const state of view.states(target)) {
            await measureAtEveryWidth(target, `${state} (${lang})`);
          }
        }
        if (view.groups) await clearGroupState(target);
        if (view.anonymous) await target.context().close();
      });
    }
  }
});

/**
 * The guard (`[data-x-guard]`, overflow-x: clip) is the backstop: a row the sweep
 * has not met yet is clipped instead of sliding the page. Planted here, since the
 * sweep itself measures with the guard off.
 */
test.describe('the overflow-x guard (#1807)', () => {
  async function plantWideRow(page: Page, where: string): Promise<void> {
    await page.evaluate((selector) => {
      const guard = document.querySelector(selector)!;
      const row = document.createElement('div');
      row.setAttribute('data-testid', 'planted-wide-row');
      row.style.width = '2000px';
      row.style.height = '10px';
      guard.appendChild(row);
    }, where);
  }

  async function pageScrollOverflow(page: Page): Promise<number> {
    return page.evaluate(() =>
      [document.documentElement, document.body, document.querySelector('[data-scroll-root]')]
        .filter((el): el is Element => !!el)
        .reduce((max, el) => Math.max(max, el.scrollWidth - el.clientWidth), 0),
    );
  }

  test('a row wider than the page is clipped inside the shell, not scrolled', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: HEIGHT });
    await page.goto('/settings');
    await expect(page.locator('h1').first()).toBeVisible();
    await plantWideRow(page, '[data-scroll-root] > [data-x-guard]');
    expect(await pageScrollOverflow(page), 'the guard clips it').toBeLessThanOrEqual(1);
    // …and the sweep's measurement still sees it, because it switches the guard off.
    await expect(expectNoHorizontalOverflow(page, 'planted')).rejects.toThrow(/planted-wide-row/);
  });

  test('a row wider than the page is clipped on a page outside the shell', async ({
    browser,
    baseURL,
  }) => {
    const ctx = await browser.newContext({
      baseURL: baseURL ?? undefined,
      viewport: { width: 390, height: HEIGHT },
    });
    const page = await ctx.newPage();
    await page.goto('/login');
    await expect(page.getByRole('button').first()).toBeVisible();
    await plantWideRow(page, 'app-root > [data-x-guard]');
    expect(await pageScrollOverflow(page), 'the guard clips it').toBeLessThanOrEqual(1);
    await ctx.close();
  });
});
