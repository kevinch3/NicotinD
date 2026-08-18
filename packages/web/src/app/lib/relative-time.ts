/**
 * The one relative-time helper ("Just now" / "5m ago" / "Yesterday" / "4d ago").
 *
 * Extracted from a private, hardcoded-English copy inside
 * `download-item.component.ts` when the Admin users table needed the same
 * rendering for its "last connection" column. Registered in
 * `scripts/check-shared-helpers.ts` so copy #2 fails CI rather than drifting.
 *
 * The translator is an **optional parameter** rather than an injected service so
 * this stays a pure module (no Angular DI, testable as a plain function), and so
 * a surface that has not been through the i18n pass yet can call it and get the
 * original English wording verbatim.
 */

/** A bucketed age, with no wording attached — the unit is the decision, the copy isn't. */
export type RelativeBucket =
  | { unit: 'now' }
  | { unit: 'minutes'; value: number }
  | { unit: 'hours'; value: number }
  | { unit: 'yesterday' }
  | { unit: 'days'; value: number };

/** Same shape as `TranslateService.t`, passed in rather than imported. */
export type Translator = (key: string, params?: Record<string, string | number>) => string;

/** i18n key per bucket. Exported so a spec can assert the key, not the English. */
export const RELATIVE_TIME_KEYS: Record<RelativeBucket['unit'], string> = {
  now: 'time.justNow',
  minutes: 'time.minutesAgo',
  hours: 'time.hoursAgo',
  yesterday: 'time.yesterday',
  days: 'time.daysAgo',
};

/** English fallback, byte-identical to the original download-item wording. */
function englishFor(b: RelativeBucket): string {
  switch (b.unit) {
    case 'now':
      return 'Just now';
    case 'minutes':
      return `${b.value}m ago`;
    case 'hours':
      return `${b.value}h ago`;
    case 'yesterday':
      return 'Yesterday';
    case 'days':
      return `${b.value}d ago`;
  }
}

/**
 * Bucket the age of an epoch-ms timestamp.
 *
 * A timestamp slightly in the *future* clamps to `now` rather than rendering
 * "-3m ago": server and browser clocks disagree by seconds routinely, and
 * `last_seen_at` is stamped server-side.
 */
export function relativeBucket(ms: number, now: number = Date.now()): RelativeBucket {
  const mins = Math.floor(Math.max(0, now - ms) / 60_000);
  if (mins < 1) return { unit: 'now' };
  if (mins < 60) return { unit: 'minutes', value: mins };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { unit: 'hours', value: hours };
  const days = Math.floor(hours / 24);
  return days === 1 ? { unit: 'yesterday' } : { unit: 'days', value: days };
}

/**
 * Render the age of an epoch-ms timestamp.
 *
 * @param t optional translator; without it the English fallback is returned, so
 *   an un-i18n'd caller keeps its existing output.
 */
export function timeAgo(ms: number, t?: Translator, now: number = Date.now()): string {
  const bucket = relativeBucket(ms, now);
  if (!t) return englishFor(bucket);
  const key = RELATIVE_TIME_KEYS[bucket.unit];
  return 'value' in bucket ? t(key, { value: bucket.value }) : t(key);
}
