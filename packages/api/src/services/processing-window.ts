import type { ProcessingWindow } from '@nicotind/core';

/**
 * Pure time-window helpers for the library processor. No IO — directly testable.
 * Windows are expressed in the server's local time as `HH:MM` strings.
 */

/** Parse `HH:MM` into minutes-since-midnight, or null when malformed. */
export function parseHhMm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `now` inside the daily window? The window is `[start, end)` (start
 * inclusive, end exclusive). When `start === end` the window is empty (never).
 * When `start > end` the window wraps past midnight (e.g. 23:00–02:00), so a
 * time is "inside" if it's at/after start OR before end.
 *
 * Malformed bounds ⇒ false (fail closed: never run on a bad config).
 */
export function isWithinWindow(now: Date, window: ProcessingWindow): boolean {
  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  if (start === null || end === null) return false;
  if (start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start < end) return cur >= start && cur < end;
  // Wraps midnight.
  return cur >= start || cur < end;
}

/** Human-readable `HH:MM–HH:MM` for logs/UI. */
export function formatWindow(window: ProcessingWindow): string {
  return `${window.start}–${window.end}`;
}
