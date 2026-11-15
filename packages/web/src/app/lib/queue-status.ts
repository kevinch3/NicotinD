import type { JobQueueStatus } from '@nicotind/core';

/**
 * The wording of a reserved Get's place in line (#1938). A bulk Get waits about 20 s per search
 * in core's hunt queue, and the card used to say only "Resolving link…" — the URL lane's words for
 * a job that has no link. Pure, with the translator passed in, so a spec asserts keys and params.
 */

type Translator = (key: string, params?: Record<string, string | number>) => string;

/** "under a minute" or "~N min": the estimate is a mean of recent searches, not a promise. */
export function formatWait(ms: number, t: Translator): string {
  if (ms < 60_000) return t('downloads.queue.underMinute');
  return t('downloads.queue.minutes', { count: Math.round(ms / 60_000) });
}

/** What the stage badge says in place of "Resolving link…". */
export function queueBadgeKey(q: JobQueueStatus): string {
  return `downloads.queue.state.${q.state}`;
}

/** The muted line after the badge, or null when the badge says it all. */
export function queueDetail(q: JobQueueStatus, t: Translator, now: number): string | null {
  switch (q.state) {
    case 'waiting': {
      const place =
        q.ahead === 0 ? t('downloads.queue.next') : t('downloads.queue.ahead', { count: q.ahead });
      return `${place} · ${formatWait(q.etaMs, t)}`;
    }
    case 'retrying':
      return t('downloads.queue.retryIn', { wait: formatWait(Math.max(0, q.retryAt - now), t) });
    case 'searching':
      return null;
  }
}
