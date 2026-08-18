import type { Database } from 'bun:sqlite';

/**
 * `users.last_seen_at` — the persisted "last connection" behind the Admin user list.
 *
 * Distinct from `PresenceService`, deliberately: presence tracks *sessions* and stays
 * in-memory because it must reset when the server (and thus every client session) does.
 * This is a single scalar per user that answers the one question an in-memory map
 * structurally cannot — when was this account last here — so it has to survive a restart.
 *
 * The heartbeat fires once per tab per 60s, so the write is throttled to at most one
 * per user per `LAST_SEEN_THROTTLE_MS`. Granularity of a few minutes is irrelevant to a
 * column read as "3 days ago", and a currently-connected user already reads as online
 * from presence.
 *
 * Best-effort telemetry: a failure here must never break a login or a heartbeat, the
 * same rule as `agent_tokens.last_used_at`.
 *
 * See docs/presence-tracking.md.
 */

/** At most one write per user per this window. */
export const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

/** userId → the `now` we last wrote for them. Module-level, like `presenceService`. */
const lastWritten = new Map<string, number>();

/**
 * Stamp `users.last_seen_at` for `userId`, subject to the throttle.
 *
 * @param db the connection, or a thunk returning it. Pass the thunk (`getDatabase`)
 *   from a route: resolving the connection is itself a throwing operation when the
 *   DB is not initialised, and doing it at the call site would put that throw
 *   *outside* this function's catch — which is how a telemetry write turns a 204
 *   heartbeat into a 500.
 * @param now injectable clock so the throttle is testable without fake timers.
 * @param opts.force bypass the throttle — for discrete events (a login) rather than
 *   the repeating heartbeat, where the exact moment is the point.
 * @returns whether a write actually happened (false = throttled, or the write failed).
 */
export function touchLastSeen(
  db: Database | (() => Database),
  userId: string,
  now: number = Date.now(),
  opts?: { force?: boolean },
): boolean {
  if (!opts?.force) {
    const prev = lastWritten.get(userId);
    if (prev !== undefined && now - prev < LAST_SEEN_THROTTLE_MS) return false;
  }

  try {
    const conn = typeof db === 'function' ? db() : db;
    conn.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [now, userId]);
  } catch {
    // Best-effort telemetry — never block auth or a heartbeat on it. Leaving the
    // throttle map untouched means the next call retries rather than waiting out
    // the window on a write that never landed.
    return false;
  }

  lastWritten.set(userId, now);
  return true;
}

/** Clear the throttle map. Test seam — module state would otherwise leak between specs. */
export function resetLastSeenThrottle(): void {
  lastWritten.clear();
}
