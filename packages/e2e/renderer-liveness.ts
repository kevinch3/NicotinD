/**
 * Says whether a page's renderer still answers, for a failed test's report
 * (#1185, docs/e2e.md "wedged renderer").
 */

export type RendererVerdict = 'alive' | 'wedged' | 'closed';

/** The slice of Playwright's `Page` the probe needs. */
export interface ProbeTarget {
  isClosed(): boolean;
  evaluate<T>(fn: () => T): Promise<T>;
}

/** Long enough for a busy renderer to answer, short enough to fit in teardown. */
export const RENDERER_PROBE_TIMEOUT_MS = 3_000;

/**
 * Race a trivial `evaluate` against a timeout. A renderer that is merely busy
 * answers late; one that never answers inside the budget is reported `wedged`.
 */
export async function probeRenderer(
  page: ProbeTarget,
  timeoutMs = RENDERER_PROBE_TIMEOUT_MS,
): Promise<RendererVerdict> {
  if (page.isClosed()) return 'closed';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RendererVerdict>((resolve) => {
    timer = setTimeout(() => resolve('wedged'), timeoutMs);
  });
  const answer = page
    .evaluate(() => 1)
    .then(
      (): RendererVerdict => 'alive',
      (): RendererVerdict => (page.isClosed() ? 'closed' : 'wedged'),
    );
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The attachment body a failed test carries. */
export function livenessReport(verdict: RendererVerdict, url: string, timeoutMs: number): string {
  const meaning: Record<RendererVerdict, string> = {
    alive: 'The renderer answered, so this failure is not a wedged renderer.',
    wedged: `The renderer did not answer a trivial evaluate within ${timeoutMs} ms. This is the #1185 signature: an app defect, not a slow spec.`,
    closed: 'The page was already closed when the probe ran, so liveness is unknown.',
  };
  return `renderer: ${verdict}\nurl: ${url}\n${meaning[verdict]}\n`;
}

/**
 * A GitHub Actions `::warning` line for a wedged renderer, or null when not
 * running there.
 *
 * CI retries a failed test once, and a retry that passes leaves the run green.
 * The report (and its `renderer-liveness` attachment) is uploaded only for a
 * failed run, so a one-off wedge would never be seen. An annotation shows on
 * a green run's summary too.
 */
export function wedgeAnnotation(
  testTitle: string,
  url: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!env.GITHUB_ACTIONS) return null;
  // Workflow-command escaping: the message may not carry a raw newline or `%`.
  const message = `${testTitle} at ${url}`
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  return `::warning title=Wedged renderer (#1185)::${message}`;
}
