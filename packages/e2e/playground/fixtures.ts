/**
 * Playground test fixtures. Extends the base Playwright `test` with:
 *   - `obs`   — a recorder that pushes observations as annotations (the reporter
 *               turns them into the findings report).
 *   - automatic cover-art-404 / server-error / slow-call monitoring via
 *     `page.on('response')` → `classifyResponse`.
 *   - `apiToken` — pulls the JWT the SPA stored in localStorage for direct API
 *     calls (the app authenticates with a bearer token, not cookies).
 *
 * Flows record rather than fail: a missing backend yields a `degraded`
 * observation, never a red test, so the report is always produced.
 */
import { test as base, type Page, type TestInfo } from '@playwright/test';
import {
  ANNOTATION_TYPE,
  encodeObservation,
  type Observation,
} from './observe.js';
import { classifyResponse } from './net-monitor.js';

export interface Recorder {
  /** Record a single observation. `flow` defaults to the current test title. */
  record(o: Omit<Observation, 'flow'> & { flow?: string }): void;
  /** Time an async step and record a `timing` observation. Returns the result. */
  time<T>(title: string, fn: () => Promise<T>, opts?: { warnMs?: number }): Promise<T>;
}

function makeRecorder(testInfo: TestInfo, flow: string): Recorder {
  const push = (o: Observation) =>
    testInfo.annotations.push({ type: ANNOTATION_TYPE, description: encodeObservation(o) });
  return {
    record(o) {
      push({ ...o, flow: o.flow ?? flow });
    },
    async time(title, fn, opts) {
      const start = Date.now();
      const result = await fn();
      const ms = Date.now() - start;
      const warnMs = opts?.warnMs ?? 5000;
      push({
        flow,
        kind: 'timing',
        title,
        value: ms,
        unit: 'ms',
        severity: ms >= warnMs * 2 ? 'medium' : ms >= warnMs ? 'low' : 'info',
        suggestion: ms >= warnMs ? 'Slower than the expected interactive budget.' : undefined,
      });
      return result;
    },
  };
}

export const test = base.extend<{ obs: Recorder; apiToken: () => Promise<string | null> }>({
  obs: async ({ page }, use, testInfo) => {
    const flow = testInfo.title;
    const recorder = makeRecorder(testInfo, flow);

    // Auto-monitor responses for cover 404s / server errors. Dedupe by label so a
    // grid of broken thumbnails collapses to one report line (with a count).
    const seen = new Map<string, number>();
    page.on('response', (res) => {
      const o = classifyResponse({ url: res.url(), status: res.status(), flow });
      if (!o) return;
      const key = `${o.title}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n === 1) recorder.record(o);
    });

    await use(recorder);

    // After the flow, fold the repeat-count into a metric so the report shows
    // *how many* thumbnails 404'd, not just that one did.
    for (const [title, n] of seen) {
      if (n > 1) {
        recorder.record({
          kind: 'metric',
          title: `${title} (occurrences)`,
          value: n,
          unit: 'count',
          severity: 'info',
        });
      }
    }
  },

  apiToken: async ({ page }, use) => {
    const get = async () =>
      page.evaluate(() => window.localStorage.getItem('nicotind_token'));
    await use(get);
  },
});

export const expect = test.expect;

/** Convenience: authorized API GET via the page's request context + stored JWT. */
export async function apiGet(
  page: Page,
  token: string | null,
  path: string,
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const res = await page.request.get(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { ok: res.ok(), status: res.status(), json: () => res.json() };
}
