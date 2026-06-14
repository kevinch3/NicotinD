import { test, expect } from '../playground/fixtures';
import { pollNetwork, unifiedSearch } from '../playground/flow-helpers';

/**
 * §C2 — Network search responsiveness. Time-to-first-result vs time-to-complete
 * for a niche query: peers often respond in ~5 s but the UI only surfaces results
 * at completion (~25 s). Records both timings + result counts.
 * See docs/e2e-playground-findings-2026-06.md §C2.
 */
const QUERY = process.env.PLAYGROUND_NETWORK_QUERY ?? 'Los Chalchaleros';

test('network-search responsiveness (§C2)', async ({ page, obs, apiToken }) => {
  await page.goto('/');
  await expect(page.getByTestId('search-input')).toBeVisible();
  const token = await apiToken();

  const search = await unifiedSearch(page, token, QUERY);
  if (!search.networkAvailable) {
    obs.record({
      kind: 'degraded',
      title: 'Network search unavailable (slskd unreachable)',
      severity: 'info',
      suggestion: 'Set E2E_BASE_URL to a live stack with slskd.',
    });
    return;
  }

  const net = await pollNetwork(page, token, search.searchId, { timeoutMs: 30_000 });

  obs.record({
    kind: 'timing',
    title: 'Time to first network result',
    value: net.firstResultMs ?? -1,
    unit: 'ms',
    severity: (net.firstResultMs ?? 0) > 8000 ? 'medium' : 'info',
  });
  obs.record({
    kind: 'timing',
    title: 'Time to network search complete',
    value: net.completeMs ?? -1,
    unit: 'ms',
    severity: (net.completeMs ?? 0) > 20_000 ? 'medium' : 'info',
  });
  obs.record({
    kind: 'metric',
    title: 'Network results',
    value: `${net.resultCount} responses / ${net.fileCount} files`,
    severity: 'info',
  });

  // The C2 signal: a wide gap between first-result and complete means the user
  // stares at "Searching…" long after peers actually answered.
  if (net.firstResultMs !== null && net.completeMs !== null) {
    const gap = net.completeMs - net.firstResultMs;
    if (gap > 10_000) {
      obs.record({
        kind: 'enhancement',
        title: 'Large first-result → complete gap — stream partial results (C2)',
        value: gap,
        unit: 'ms',
        severity: 'medium',
        suggestion: 'Surface results as peers respond instead of gating the UI on state:complete.',
      });
    }
  }
});
