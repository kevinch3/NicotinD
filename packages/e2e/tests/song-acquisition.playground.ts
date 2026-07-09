import { test, expect, apiGet } from '../playground/fixtures';
import { catalogSearch, pollNetwork, unifiedSearch } from '../playground/flow-helpers';

/**
 * §F — Song/single acquisition gap. A user wants ONE song ("Toxic"). Records how
 * reachable that is: catalog is album-only, songs hide in raw folder file lists.
 * See docs/e2e-playground-findings-2026-06.md §F.
 */
const QUERY = process.env.PLAYGROUND_SONG_QUERY ?? 'Toxic Britney Spears';

test('song-acquisition (§F)', async ({ page, obs, apiToken }) => {
  await page.goto('/');
  await expect(page.getByTestId('search-input')).toBeVisible();
  const token = await apiToken();

  // 1. Unified search — local + network availability.
  let search;
  try {
    search = await obs.time('unified search latency', () => unifiedSearch(page, token, QUERY), {
      warnMs: 4000,
    });
  } catch (err) {
    obs.record({
      kind: 'error',
      title: 'Unified search threw',
      detail: String(err),
      severity: 'high',
    });
    return;
  }

  obs.record({
    kind: 'metric',
    title: 'Local song matches in library',
    value: search.local.songs.length,
    unit: 'count',
    severity: 'info',
  });

  // 2. Catalog (metadata) lane — confirm it is album-only.
  const catalog = await catalogSearch(page, token, QUERY);
  if (!catalog.ok) {
    obs.record({
      kind: 'degraded',
      title: 'Catalog lane unavailable (Lidarr unreachable)',
      detail: `status ${catalog.status}`,
      severity: 'info',
      suggestion: 'Point E2E_BASE_URL at a live stack with Lidarr for the full §F picture.',
    });
  } else {
    obs.record({
      kind: 'metric',
      title: 'Catalog album cards returned',
      value: catalog.albums.length,
      unit: 'count',
      severity: 'info',
      detail: `types: ${[...new Set(catalog.albums.map((a) => a.albumType))].join(', ') || 'none'}`,
    });
    obs.record({
      kind: 'gap',
      title: 'Catalog returns zero song/track results (album-only)',
      severity: 'high',
      suggestion:
        'The metadata lane has no recording lookup (Lidarr client exposes only artist/album). A song search can never resolve to a track here — see §F.',
    });
  }

  // 3. Network lane — the Songs lane (§F1) is now the song-first path: deduped
  //    rows, best copy auto-picked, one-click download. Verify it's there and
  //    measure how much it collapses the raw file list.
  if (search.networkAvailable) {
    const net = await pollNetwork(page, token, search.searchId, { timeoutMs: 20_000 });
    obs.record({
      kind: 'metric',
      title: 'Raw network files vs deduped songs',
      value: `${net.fileCount} files`,
      severity: 'info',
      detail: `${net.resultCount} peer responses`,
    });

    // §F1 — deduped, best-copy songs now flow into the blended Results list with
    // a "Soulseek" source chip (one-click Get), alongside any archive/Spotify hits.
    const hasResults = (await page.getByTestId('results').count()) > 0;
    const resultRows = await page.getByTestId('acquire-result').count();
    if (hasResults) {
      obs.record({
        kind: 'metric',
        title: 'Blended Results present (§F1 ✅)',
        value: `${resultRows} candidates`,
        unit: 'count',
        severity: 'info',
        detail: 'Source-agnostic: Soulseek best-copy + archive/Spotify, one-click Get.',
      });
    } else if (net.fileCount > 0) {
      obs.record({
        kind: 'gap',
        title: 'Network results present but no blended Results list rendered',
        severity: 'high',
        suggestion: 'The blended Results list did not render despite network files.',
      });
    }
  } else {
    obs.record({
      kind: 'degraded',
      title: 'Network search unavailable (slskd unreachable)',
      severity: 'info',
      suggestion: 'Acquisition flows need a live slskd — set E2E_BASE_URL.',
    });
  }

  // 4. UI affordance: the curated acquire path is the link-intent card that
  // appears in the search omnibox when a resolve plugin is enabled — never a
  // per-song control. Paste a harmless URL (non-mutating: only clicking Get
  // would submit) to check for it, then clear the box.
  await page.getByTestId('search-input').fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByTestId('search-submit').click();
  const hasUrlAcquire = (await page.getByTestId('link-intent-card').count()) > 0;
  await page.getByTestId('search-input').fill('');
  obs.record({
    kind: 'metric',
    title: 'Link-intent card present (resolve plugin enabled)',
    value: hasUrlAcquire ? 'yes' : 'no',
    severity: 'info',
  });

  // Light sanity (does not gate the report): the page rendered cover art, so the
  // auto net-monitor had a chance to catch thumbnail 404s.
  await apiGet(page, token, '/api/library/albums');
});
