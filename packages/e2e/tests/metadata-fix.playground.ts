import { test } from '../playground/fixtures';
import { metadataCandidates, firstAlbumId } from '../playground/flow-helpers';

/**
 * §G — User-driven metadata fix quality. For an album (the first in the library,
 * or `PLAYGROUND_FIX_ALBUM`), how good are the candidates the fix modal surfaces
 * for a given query? Records candidate count + top-candidate score, and flags a
 * gap when an editable query returns nothing (the "known band, no match" case
 * that motivated this feature). Degrades gracefully on a dead/Lidarr-less backend.
 */
const QUERY = process.env.PLAYGROUND_FIX_QUERY ?? '';

test('metadata-fix candidates (§G)', async ({ page, obs, apiToken }) => {
  await page.goto('/');
  const token = await apiToken();

  const albumId = process.env.PLAYGROUND_FIX_ALBUM ?? (await firstAlbumId(page, token));
  if (!albumId) {
    obs.record({
      kind: 'degraded',
      title: 'No album to fix (empty library / backend down)',
      severity: 'info',
      suggestion: 'Point E2E_BASE_URL at a live stack with a scanned library.',
    });
    return;
  }

  const res = await obs.time('metadata-candidates latency', () =>
    metadataCandidates(page, token, albumId, QUERY || undefined),
  );

  if (!res.ok) {
    obs.record({
      kind: 'degraded',
      title: 'Metadata candidates unavailable (Lidarr unreachable / not admin)',
      detail: `status ${res.status}`,
      severity: 'info',
      suggestion: 'Needs a live Lidarr + admin token to evaluate fix candidates.',
    });
    return;
  }

  const top = res.candidates[0];
  obs.record({
    kind: 'metric',
    title: 'Candidates returned for the fix query',
    value: `${res.candidates.length}`,
    detail: `query: "${res.query}"`,
    severity: res.candidates.length === 0 ? 'medium' : 'info',
  });
  if (top) {
    obs.record({
      kind: 'metric',
      title: 'Top candidate confidence',
      value: `${top.score}`,
      unit: '%',
      detail: `${top.artist} — ${top.title}`,
      severity: top.score < 50 ? 'medium' : 'info',
    });
  } else {
    obs.record({
      kind: 'gap',
      title: 'Editable query returned 0 candidates (G1)',
      severity: 'medium',
      detail: `query: "${res.query}"`,
      suggestion:
        'The user can still fix via free-text, but a known release should ideally surface — consider broadening the lookup.',
    });
  }
});
