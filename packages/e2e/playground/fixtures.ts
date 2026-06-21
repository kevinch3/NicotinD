/**
 * Playground test fixtures. Extends the base Playwright `test` with:
 *   - `obs`   — a recorder that pushes observations as annotations (the reporter
 *               turns them into the findings report). Also exposes `journey()`
 *               (friction / step-count) and `outcome()` (terminal success).
 *   - automatic monitoring of:
 *       · HTTP responses    via `page.on('response')` → `classifyResponse`
 *       · console errors    via `page.on('console')`  → `classifyConsoleMessage`
 *       · uncaught errors   via `page.on('pageerror')` → `classifyPageError`
 *       · failed requests   via `page.on('requestfailed')` → `classifyRequestFailure`
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
import {
  classifyConsoleMessage,
  classifyPageError,
  classifyRequestFailure,
} from './console-monitor.js';
import { Journey, type Outcome, outcomeObservation } from './journey.js';

export interface Recorder {
  /** Record a single observation. `flow` defaults to the current test title. */
  record(o: Omit<Observation, 'flow'> & { flow?: string }): void;
  /** Time an async step and record a `timing` observation. Returns the result. */
  time<T>(title: string, fn: () => Promise<T>, opts?: { warnMs?: number }): Promise<T>;
  /**
   * Start a friction journey for this flow. Build it with `step/fallback/deadEnd`;
   * its `summarize()` observations are auto-flushed when the flow ends.
   */
  journey(flow?: string): Journey;
  /** Record the flow's terminal success outcome (feeds the report Outcome matrix). */
  outcome(outcome: Outcome, detail?: string): void;
}

function makeRecorder(testInfo: TestInfo, flow: string, journeys: Journey[]): Recorder {
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
    journey(f) {
      const j = new Journey(f ?? flow);
      journeys.push(j);
      return j;
    },
    outcome(outcome, detail) {
      push(outcomeObservation(flow, outcome, detail));
    },
  };
}

export const test = base.extend<{ obs: Recorder; apiToken: () => Promise<string | null> }>({
  obs: async ({ page }, use, testInfo) => {
    const flow = testInfo.title;
    const journeys: Journey[] = [];
    const recorder = makeRecorder(testInfo, flow, journeys);

    // Auto-monitor responses + console + page errors. Dedupe by label so a grid
    // of broken thumbnails (or a repeated console error) collapses to one report
    // line, with the repeat count folded into a metric at teardown.
    const seen = new Map<string, number>();
    const record = (o: Observation | null) => {
      if (!o) return;
      const n = (seen.get(o.title) ?? 0) + 1;
      seen.set(o.title, n);
      if (n === 1) recorder.record(o);
    };

    page.on('response', (res) => record(classifyResponse({ url: res.url(), status: res.status(), flow })));
    page.on('console', (msg) => record(classifyConsoleMessage({ type: msg.type(), text: msg.text(), flow })));
    page.on('pageerror', (err) => record(classifyPageError({ message: err.message, flow })));
    page.on('requestfailed', (req) =>
      record(classifyRequestFailure({ url: req.url(), errorText: req.failure()?.errorText, flow })),
    );

    await use(recorder);

    // Flush friction journeys the flow built.
    for (const j of journeys) for (const o of j.summarize()) recorder.record(o);

    // Fold repeat-counts into a metric so the report shows *how many* times a
    // 404 / console error recurred, not just that it did once.
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
    // Defensive: localStorage is only readable once a page on the app origin has
    // loaded. Returning null (instead of throwing) means a flow that reads the
    // token before navigating degrades rather than hard-failing the run.
    const get = async () =>
      page.evaluate(() => window.localStorage.getItem('nicotind_token')).catch(() => null);
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
