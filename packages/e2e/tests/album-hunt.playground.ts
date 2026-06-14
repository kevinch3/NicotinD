import { test, expect } from '../playground/fixtures';
import { catalogSearch } from '../playground/flow-helpers';

/**
 * §C — Album hunt latency & outcome. Times base/skew phases and records the
 * candidate count / dead-end (C1: 0 folder candidates with loose tracks present).
 *
 * GATED: resolve adds a monitored artist to Lidarr (a mutation), so this flow is
 * opt-in via PLAYGROUND_HUNT=1. It NEVER triggers a download (hunt-download).
 * See docs/e2e-playground-findings-2026-06.md §C.
 */
const ARTIST = process.env.PLAYGROUND_HUNT_ARTIST ?? 'Los Chalchaleros';
const ALBUM = process.env.PLAYGROUND_HUNT_ALBUM ?? '';
const ENABLED = process.env.PLAYGROUND_HUNT === '1';

interface HuntResponse {
  candidates?: unknown[];
  skewNeeded?: boolean;
  totalTracks?: number;
}

test('album-hunt latency/outcome (§C)', async ({ page, obs, apiToken }) => {
  await page.goto('/');
  await expect(page.getByTestId('search-input')).toBeVisible();
  const token = await apiToken();

  if (!ENABLED) {
    obs.record({
      kind: 'degraded',
      title: 'Hunt flow skipped (opt-in: adds a monitored artist to Lidarr)',
      severity: 'info',
      suggestion: 'Run with PLAYGROUND_HUNT=1 against a live stack to gather §C latency/outcome.',
    });
    return;
  }

  const catalog = await catalogSearch(page, token, ALBUM ? `${ARTIST} ${ALBUM}` : ARTIST);
  if (!catalog.ok || catalog.albums.length === 0) {
    obs.record({
      kind: 'degraded',
      title: 'No catalog album to hunt (Lidarr unreachable or empty)',
      detail: `status ${catalog.status}`,
      severity: 'info',
    });
    return;
  }

  const card =
    (ALBUM &&
      catalog.albums.find((a) => a.title.toLowerCase().includes(ALBUM.toLowerCase()))) ||
    catalog.albums[0];

  // Resolve (mutating) → real Lidarr album id.
  const resolveRes = await page.request.post('/api/catalog/resolve', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    data: {
      foreignAlbumId: (card as { foreignAlbumId?: string }).foreignAlbumId,
      artistMbid: (card as { artistMbid?: string }).artistMbid,
      artistName: (card as { artistName?: string }).artistName,
      albumTitle: card.title,
    },
  });
  if (!resolveRes.ok()) {
    obs.record({
      kind: 'gap',
      title: 'Catalog resolve failed for a returned card (A2)',
      detail: `status ${resolveRes.status()} for "${card.title}"`,
      severity: resolveRes.status() >= 500 ? 'high' : 'medium',
    });
    return;
  }
  const { lidarrAlbumId } = (await resolveRes.json()) as { lidarrAlbumId: number };

  const huntPost = async (phase: 'base' | 'skew') => {
    const res = await page.request.post(
      `/api/discography/albums/${lidarrAlbumId}/hunt/${phase}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        data: { artistName: card.artistName, albumTitle: card.title, skewSearch: true },
      },
    );
    return (await res.json().catch(() => ({}))) as HuntResponse;
  };

  const base = await obs.time('hunt base latency', () => huntPost('base'), { warnMs: 15_000 });
  const baseCount = base.candidates?.length ?? 0;
  obs.record({
    kind: 'metric',
    title: 'Hunt base candidates',
    value: baseCount,
    unit: 'count',
    severity: 'info',
    detail: `${base.totalTracks ?? '?'} canonical tracks`,
  });

  let totalCount = baseCount;
  if (base.skewNeeded) {
    const skew = await obs.time('hunt skew latency', () => huntPost('skew'), { warnMs: 15_000 });
    totalCount += skew.candidates?.length ?? 0;
    obs.record({
      kind: 'metric',
      title: 'Hunt skew candidates',
      value: skew.candidates?.length ?? 0,
      unit: 'count',
      severity: 'info',
    });
  }

  if (totalCount === 0) {
    obs.record({
      kind: 'gap',
      title: 'Hunt dead-ends with 0 folder candidates (C1)',
      severity: 'medium',
      suggestion:
        'When a folder hunt finds nothing, offer a per-track "grab N loose tracks" fallback (reuse AlbumFallbackService.searchBestForTrack) — ties into §F2 track hunter.',
    });
  }
});
