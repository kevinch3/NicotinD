/**
 * The artist page's tab row on a phone (#1636, docs/web-ui.md).
 *
 * The discography summary used to sit inside the tablist's flex row: at 390px it
 * squeezed into a 4-line block beside the tabs and wrapped "Singles & EPs" onto
 * two lines, and every label in the row rendered English in a Spanish UI.
 *
 * The discography and appears-on reads are stubbed so the row carries all four
 * tabs and a summary — the widest it gets. A real Lidarr answer would make the
 * tab set depend on what the fixture Lidarr happens to know.
 */
import { test, expect, type APIRequestContext, type Page } from '../helpers';
import { ADMIN, FIXTURE, bearer } from '../helpers';

const PHONE = { width: 390, height: 844 }; // iPhone 14
const DESKTOP = { width: 1280, height: 800 };

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

const release = (over: Record<string, unknown>) => ({
  foreignAlbumId: `mb-${String(over['lidarrId'])}`,
  albumType: 'Album',
  secondaryTypes: [] as string[],
  totalTracks: 10,
  localTrackCount: 0,
  status: 'missing',
  tracks: [] as unknown[],
  ...over,
});

async function openArtistPage(page: Page, request: APIRequestContext): Promise<void> {
  const jwt = await token(request);
  const artists = (await (
    await request.get('/api/library/artists', { headers: bearer(jwt) })
  ).json()) as Array<{ id: string; name: string }>;
  const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
  expect(artist, 'fixture artist must exist').toBeTruthy();
  const detail = (await (
    await request.get(`/api/library/artists/${artist.id}`, { headers: bearer(jwt) })
  ).json()) as { albums: unknown[] };

  await page.route(`**/api/discography/artists/${artist.id}`, (route) =>
    route.fulfill({
      json: {
        artistId: artist.id,
        lidarrId: 9,
        mbid: 'mb',
        albums: [
          release({ lidarrId: 1, title: 'Missing Studio Album', releaseDate: '2020-01-01' }),
          release({ lidarrId: 2, title: 'Missing Live Album', secondaryTypes: ['Live'] }),
          release({ lidarrId: 4, title: 'Missing Live Encore', secondaryTypes: ['Live'] }),
          release({ lidarrId: 3, title: 'Missing EP', albumType: 'EP' }),
        ],
      },
    }),
  );
  // One compilation appearance, so the Appears On tab joins the row.
  await page.route(`**/api/library/artists/${artist.id}/appears-on`, (route) =>
    route.fulfill({ json: detail.albums.slice(0, 1) }),
  );

  await page.goto(`/library/artists/${artist.id}`);
  await expect(page.getByTestId('discography-summary')).toBeVisible();
  await expect(page.getByTestId('artist-tab-appears-on')).toBeVisible();
}

/** Every tab on one line, none wrapped, the strip inside the viewport. */
async function expectTabsOnOneLine(page: Page, viewportWidth = PHONE.width): Promise<void> {
  const tabs = page.getByRole('tablist').getByRole('tab');
  await expect(tabs).toHaveCount(4);
  const boxes = await tabs.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      const label = document.createRange();
      label.selectNodeContents(el);
      return {
        top: Math.round(r.top),
        right: r.right,
        // A label that wraps paints more than one line box.
        lines: Math.round(label.getBoundingClientRect().height / lineHeight),
      };
    }),
  );
  for (const b of boxes) expect(b.lines, 'a tab label wrapped').toBe(1);
  expect(new Set(boxes.map((b) => b.top)).size, 'tabs share one row').toBe(1);
  const strip = await page
    .getByRole('tablist')
    .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(strip.scroll, 'the tab strip overflows its row').toBeLessThanOrEqual(strip.client);
  expect(Math.max(...boxes.map((b) => b.right))).toBeLessThanOrEqual(viewportWidth);
}

test.describe('artist tab row on a phone (#1636)', () => {
  test.use({ viewport: PHONE });

  test('keeps the tabs on one line with the summary below them', async ({ page, request }) => {
    await openArtistPage(page, request);
    await expectTabsOnOneLine(page);

    // The summary is its own line under the strip, not a column beside it.
    const tablist = (await page.getByRole('tablist').boundingBox())!;
    const summary = (await page.getByTestId('discography-summary').boundingBox())!;
    expect(summary.y, 'summary sits below the tabs').toBeGreaterThanOrEqual(
      tablist.y + tablist.height - 1,
    );
    expect(summary.x).toBeLessThanOrEqual(tablist.x + 1);
    // The tablist holds tabs only — the summary is not one of its children.
    await expect(page.getByRole('tablist').getByTestId('discography-summary')).toHaveCount(0);
  });

  test('renders the row, the tiles and the toggle in Spanish', async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem('nicotind-lang', 'es'));
    await openArtistPage(page, request);

    await expect(page.getByTestId('artist-tab-albums')).toHaveText('Álbumes');
    await expect(page.getByTestId('artist-tab-singles')).toHaveText('Sencillos y EP');
    await expect(page.getByTestId('artist-tab-appears-on')).toHaveText('Aparece en');
    await expect(page.getByTestId('artist-tab-songs')).toHaveText('Canciones');
    await expect(page.getByTestId('discography-summary')).toHaveText(
      '4 lanzamientos · 0 completos · 0 parciales · 4 faltan · vía MusicBrainz',
    );
    await expect(page.getByTestId('album-tile-action').first()).toHaveText('Obtener álbum');
    await expect(page.getByTestId('toggle-all-releases')).toHaveText('Mostrar 2 lanzamientos más');
    // A key that failed to resolve renders as its dotted key — assert none leak.
    await expect(page.locator('body')).not.toContainText('artist.tab.');
    await expect(page.locator('body')).not.toContainText('albumTile.');

    // Spanish labels are the longer set — they must fit on one line too.
    await expectTabsOnOneLine(page);
  });
});

test.describe('artist tab row on a desktop (#1636)', () => {
  test.use({ viewport: DESKTOP });

  test('keeps the summary inline, right-aligned beside the tabs', async ({ page, request }) => {
    await openArtistPage(page, request);
    await expectTabsOnOneLine(page, DESKTOP.width);

    const row = (await page.getByTestId('artist-tab-row').boundingBox())!;
    const tablist = (await page.getByRole('tablist').boundingBox())!;
    const lastTab = (await page.getByRole('tablist').getByRole('tab').last().boundingBox())!;
    const summary = (await page.getByTestId('discography-summary').boundingBox())!;
    // Same row: the summary starts above the tablist's bottom edge, not under it.
    expect(summary.y, 'summary dropped under the tabs').toBeLessThan(tablist.y + tablist.height);
    expect(summary.x, 'summary overlaps the tabs').toBeGreaterThan(lastTab.x + lastTab.width);
    // Right-aligned: it ends at the row's right edge (md:ml-auto).
    expect(Math.abs(summary.x + summary.width - (row.x + row.width))).toBeLessThanOrEqual(1);
  });
});
