import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import {
  deleteUserHistory,
  exportUserData,
  getRetentionDays,
  historyCollectionState,
  isHistoryEnabledForUser,
  setUserHistoryEnabled,
} from '../services/privacy.js';
import { recordAudit } from '../services/audit-log.js';

/**
 * A user's own privacy controls (issue #454): what we hold about them, whether
 * to keep collecting, a copy of it, and a way to delete it.
 *
 * Every endpoint is scoped to `user.sub` and takes **no user id** — the same
 * structural privacy as `/api/history`. An admin wanting someone else's data
 * has no route here by design; that would be the surveillance surface this is
 * meant to avoid.
 *
 * See docs/privacy.md.
 */
export function privacyRoutes(historyEnabled: () => boolean = () => true) {
  const app = new Hono<AuthEnv>();

  // GET / — what this instance stores about the caller and what they can change.
  app.get('/', (c) => {
    const user = c.get('user');
    const db = getDatabase();
    const collection = historyCollectionState(db, user.sub, historyEnabled());
    return c.json({
      historyEnabled: isHistoryEnabledForUser(db, user.sub),
      collection,
      /** Days a play event is kept; 0 = indefinitely. Instance-wide. */
      retentionDays: getRetentionDays(db),
    });
  });

  // PUT /history-consent — the caller's own opt-out.
  app.put('/history-consent', async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean', code: 'VALIDATION_ERROR' }, 400);
    }

    const db = getDatabase();
    setUserHistoryEnabled(db, user.sub, body.enabled);
    return c.json({
      historyEnabled: body.enabled,
      collection: historyCollectionState(db, user.sub, historyEnabled()),
    });
  });

  // GET /export — right of access (Art. 15). Everything tied to the caller.
  app.get('/export', (c) => {
    const user = c.get('user');
    const bundle = exportUserData(getDatabase(), user.sub);
    // Content-Disposition so a browser saves it rather than rendering a wall of
    // JSON — this is a document someone keeps, not a page they read.
    c.header('Content-Disposition', `attachment; filename="nicotind-my-data-${user.sub}.json"`);
    return c.json(bundle);
  });

  // DELETE /history — right to erasure (Art. 17), scoped to the listening log.
  // Audit-logged like every other destructive action, recording only that the
  // user erased their own history and how many rows — never what was in them.
  app.delete('/history', (c) => {
    const user = c.get('user');
    const db = getDatabase();
    const deleted = deleteUserHistory(db, user.sub);
    recordAudit(db, user, 'privacy.history.delete', {
      targetKind: 'user',
      targetId: user.sub,
      detail: `${deleted} events`,
    });
    return c.json({ deleted });
  });

  return app;
}
