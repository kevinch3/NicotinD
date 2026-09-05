/**
 * Genre radar (issue #222) — DOM coverage for the visualization, which the web
 * unit harness can't do (it cannot drive Angular signal inputs; see
 * genre-radar.component.spec.ts). The geometry and the component computeds are
 * unit-tested; this asserts the chart actually renders on the curation surface.
 *
 * The fixtures are silent FLACs with no genre tags, so the spec *creates* the
 * data it needs via a curator genre override (which runs a synchronous rescan).
 * Without that the chart legitimately hides and every assertion below would
 * vacuously pass.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN, FIXTURE, bearer, openAlbumCard } from '../helpers';

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

/** Give every track of the fixture artist a multi-genre set so the radar has real axes. */
async function seedGenres(request: APIRequestContext, note: string): Promise<string> {
  const jwt = await token(request);
  const artists = (await (
    await request.get('/api/library/artists', { headers: bearer(jwt) })
  ).json()) as Array<{ id: string; name: string }>;
  const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
  expect(artist, 'fixture artist must exist').toBeTruthy();

  const applied = await request.post(`/api/library/artists/${artist.id}/genre`, {
    headers: bearer(jwt),
    data: { genres: 'Folclore; Chacarera; Zamba', note },
  });
  expect(applied.ok()).toBe(true);
  return artist.id;
}

/**
 * Open the artist page and the genre-fix modal, synchronizing on the modal's own
 * loads rather than on a proxy for them (issue #905). Both of the modal's
 * one-shot GETs gate the assertions that follow — `/genre` feeds `loading()`,
 * which hides the whole panel body, and `/genre-distribution` feeds
 * `distribution()`, which the "before" radar is `@if`-gated on — and neither
 * retries on failure. Without a barrier both round trips had to land inside one
 * 5 s expect timeout, which they do not while the server is still busy with the
 * eager processing pass this spec's own genre POST kicks off: the first of these
 * two tests to run ate that window and failed at the radar assertion as
 * "element(s) not found", naming neither the fetch nor the data.
 */
async function openGenreModal(page: Page, artistId: string): Promise<void> {
  // Under the 30 s per-test budget, so a stalled fetch names the response it was
  // waiting on rather than dying as a bare test timeout (docs/e2e.md).
  const distribution = () =>
    page.waitForResponse(
      (r) => r.url().includes(`/artists/${artistId}/genre-distribution`) && r.ok(),
      { timeout: 10_000 },
    );

  // The artist page loads the same distribution for its read-only strip, so let
  // that one land before arming the modal's — otherwise it would satisfy the
  // barrier below while the modal's request was still in flight.
  const strip = distribution();
  await page.goto(`/library/artists/${artistId}`);
  await strip;

  const genre = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/artists/${artistId}/genre`) && r.request().method() === 'GET' && r.ok(),
    { timeout: 10_000 },
  );
  const charted = distribution();
  await page.getByTestId('artist-genre-fix').click();
  // Settled together: awaiting them in sequence leaves the loser rejecting
  // unawaited when the first one times out.
  const [, response] = await Promise.all([genre, charted]);

  // Separates the two failure classes the radar assertion used to merge: a slow
  // or failed fetch names the response above, empty data names this.
  const body = (await response.json()) as { slices: Array<{ genre: string }> };
  expect(body.slices, 'the seeded genres reached the distribution').toHaveLength(3);
}

test.describe('genre radar', () => {
  test('the artist genre-fix modal charts the genre spread with a value table', async ({
    page,
    request,
  }) => {
    const artistId = await seedGenres(request, 'e2e radar fixture');
    await openGenreModal(page, artistId);

    const radar = page.getByTestId('artist-genre-before').getByTestId('genre-radar');
    await expect(radar).toBeVisible();

    // Chart and its exact-value table always ship together: a radar distorts
    // magnitude, so the numbers must be readable beside it.
    await expect(radar.getByTestId('genre-radar-table')).toBeVisible();
    await expect(radar.locator('svg')).toHaveAttribute('role', 'img');
    await expect(radar.getByTestId('genre-radar-caption')).toContainText('past 100%');

    // One marker per genre axis, plus the value polygon over the ring grid.
    await expect(radar.locator('svg circle')).toHaveCount(3);
    await expect(radar.locator('svg polygon')).toHaveCount(5); // 4 rings + values

    // Every genre reaches the table.
    const rows = radar.locator('[data-testid="genre-radar-table"] tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('%');

    // The correction surface it sits inside still works.
    await expect(page.getByTestId('artist-genre-input')).toBeVisible();

    // --- Before/after projection (issue #222) -----------------------------
    // The append-vs-replace consequence (issue #260) must be visible BEFORE
    // Save: replace collapses the spread, append preserves it.
    const after = page.getByTestId('artist-genre-after');
    await page.getByTestId('artist-genre-input').fill('Folclore');

    await page.getByTestId('artist-genre-mode-replace').check();
    await expect(after).toBeVisible();
    // Exactly one axis survives a replace, and the drop is named outright.
    await expect(after.locator('svg circle')).toHaveCount(1);
    await expect(page.getByTestId('artist-genre-lost')).toContainText('Chacarera');

    await page.getByTestId('artist-genre-mode-append').check();
    // Append keeps all three and adds nothing to the lost list.
    await expect(after.locator('svg circle')).toHaveCount(3);
    await expect(page.getByTestId('artist-genre-lost')).toHaveCount(0);
  });
});

// The modal's panel is variable-height (both radar charts land async), so on a
// phone viewport with a track playing it used to overflow under the fixed
// mini-player + tab bar — the backdrop's one-shot inset measurement never saw
// the growth, and the unbounded centered panel clipped. The upgraded
// BottomChromeSafeDirective (ResizeObserver re-measure + --bottom-chrome-inset
// panel bound + m-auto centering) must keep the whole panel reachable.
test.describe('genre modal bottom-chrome geometry', () => {
  const PHONE = { width: 412, height: 915 }; // Pixel 7
  test.use({ viewport: PHONE });

  test('panel stays clear of the playing bottom chrome and keeps its top reachable', async ({
    page,
    request,
  }) => {
    const artistId = await seedGenres(request, 'e2e geometry fixture');

    // Start playback so the mini-player + tab bar chrome is actually present.
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title')).toBeVisible();

    await openGenreModal(page, artistId);
    await expect(page.getByTestId('artist-genre-before').getByTestId('genre-radar')).toBeVisible();
    // Render the "after" chart too — the panel's tallest state.
    await page.getByTestId('artist-genre-input').fill('Folclore');
    await expect(page.getByTestId('artist-genre-after')).toBeVisible();

    // Identify the topmost chrome layer, do not just measure it. The tab bar
    // carries `data-bottom-chrome` too and renders unconditionally at this
    // viewport (`md:hidden` does not apply at 412px), so it alone puts
    // chromeTop at ~859 < 915 — the old `toBeLessThan(PHONE.height)` guard was
    // satisfied whether or not the mini-player survived the artist-page
    // navigation above, and could therefore never fail for the reason it names.
    const chrome = await page.evaluate(() => {
      const layers = Array.from(document.querySelectorAll('[data-bottom-chrome]'))
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.height > 0 && rect.top < window.innerHeight);
      if (layers.length === 0) return { top: window.innerHeight, topIsPlayer: false, layers: 0 };
      const highest = layers.reduce((a, b) => (b.rect.top < a.rect.top ? b : a));
      return {
        top: highest.rect.top,
        topIsPlayer: highest.el.querySelector('[data-testid="player-title"]') !== null,
        layers: layers.length,
      };
    });
    expect(chrome.topIsPlayer, 'the mini-player is the topmost bottom chrome').toBe(true);
    const chromeTop = chrome.top;

    const panel = page.getByTestId('artist-genre-panel');
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.y, 'panel top on-screen').toBeGreaterThanOrEqual(0);
    expect(
      panelBox.y + panelBox.height,
      'panel bottom clears the mini-player/tab bar',
    ).toBeLessThanOrEqual(chromeTop + 1);

    // The last control is reachable by scrolling the panel itself.
    const save = page.getByTestId('artist-genre-save');
    await save.scrollIntoViewIfNeeded();
    const saveBox = (await save.boundingBox())!;
    expect(
      saveBox.y + saveBox.height,
      'save button visible above the chrome after scrolling',
    ).toBeLessThanOrEqual(chromeTop + 1);
  });
});
