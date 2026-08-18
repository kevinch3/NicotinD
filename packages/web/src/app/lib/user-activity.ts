import { timeAgo, type Translator } from './relative-time';

/**
 * The Admin users table's "Activity" column — the consolidation of what used to
 * be three separate columns (Online / Devices / Sessions), all of which were
 * `hidden sm:table-cell` and so vanished on exactly the viewport where an admin
 * is most likely to be checking on someone.
 *
 * Pure functions rather than component methods: the web unit harness cannot
 * drive `input()` signals, so logic that lives in a template is effectively
 * untestable below e2e. Here it is a plain function call.
 */

export interface UserActivity {
  /** Live, from the in-memory PresenceService. */
  isConnected: boolean;
  /** Persisted epoch ms; null = never connected. See docs/presence-tracking.md. */
  last_seen_at: number | null;
  amountOfDevices: number;
  amountOfSessions: number;
}

/**
 * Primary line: "Online" while connected, else how long ago, else "Never".
 *
 * Connected wins over the timestamp because the two answer different questions
 * and the timestamp is throttled — a user online right now can carry a
 * `last_seen_at` of a few minutes ago.
 */
export function userActivityLabel(u: UserActivity, t: Translator, now?: number): string {
  if (u.isConnected) return t('admin.online');
  // `admin.neverConnected` ("Never"), not the existing `admin.never` ("never") —
  // that one is embedded mid-sentence elsewhere and is lowercase for that reason.
  if (u.last_seen_at === null) return t('admin.neverConnected');
  return timeAgo(u.last_seen_at, t, now);
}

/**
 * Secondary muted line: "2 devices · 3 sessions" while connected, else empty.
 *
 * This is where the removed Devices/Sessions columns' data went — the point of
 * the change was to stop *hiding* it on narrow viewports, not to drop it.
 */
export function userActivityDetail(u: UserActivity, t: Translator): string {
  if (!u.isConnected) return '';
  return t('admin.activityDetail', {
    devices: u.amountOfDevices,
    sessions: u.amountOfSessions,
  });
}
