/**
 * Curator triage (docs/curator-triage.md §6) — the round endpoints the
 * library's "decisions waiting" card links into.
 *
 * The round is built from open `curation_flags` rows, but it serves only the
 * ones a human can decide: a target still in the library, not deferred, and
 * at least one option that changes data. Everything else stays open for the
 * agent (`awaitingAgent`), and the count the entry card shows is the served
 * pool, so "3 decisions waiting" never advertises a card nobody will see.
 */
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { CurationCase } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { requireCurator } from '../middleware/current-user.js';
import { getDatabase } from '../db.js';
import { recordAudit } from '../services/audit-log.js';
import {
  listOpenCurationFlags,
  resolveCurationFlag,
  isResolvedCurationFlag,
  snoozeCurationFlag,
  type FlagTargetKind,
} from '../services/curation-flags.js';
import { flagToCase } from '../services/curation/case-sources.js';
import { describeTarget, type CaseTarget } from '../services/curation/describe-target.js';
import { assembleRound } from '../services/curation/round.js';
import { applyCaseEffect, type ApplyEffectDeps } from '../services/curation/apply.js';

export { describeTarget };

/** How many open flags a single round may be assembled from. */
const POOL_LIMIT = 200;

/**
 * How long "skip for now" keeps a case out of the round. A week is long
 * enough that a skipped card is not the first thing shown tomorrow, and short
 * enough that a decision merely postponed comes back on its own; "Leave as
 * is" is the durable exit.
 */
export const SKIP_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CurationRouteDeps {
  applyDeps: ApplyEffectDeps;
  /** Resolve a flag's target to a display title/subtitle, or null when gone. */
  describeTarget: (kind: FlagTargetKind, id: string) => CaseTarget | null;
}

interface Pool {
  cases: CurationCase[];
  /** Open flags no human will see until the agent re-files or resolves them. */
  awaitingAgent: number;
}

const parseFlagId = (caseId: string): number | null => {
  if (!caseId.startsWith('flag:')) return null;
  const id = Number(caseId.slice('flag:'.length));
  return Number.isInteger(id) ? id : null;
};

export function curationRoutes(deps: CurationRouteDeps) {
  const app = new Hono<AuthEnv>();

  const buildPool = (db: Database, now = Date.now()): Pool => {
    const cases: CurationCase[] = [];
    let awaitingAgent = 0;
    for (const flag of listOpenCurationFlags(db, POOL_LIMIT, { excludeSnoozedAt: now })) {
      const target = deps.describeTarget(flag.targetKind, flag.targetId);
      const kase = target && flagToCase(flag, target);
      if (kase) cases.push(kase);
      else awaitingAgent++;
    }
    return { cases, awaitingAgent };
  };

  app.get('/round', (c) => {
    requireCurator(c);
    const pool = buildPool(getDatabase());
    return c.json({ cases: assembleRound(pool.cases), awaitingAgent: pool.awaitingAgent });
  });

  app.get('/count', (c) => {
    requireCurator(c);
    const pool = buildPool(getDatabase());
    return c.json({ open: pool.cases.length, awaitingAgent: pool.awaitingAgent });
  });

  app.post('/cases/:id/skip', (c) => {
    requireCurator(c);
    const flagId = parseFlagId(c.req.param('id'));
    if (flagId === null) return c.json({ error: 'Case not found' }, 404);
    const until = Date.now() + SKIP_SNOOZE_MS;
    if (!snoozeCurationFlag(getDatabase(), flagId, until)) {
      return c.json({ error: 'Case not found' }, 404);
    }
    return c.json({ ok: true, until });
  });

  app.post('/cases/:id/apply', async (c) => {
    const user = requireCurator(c);
    const caseId = c.req.param('id');
    const body = await c.req
      .json<{ optionId?: string }>()
      .catch(() => ({}) as { optionId?: string });
    const optionId = (body.optionId ?? '').trim();
    if (!optionId) return c.json({ error: 'optionId is required' }, 400);

    const db = getDatabase();
    const flagId = parseFlagId(caseId);

    // Rebuilt from the open flags rather than trusting the client's copy: the
    // option's effect is what gets dispatched, so it must come from the server.
    const found = buildPool(db).cases.find((x) => x.id === caseId);
    if (!found) {
      // Gone from the pool because somebody else finished it is a different
      // answer from "no such case", and the UI should say so.
      if (flagId !== null && isResolvedCurationFlag(db, flagId)) {
        return c.json({ error: 'This case was already handled' }, 409);
      }
      return c.json({ error: 'Case not found' }, 404);
    }

    const option = found.options.find((o) => o.id === optionId);
    if (!option) return c.json({ error: 'Unknown optionId for this case' }, 400);

    // Every case is flag-backed, so applying an option also closes the flag:
    // the decision it recorded has now been made. Resolving happens FIRST and
    // its boolean is the lock — a conditional UPDATE on `resolved_at IS NULL`
    // is the only thing serialising two curators on the same card. Losing that
    // race means the case was already handled: refuse rather than dispatch the
    // mutation (and write the audit row) a second time.
    if (flagId !== null) {
      if (!resolveCurationFlag(db, flagId, user.username ?? user.sub)) {
        return c.json({ error: 'This case was already handled' }, 409);
      }
    }

    // The flag is closed before the effect runs, so a failed effect leaves a
    // resolved flag with no data change. That is the safer of the two
    // orderings: a human can re-flag, whereas a lost mutation under a still-open
    // flag invites the same wrong apply again.
    const result = await applyCaseEffect(db, option.effect, deps.applyDeps);
    if (!result.ok) {
      return c.json({ error: result.error, resolved: true }, 400);
    }

    recordAudit(db, user, 'curation.case', {
      targetKind: found.target.kind,
      targetId: found.target.id,
      detail: `${found.kind}/${option.id}: ${result.detail}`,
    });
    // A delete through a card is still a delete: it must count wherever
    // `song.delete` rows are counted, not hide under a curation action.
    if (option.effect.type === 'song-delete') {
      recordAudit(db, user, 'song.delete', {
        targetKind: 'song',
        targetId: option.effect.songId,
        detail: `via curation case ${found.id}`,
      });
    }

    return c.json({ ok: true, detail: result.detail });
  });

  return app;
}
