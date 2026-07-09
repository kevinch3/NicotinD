import { test, expect } from '../playground/fixtures';
import { shot } from '../playground/shot';
import { appeared, firstPresent } from '../playground/screens-ui';

/**
 * Live mobile flow — Downloads & acquire. Walks the acquisition affordances on
 * the search page (Get-from-a-link box, watchlist star, archive.org lane) and
 * the three Downloads tabs (Active feed, Saved Offline storage bar, Recently
 * Added), capturing a screenshot per state under
 * screenshots/mobile/downloads-acquire/ and recording gated-state observations.
 *
 * Resilient by design: the SPA renders the acquire box only after `/api/plugins`
 * resolves and the lanes only after a search settles, so the flow WAITS on those
 * anchors before probing — a bare `count()` races the async render and yields
 * false "hidden/off" conclusions. The Downloads tab + storage-bar testids are
 * new (this branch); it falls back to the visible tab labels on older deploys.
 *
 * Read-mostly: the watchlist star is toggled on for the shot then reverted, so
 * no watchlist entry persists. The only persisting mutation — actually pasting a
 * URL to acquire — is gated behind PLAYGROUND_ACQUIRE_URL=<url>.
 */
const FLOW = 'downloads-acquire';
const ACQUIRE_URL = process.env.PLAYGROUND_ACQUIRE_URL;
const QUERY = process.env.PLAYGROUND_ACQUIRE_QUERY ?? 'El Cuarteto de Nos';

test('downloads & acquire — mobile screens', async ({ page, obs }) => {
  // 1) Search page — pasting a link renders the link-intent card. It only
  //    appears once plugin state loads and a resolve-capable plugin is
  //    enabled, so wait for it after submitting a recognizable URL.
  await page.goto('/');
  await expect(page.getByTestId('search-input')).toBeVisible();
  await page.getByTestId('search-input').fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByTestId('search-submit').click();
  const linkCard = page.getByTestId('link-intent-card');
  if (await appeared(linkCard, 8000)) {
    await linkCard.scrollIntoViewIfNeeded();
    await shot(page, FLOW, 1, 'link intent card', { settleMs: 300 });
  } else {
    obs.record({
      kind: 'gap',
      title: 'Link-intent card not shown despite resolve plugins',
      severity: 'medium',
      detail: 'No link-intent-card after 8s — expected when a resolve plugin (ytdlp/spotdl/archive) is enabled.',
      suggestion: 'Confirm PluginService.hasResolve gates SearchComponent.handleSearch; investigate if a resolve plugin is enabled but the card stays hidden.',
    });
    await shot(page, FLOW, 1, 'search idle', { settleMs: 300 });
  }

  // 2) Catalog search → wait for results, then toggle the watchlist star (and
  //    revert so no entry persists).
  await page.getByTestId('search-input').fill(QUERY);
  await page.getByTestId('search-submit').click();
  const star = page.getByTestId('watchlist-star');
  if (await appeared(star, 20_000)) {
    const first = star.first();
    await first.scrollIntoViewIfNeeded();
    await first.click().catch(() => {});
    await shot(page, FLOW, 2, 'watchlist star', { settleMs: 400 });
    await first.click().catch(() => {}); // revert — leave no watchlist entry
  } else {
    obs.record({
      kind: 'gap',
      title: 'No catalog cards for watchlist',
      severity: 'low',
      detail: `query="${QUERY}"`,
      suggestion: 'Catalog lookup returned no starrable cards for this query.',
    });
  }

  // 3) Blended Results list — archive.org/Spotify/Soulseek flow into ONE
  //    chip-labelled list (no separate "From archive.org" lane). Give it time to
  //    populate before concluding it's absent (don't infer "off").
  const results = page.getByTestId('results');
  if (await appeared(results, 12_000)) {
    await results.scrollIntoViewIfNeeded();
    await shot(page, FLOW, 3, 'blended results', { settleMs: 400 });
    obs.record({
      kind: 'metric',
      title: 'Blended result rows',
      value: await page.getByTestId('acquire-result').count(),
      unit: 'count',
      severity: 'info',
    });
    obs.record({
      kind: 'metric',
      title: 'Distinct source chips shown',
      value: await page.getByTestId('source-chip').count(),
      unit: 'count',
      severity: 'info',
    });
  } else {
    obs.record({
      kind: 'enhancement',
      title: 'Blended Results list not shown for this query',
      severity: 'low',
      detail: `query="${QUERY}" — needs ≥1 enabled source with a match (archive/Spotify/Soulseek).`,
      suggestion: 'Expected empty when no enabled source returns a match; verify a source plugin is enabled if results were expected.',
    });
  }

  // 4) Downloads → Active feed. Tab testids are new; fall back to the label.
  await page.goto('/downloads');
  const activeTab = await firstPresent(
    page.getByTestId('downloads-tab-active'),
    page.getByRole('button', { name: /^Active/ }),
  );
  if (activeTab) await appeared(activeTab, 8000);
  await shot(page, FLOW, 4, 'downloads active', { settleMs: 500 });
  const item = await firstPresent(page.getByTestId('download-item'));
  if (item) {
    await item.scrollIntoViewIfNeeded();
    await shot(page, FLOW, 5, 'download item', { settleMs: 300 });
    obs.record({
      kind: 'metric',
      title: 'Active download items',
      value: await page.getByTestId('download-item').count(),
      unit: 'count',
      severity: 'info',
    });
  }

  // 5) Saved Offline — storage bar + list (or empty state).
  const offlineTab = await firstPresent(
    page.getByTestId('downloads-tab-offline'),
    page.getByRole('button', { name: /Saved Offline/ }),
  );
  if (offlineTab) {
    await offlineTab.click();
    await page.waitForTimeout(400);
    const storage = await firstPresent(page.getByTestId('offline-storage-bar'));
    if (storage) await storage.scrollIntoViewIfNeeded();
    await shot(page, FLOW, 6, 'offline saved', { settleMs: 300 });
  }

  // 6) Recently Added.
  const recentTab = await firstPresent(
    page.getByTestId('downloads-tab-recent'),
    page.getByRole('button', { name: /Recently Added/ }),
  );
  if (recentTab) {
    await recentTab.click();
    await page.waitForTimeout(400);
    await shot(page, FLOW, 7, 'recently added', { settleMs: 300 });
  }

  // 7) Optional: paste a URL, click Get on the link-intent card, and capture
  //    the in-flight Active card.
  if (ACQUIRE_URL) {
    await page.goto('/');
    await page.getByTestId('search-input').fill(ACQUIRE_URL);
    await page.getByTestId('search-submit').click();
    const linkCard = page.getByTestId('link-intent-card');
    if (await appeared(linkCard, 8000)) {
      await linkCard.getByTestId('link-intent-get').click();
      await page.goto('/downloads');
      const tab = await firstPresent(
        page.getByTestId('downloads-tab-active'),
        page.getByRole('button', { name: /^Active/ }),
      );
      if (tab) await appeared(tab, 8000);
      await page.waitForTimeout(1500);
      await shot(page, FLOW, 8, 'acquire inflight', { settleMs: 500 });
    } else {
      obs.record({
        kind: 'degraded',
        title: 'Cannot acquire URL — card hidden',
        severity: 'medium',
        suggestion: 'Enable a resolve plugin to test URL acquisition.',
      });
    }
  }
});
