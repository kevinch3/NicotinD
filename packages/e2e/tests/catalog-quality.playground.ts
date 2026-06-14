import { test, expect } from '../playground/fixtures';
import { catalogSearch } from '../playground/flow-helpers';

/**
 * §A — Catalog search quality. For a non-distinctive artist, how many returned
 * album cards actually belong to the matched artist vs mashups/tributes? Records
 * the own-album ratio (A1) and any empty/disjoint result (A1/A2).
 * See docs/e2e-playground-findings-2026-06.md §A.
 */
const ARTIST = process.env.PLAYGROUND_ARTIST ?? 'Zara Larsson';

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

test('catalog-quality (§A)', async ({ page, obs, apiToken }) => {
  await page.goto('/');
  await expect(page.getByTestId('search-input')).toBeVisible();
  const token = await apiToken();

  const catalog = await obs.time('catalog search latency', () =>
    catalogSearch(page, token, ARTIST),
  );

  if (!catalog.ok) {
    obs.record({
      kind: 'degraded',
      title: 'Catalog lane unavailable (Lidarr unreachable)',
      detail: `status ${catalog.status}`,
      severity: 'info',
      suggestion: 'Set E2E_BASE_URL to a live stack with Lidarr.',
    });
    return;
  }

  const artistNames = new Set(catalog.artists.map((a) => normalize(a.name)));
  const matchedArtist = artistNames.has(normalize(ARTIST));
  const own = catalog.albums.filter((a) => artistNames.has(normalize(a.artistName)));
  const ratio = catalog.albums.length ? Math.round((own.length / catalog.albums.length) * 100) : 0;

  obs.record({
    kind: 'metric',
    title: 'Matched artist appears in artist pills',
    value: matchedArtist ? 'yes' : 'no',
    severity: matchedArtist ? 'info' : 'medium',
  });
  obs.record({
    kind: 'metric',
    title: 'Album cards belonging to the matched artist',
    value: `${own.length}/${catalog.albums.length}`,
    unit: `(${ratio}%)`,
    severity: ratio < 50 ? 'high' : ratio < 80 ? 'medium' : 'info',
  });

  if (catalog.albums.length > 0 && own.length === 0) {
    obs.record({
      kind: 'gap',
      title: 'All album cards are disjoint from the matched artist (A1)',
      severity: 'high',
      detail: `e.g. "${catalog.albums[0].title}" by "${catalog.albums[0].artistName}"`,
      suggestion:
        'Drive album cards from the matched artist discography (listByArtist) instead of the global album.lookup.',
    });
  } else if (matchedArtist && own.length === 0) {
    obs.record({
      kind: 'gap',
      title: 'Artist matched but their discography is empty (A1 deeper case)',
      severity: 'high',
      suggestion: 'Needs an artist-scoped Lidarr lookup when their releases miss the global lookup.',
    });
  }
});
