/**
 * Download inbox triage (issue #411): the curator-facing surface for the
 * quarantine-hold review queue — list pending albums, approve (recorded
 * decision, no file changes), or discard (delete the album outright).
 * Mounted read-only-auth-gated at /api/review; see routes/review.ts for the
 * unrelated admin ServiceReview snapshot.
 */
import { Hono } from 'hono';
import { getDatabase } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { requireCurator } from '../middleware/current-user.js';
import { errorHandler } from '../middleware/error-handler.js';
import { recordAudit } from '../services/audit-log.js';
import { deleteAlbum } from '../services/library-deletion.js';
import type { ShareRescanScheduler } from '../services/share-rescan-scheduler.js';
import {
  loadReviewQueue,
  pendingReviewCount,
  recordReviewDecision,
} from '../services/download-review-store.js';

export interface DownloadReviewDeps {
  musicDir?: string;
  shareRescan: ShareRescanScheduler;
  /** Late-bound processing nudge — landing a hold decision shouldn't wait for
   *  the next window tick. Task 9 extends this deps shape further. */
  kickEager?: () => Promise<void>;
}

export function downloadReviewRoutes(deps: DownloadReviewDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // Self-contained error mapping, mirroring library.ts, so requireCurator's
  // ForbiddenError maps to 403 even when this router is mounted bare (route
  // tests) without the app-level onError.
  app.onError(errorHandler);

  app.get('/queue', (c) => {
    requireCurator(c);
    return c.json({ albums: loadReviewQueue(getDatabase()) });
  });

  app.get('/count', (c) => {
    requireCurator(c);
    return c.json({ pending: pendingReviewCount(getDatabase()) });
  });

  app.post('/albums/:id/approve', (c) => {
    const user = requireCurator(c);
    const db = getDatabase();
    const id = c.req.param('id');
    recordReviewDecision(db, id, 'approved', user.sub);
    recordAudit(db, user, 'download_review.approve', { targetKind: 'album', targetId: id });
    void deps.kickEager?.();
    return c.json({ ok: true });
  });

  app.post('/albums/:id/discard', async (c) => {
    const user = requireCurator(c);
    const db = getDatabase();
    const id = c.req.param('id');
    const result = await deleteAlbum(db, id, {
      musicDir: deps.musicDir,
      shareRescan: deps.shareRescan,
    });
    if (!result) return c.json({ error: 'Album not found' }, 404);
    recordReviewDecision(db, id, 'discarded', user.sub);
    recordAudit(db, user, 'download_review.discard', {
      targetKind: 'album',
      targetId: id,
      detail: result.albumRow ? `${result.albumRow.artist} — ${result.albumRow.name}` : undefined,
    });
    return c.json({ ok: true, deletedCount: result.deletedCount });
  });

  return app;
}
