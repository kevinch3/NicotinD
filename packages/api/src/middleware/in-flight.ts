import { createMiddleware } from 'hono/factory';

/**
 * Tracks which requests are currently inside a handler, so a blocked event
 * loop can be attributed to one (#1058).
 *
 * The loop monitor can only say "the process stopped for 204 s"; without this
 * it cannot say which request did it, which is exactly the gap that made #1055
 * read as "the container is unhealthy" instead of "this query is quadratic".
 *
 * A `Set` of live entries, not a counter: the blocking request is still in
 * flight when the loop comes back (its handler has not returned yet), so it is
 * the one still in the set.
 */
const live = new Set<{ label: string; startedAt: number }>();

/** Labels of the requests currently in a handler, longest-running first. */
export function inFlightRequests(): string[] {
  return [...live]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((e) => `${e.label} (${Math.round(performance.now() - e.startedAt)}ms)`);
}

/**
 * Records the request for the duration of the handler. The path is the
 * *matched route* plus the query string's parameter names — never their
 * values, which can carry library content into the logs.
 */
export function trackInFlight() {
  return createMiddleware(async (c, next) => {
    const url = new URL(c.req.url);
    const keys = [...new Set(url.searchParams.keys())].sort();
    const label = `${c.req.method} ${url.pathname}${keys.length ? `?${keys.join('&')}` : ''}`;
    const entry = { label, startedAt: performance.now() };
    live.add(entry);
    try {
      await next();
    } finally {
      live.delete(entry);
    }
  });
}

/** Test seam: drop any entries a failed test left behind. */
export function resetInFlight(): void {
  live.clear();
}
