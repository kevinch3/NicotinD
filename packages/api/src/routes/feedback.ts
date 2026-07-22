/**
 * Generation-feedback capture API (admin-only). Pending snapshots are recorded
 * server-side at generation time (e.g. the hunt/base route); this router lets an
 * admin GRADE them (PATCH) and EXPORT them (GET) for the fixture pipeline.
 * See docs/generation-feedback.md.
 */
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import { resolveFeedback, listFeedback } from '../services/generation-feedback.js';
import { recordAudit } from '../services/audit-log.js';
import type {
  GenerationFeedbackResourceType,
  GenerationVerdict,
  HuntMatchItemFlags,
} from '@nicotind/core';

const VERDICTS = new Set<GenerationVerdict>(['good', 'bad']);

export function feedbackRoutes(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Dev tool — admin only. Grading writes the golden-dataset the recognizer is
  // tuned against, so it stays behind the same gate as other admin surfaces.
  app.use('*', async (c, next) => {
    if (c.get('user').role !== 'admin') return c.json({ error: 'Admin access required' }, 403);
    await next();
  });

  // GET /api/feedback?resourceType=&graded=&limit=&offset= — export snapshots.
  app.get('/', (c) => {
    const q = c.req.query();
    const graded = q.graded === 'true' ? true : q.graded === 'false' ? false : undefined;
    const rows = listFeedback(getDatabase(), {
      resourceType: q.resourceType as GenerationFeedbackResourceType | undefined,
      graded,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    return c.json(rows);
  });

  // PATCH /api/feedback/:id — grade a pending capture (the toast 👍/👎 lands here).
  app.patch('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (Number.isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    type PatchBody = { verdict?: string; note?: string; itemFlags?: HuntMatchItemFlags };
    const body = await c.req.json<PatchBody>().catch(() => ({}) as PatchBody);
    if (!body.verdict || !VERDICTS.has(body.verdict as GenerationVerdict)) {
      return c.json({ error: 'verdict must be "good" or "bad"' }, 400);
    }

    const user = c.get('user');
    const ok = resolveFeedback(getDatabase(), id, user.sub, {
      verdict: body.verdict as GenerationVerdict,
      note: body.note,
      itemFlags: body.itemFlags,
    });
    if (!ok) return c.json({ error: 'No pending feedback with that id for this user' }, 404);

    recordAudit(getDatabase(), user, 'feedback.resolve', {
      targetKind: 'generation-feedback',
      targetId: String(id),
      detail: body.verdict,
    });
    return c.json({ ok: true });
  });

  return app;
}
