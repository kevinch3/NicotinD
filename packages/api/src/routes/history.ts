import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import { recentPlays, recordPlayEvents, type PlayEventInput } from '../services/play-history.js';
import { STATS_PERIODS, listeningStats, type StatsPeriod } from '../services/listening-stats.js';
import { historyCollectionState } from '../services/privacy.js';

/**
 * Listening history. Every endpoint is scoped to the caller (`user.sub`) and
 * takes **no user id parameter** — history is private per user, and there being
 * nothing to pass is what makes that structural rather than a check someone can
 * forget to write. Admin analytics (phase 4) reads aggregates, never this.
 *
 * See docs/listening-history.md.
 */
export function historyRoutes(historyEnabled: () => boolean = () => true) {
  const app = new Hono<AuthEnv>();

  // POST /plays — append a batch of finished playback sessions. Idempotent on
  // clientEventId, because the client buffers durably and retries a failed
  // flush (offline listening), so the same event legitimately arrives twice.
  app.post('/plays', async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as { events?: unknown };
    if (!Array.isArray(body.events)) {
      return c.json({ error: 'events must be an array', code: 'VALIDATION_ERROR' }, 400);
    }

    // Consent is enforced HERE, not on the client: a device on an old bundle,
    // or one whose toggle hasn't synced, must not be able to write history the
    // user turned off. Reported rather than silently dropped so the client can
    // stop buffering instead of retrying forever.
    const db = getDatabase();
    const state = historyCollectionState(db, user.sub, historyEnabled());
    if (!state.enabled) {
      return c.json({ inserted: 0, duplicates: 0, rejected: 0, collection: state });
    }

    const result = recordPlayEvents(db, user.sub, body.events as PlayEventInput[]);
    return c.json(result);
  });

  // GET /stats?period= — aggregates over the caller's log. An unknown period
  // falls back to the default rather than 400ing: it comes off a query string,
  // and a stats page that errors on a typo is worse than one showing 30 days.
  app.get('/stats', (c) => {
    const user = c.get('user');
    const requested = c.req.query('period');
    const period = (STATS_PERIODS as readonly string[]).includes(requested ?? '')
      ? (requested as StatsPeriod)
      : '30d';
    return c.json(listeningStats(getDatabase(), user.sub, period, Date.now()));
  });

  // GET /recent — the caller's recently listened tracks, newest first.
  app.get('/recent', (c) => {
    const user = c.get('user');
    const limit = Number(c.req.query('limit') ?? 20);
    return c.json(recentPlays(getDatabase(), user.sub, Number.isFinite(limit) ? limit : 20));
  });

  return app;
}
