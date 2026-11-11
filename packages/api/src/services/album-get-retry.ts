/**
 * When a Get whose source could not search (offline, or its lanes were busy) is
 * tried again, and when it stops. `attempt` counts the tries already made, from 1.
 * Returns the wait before the next try, or null to give up and show the reason.
 * See docs/album-hunt.md "A Get is a server job".
 */
export function albumGetRetryDelayMs(attempt: number): number | null {
  const DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];
  return DELAYS_MS[attempt - 1] ?? null;
}
