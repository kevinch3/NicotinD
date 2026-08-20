import { Hono } from 'hono';
import type { Context } from 'hono';
import type { PublicPollVoteBody, RadioPollSettings, RadioPollSummary } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/current-user.js';
import { getDatabase } from '../db.js';
import { recordAudit } from '../services/audit-log.js';
import {
  RadioPollGenerationError,
  generatePollScenarios,
  mergePollWeights,
  normalizePollSettings,
} from '../services/radio-poll-generate.js';
import {
  RadioPollRaterCapError,
  RadioPollVoteError,
  closePoll,
  createPoll,
  deletePoll,
  getPollById,
  getPollByToken,
  listPollSummaries,
  listScenarios,
  pollResults,
  pollStatus,
  publicPollView,
  recordVotes,
  type RadioPollRow,
  type StoredPollSummary,
} from '../services/radio-poll-store.js';
import { mintShareJwt } from './share.js';

/** How long one rater visit's media JWT lives; the wizard silently re-fetches
 *  the poll to refresh it (unlike share/activate, the poll GET is idempotent —
 *  a poll link is multi-rater/multi-visit by design). */
export const POLL_MEDIA_JWT_TTL_MS = 30 * 60_000;

const MAX_EXPIRY_HOURS = 24 * 90;

function withUrl(summary: StoredPollSummary, origin: string): RadioPollSummary {
  return { ...summary, url: `${origin}/poll/${summary.token}` };
}

/**
 * Admin half — mounted at /api/admin/radio-polls so the blanket /api/admin/*
 * auth prefix applies; every handler additionally requires the admin role.
 * Split from the public factory on purpose: the deliberately-public group
 * below stays minimal, so a new route added to the wrong file fails the
 * check:route-auth gate instead of silently shipping unauthenticated.
 */
export function radioPollAdminRoutes(deps: { version?: string } = {}) {
  const app = new Hono<AuthEnv>();

  app.post('/', async (c) => {
    const user = requireAdmin(c);
    type CreateBody = { name?: string; expiresInHours?: number } & Partial<RadioPollSettings>;
    const body = await c.req.json<CreateBody>().catch(() => ({}) as CreateBody);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'name is required', code: 'VALIDATION_ERROR' }, 400);

    const db = getDatabase();
    try {
      const settings = normalizePollSettings({
        scenarioCount: body.scenarioCount ?? 5,
        nextUpCount: body.nextUpCount ?? 5,
        pinnedSeedIds: body.pinnedSeedIds,
        weights: body.weights,
      });
      const weights = mergePollWeights(settings.weights);
      const scenarios = generatePollScenarios(db, settings, weights);
      const expiresInHours = Number(body.expiresInHours);
      const expiresAt =
        Number.isFinite(expiresInHours) && expiresInHours > 0
          ? Date.now() + Math.min(expiresInHours, MAX_EXPIRY_HOURS) * 3_600_000
          : null;
      const { id, token } = createPoll(db, {
        name,
        createdBy: user.sub,
        settings,
        scenarios,
        engineVersion: deps.version ?? null,
        expiresAt,
      });
      recordAudit(db, user, 'radio-poll.create', {
        targetKind: 'radio-poll',
        targetId: id,
        detail: `${name} (${scenarios.length} scenarios)`,
      });
      const origin = new URL(c.req.url).origin;
      return c.json({ id, token, url: `${origin}/poll/${token}` }, 201);
    } catch (err) {
      if (err instanceof RadioPollGenerationError) {
        return c.json({ error: err.message, code: 'VALIDATION_ERROR' }, 400);
      }
      throw err;
    }
  });

  app.get('/', (c) => {
    requireAdmin(c);
    const origin = new URL(c.req.url).origin;
    return c.json(listPollSummaries(getDatabase()).map((s) => withUrl(s, origin)));
  });

  app.get('/:id', (c) => {
    requireAdmin(c);
    const db = getDatabase();
    const poll = getPollById(db, c.req.param('id'));
    if (!poll) return c.json({ error: 'Poll not found', code: 'NOT_FOUND' }, 404);
    const results = pollResults(db, poll);
    const origin = new URL(c.req.url).origin;
    return c.json({ ...results, poll: withUrl(results.poll, origin) });
  });

  app.post('/:id/close', (c) => {
    const user = requireAdmin(c);
    const db = getDatabase();
    const id = c.req.param('id');
    const poll = getPollById(db, id);
    if (!poll) return c.json({ error: 'Poll not found', code: 'NOT_FOUND' }, 404);
    closePoll(db, id);
    recordAudit(db, user, 'radio-poll.close', { targetKind: 'radio-poll', targetId: id });
    return c.json({ ok: true });
  });

  app.delete('/:id', (c) => {
    const user = requireAdmin(c);
    const db = getDatabase();
    const id = c.req.param('id');
    if (!deletePoll(db, id)) {
      return c.json({ error: 'Poll not found', code: 'NOT_FOUND' }, 404);
    }
    recordAudit(db, user, 'radio-poll.delete', { targetKind: 'radio-poll', targetId: id });
    return c.json({ ok: true });
  });

  return app;
}

function openPollOr404(
  c: Context,
  token: string,
): { poll: RadioPollRow; response?: undefined } | { poll?: undefined; response: Response } {
  const poll = getPollByToken(getDatabase(), token);
  if (!poll) return { response: c.json({ error: 'Poll not found', code: 'NOT_FOUND' }, 404) };
  const status = pollStatus(poll);
  if (status !== 'open') {
    return {
      response: c.json(
        {
          error: `This poll is ${status}`,
          code: status === 'closed' ? 'POLL_CLOSED' : 'POLL_EXPIRED',
        },
        410,
      ),
    };
  }
  return { poll };
}

/**
 * Public half — mounted at /api/radio-polls (a reasoned PUBLIC_ROUTES entry:
 * the token is the credential). Endpoints here must NEVER 401: the web auth
 * interceptor bounces any 401 to /login, which would eject an anonymous rater
 * mid-wizard.
 */
export function radioPollPublicRoutes(jwtSecret: string) {
  const app = new Hono();

  app.get('/public/:token', async (c) => {
    const opened = openPollOr404(c, c.req.param('token'));
    if (opened.response) return opened.response;
    const poll = opened.poll;
    const expiresAt = Date.now() + POLL_MEDIA_JWT_TTL_MS;
    // A share-scoped JWT (share:true → the auth middleware enforces GET-only
    // and accepts it via ?token= on /api/stream + /api/cover). sub = the poll
    // creator, mirroring share-link semantics.
    const jwt = await mintShareJwt(poll.created_by, expiresAt, jwtSecret);
    const view = publicPollView(poll, listScenarios(getDatabase(), poll.id), { jwt, expiresAt });
    return c.json(view);
  });

  app.post('/public/:token/votes', async (c) => {
    const opened = openPollOr404(c, c.req.param('token'));
    if (opened.response) return opened.response;
    const poll = opened.poll;
    const body = await c.req.json<PublicPollVoteBody>().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400);
    try {
      return c.json(recordVotes(getDatabase(), poll.id, body));
    } catch (err) {
      if (err instanceof RadioPollVoteError) {
        return c.json({ error: err.message, code: 'VALIDATION_ERROR' }, 400);
      }
      if (err instanceof RadioPollRaterCapError) {
        return c.json({ error: err.message, code: 'POLL_RATER_CAP' }, 409);
      }
      throw err;
    }
  });

  return app;
}
