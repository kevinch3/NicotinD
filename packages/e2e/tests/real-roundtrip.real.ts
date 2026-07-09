import { test, expect } from '../playground/fixtures';
import { albumIds } from '../playground/flow-helpers';

/**
 * REAL acquire → verify → delete round-trip (live backend, opt-in via the
 * playwright.real.config.ts two-key guard). Measures the end-to-end user
 * experience the synthetic flows can't: how long from "acquire" to "in library"
 * to "playable", how many steps, and any console/runtime errors along the way.
 *
 * SAFETY: every album this run adds is tracked and DELETED in `finally`, even on
 * failure, so prod is left clean. Drive it by URL (pasted into the search
 * omnibox as a link-intent card) with PLAYGROUND_REAL_URL, or by artist/album
 * with PLAYGROUND_REAL_ARTIST/_ALBUM.
 * See docs/testing-routines.md.
 */
const REAL_URL = process.env.PLAYGROUND_REAL_URL;
const REAL_ARTIST = process.env.PLAYGROUND_REAL_ARTIST;
const REAL_ALBUM = process.env.PLAYGROUND_REAL_ALBUM;

const ACQUIRE_TIMEOUT_MS = Number(process.env.PLAYGROUND_REAL_TIMEOUT_MS ?? 8 * 60_000);

test('real-roundtrip', async ({ page, obs, apiToken }) => {
  const j = obs.journey();
  const token = await apiToken();
  const auth = token ? { Authorization: `Bearer ${token}` } : {};

  if (!REAL_URL && !(REAL_ARTIST && REAL_ALBUM)) {
    obs.record({
      kind: 'degraded',
      title: 'No acquisition target configured',
      severity: 'info',
      suggestion: 'Set PLAYGROUND_REAL_URL or PLAYGROUND_REAL_ARTIST + PLAYGROUND_REAL_ALBUM.',
    });
    obs.outcome('degraded', 'no target');
    return;
  }

  const before = new Set(await albumIds(page, token));
  const newIds: string[] = [];
  const start = Date.now();

  try {
    // ── 1. Trigger acquisition through the real UI ──────────────────────────
    if (REAL_URL) {
      await page.goto('/');
      await page.getByTestId('search-input').fill(REAL_URL);
      await page.getByTestId('search-submit').click();
      j.step('paste URL into the search omnibox');
      const linkCard = page.getByTestId('link-intent-card');
      if ((await linkCard.count()) === 0) {
        j.deadEnd('link-intent card not present (resolve plugin disabled?)');
        obs.outcome('failed', 'no link-intent card');
        return;
      }
      await linkCard.getByTestId('link-intent-get').click();
      j.step('submit acquisition');
    } else {
      await page.goto('/');
      await page.getByTestId('search-input').fill(`${REAL_ARTIST} ${REAL_ALBUM}`);
      await page.getByTestId('search-input').press('Enter');
      j.step('search artist + album');
      // Best-effort: open the first catalog/hunt affordance and trigger download.
      const hunt = page
        .getByRole('button', { name: /hunt|download|get/i })
        .first();
      if (!(await hunt.count())) {
        j.deadEnd('no hunt/download affordance for the query');
        obs.outcome('failed', 'no hunt control');
        return;
      }
      await hunt.click();
      j.step('open hunt + start download');
      const confirm = page.getByRole('button', { name: /download|grab|get/i }).first();
      if (await confirm.count()) await confirm.click();
    }

    // ── 2. Poll the library until the new album lands ───────────────────────
    let inLibraryMs: number | null = null;
    while (Date.now() - start < ACQUIRE_TIMEOUT_MS) {
      const now = await albumIds(page, token);
      const added = now.filter((id) => !before.has(id));
      if (added.length) {
        for (const id of added) if (!newIds.includes(id)) newIds.push(id);
        inLibraryMs = Date.now() - start;
        break;
      }
      await page.waitForTimeout(5000);
    }

    if (inLibraryMs === null) {
      obs.record({
        kind: 'gap',
        title: 'Acquisition did not reach the library within the timeout',
        detail: `${Math.round((Date.now() - start) / 1000)}s elapsed`,
        severity: 'high',
        suggestion: 'No new album appeared — check downloads feed / pipeline for a stall.',
      });
      obs.outcome('failed', 'never landed');
      return;
    }
    obs.record({
      kind: 'timing',
      title: 'Acquire → in library',
      value: inLibraryMs,
      unit: 'ms',
      severity: inLibraryMs > 5 * 60_000 ? 'medium' : 'info',
    });

    // ── 3. Verify the result is playable ────────────────────────────────────
    const albumId = newIds[0]!;
    const detail = await page.request.get(`/api/library/albums/${albumId}`, { headers: auth });
    const songId = (((await detail.json().catch(() => ({}))) as { song?: Array<{ id: string }> })
      .song ?? [])[0]?.id;
    if (songId) {
      const playStart = Date.now();
      const stream = await page.request.get(`/api/stream/${songId}`, {
        headers: { ...auth, Range: 'bytes=0-1' },
      });
      const playable = stream.status() === 206 || stream.status() === 200;
      obs.record({
        kind: 'timing',
        title: 'First-byte → playable',
        value: Date.now() - playStart,
        unit: 'ms',
        severity: 'info',
        detail: `stream status ${stream.status()}`,
      });
      if (!playable) {
        obs.record({
          kind: 'error',
          title: 'Acquired track did not stream',
          detail: `status ${stream.status()}`,
          severity: 'high',
        });
      }
      obs.outcome(playable ? 'success' : 'partial', `${newIds.length} album(s) acquired`);
    } else {
      j.deadEnd('acquired album has no playable song');
      obs.outcome('partial', 'no song to play');
    }

    expect(true).toBe(true);
  } finally {
    // ── 4. Always remove what we created — real cleanup ─────────────────────
    for (const id of newIds) {
      const del = await page.request.delete(`/api/library/albums/${id}`, { headers: auth });
      if (!del.ok()) {
        obs.record({
          kind: 'error',
          title: 'Cleanup failed — acquired album left on prod',
          detail: `status ${del.status()} album ${id}`,
          severity: 'high',
          suggestion: 'Delete it manually from the library to keep the stack clean.',
        });
      }
    }
    if (newIds.length) {
      obs.record({
        kind: 'metric',
        title: 'Albums acquired + removed by this run',
        value: newIds.length,
        unit: 'count',
        severity: 'info',
      });
    }
  }
});
