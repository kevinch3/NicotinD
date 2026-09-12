/**
 * Curator triage (docs/curator-triage.md §6) — the round endpoints the
 * library's "decisions waiting" card links into.
 *
 * Phase 1 sources cases from open `curation_flags` rows only. Note this also
 * closes an existing gap: there was no curator-accessible GET for flags at all,
 * because listing rode the admin-only ServiceReview snapshot.
 */
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { requireCurator } from '../middleware/current-user.js';
import { getDatabase } from '../db.js';
import { recordAudit } from '../services/audit-log.js';
import {
  listOpenCurationFlags,
  countOpenCurationFlags,
  resolveCurationFlag,
  isResolvedCurationFlag,
  type FlagTargetKind,
} from '../services/curation-flags.js';
import { flagToCase, type CaseTarget } from '../services/curation/case-sources.js';
import { assembleRound } from '../services/curation/round.js';
import { applyCaseEffect, type ApplyEffectDeps } from '../services/curation/apply.js';

/** How many open flags a single round may be assembled from. */
const POOL_LIMIT = 200;

export interface CurationRouteDeps {
  applyDeps: ApplyEffectDeps;
  /** Resolve a flag's target to a display title/subtitle for the card header. */
  describeTarget: (kind: FlagTargetKind, id: string) => CaseTarget;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Resolve `(kind, id)` into the card header.
 *
 * The single worst property of the admin panel this replaces is that it renders
 * the bare path-derived sha1 a flag stores as its `targetId`. A curator cannot
 * decide anything about `9d0e6a…`, so every branch here returns prose: the
 * entity's own name, plus the one fact that disambiguates a name shared by
 * several entities (an album's artist, a song's artist + album, an artist's
 * catalogue size).
 *
 * A flag outlives its target — a song gets deleted while its flag is still
 * open — and that case must stay *resolvable*, or the queue accumulates rows no
 * curator can ever clear. So a miss is not an error: it degrades to an honest
 * "no longer in the library" header on a card whose resolve-only option still
 * works.
 */
export function describeTarget(db: Database, kind: FlagTargetKind, id: string): CaseTarget {
  if (kind === 'artist') {
    const row = db
      .query<{ name: string; album_count: number }, [string]>(
        'SELECT name, album_count FROM library_artists WHERE id = ?',
      )
      .get(id);
    if (row) {
      return {
        kind,
        id,
        title: row.name,
        subtitle: plural(Number(row.album_count ?? 0), 'album', 'albums'),
      };
    }
  } else if (kind === 'album') {
    const row = db
      .query<{ name: string; artist: string }, [string]>(
        'SELECT name, artist FROM library_albums WHERE id = ?',
      )
      .get(id);
    if (row) return { kind, id, title: row.name, subtitle: row.artist };
  } else {
    const row = db
      .query<{ title: string; artist: string; album: string | null }, [string]>(
        `SELECT s.title AS title, s.artist AS artist, a.name AS album
           FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
          WHERE s.id = ?`,
      )
      .get(id);
    if (row) {
      return {
        kind,
        id,
        title: row.title,
        subtitle: row.album ? `${row.artist} — ${row.album}` : row.artist,
      };
    }
  }

  return {
    kind,
    id,
    title: `Missing ${kind}`,
    subtitle: `No longer in the library — the flag outlived its ${kind}`,
  };
}

export function curationRoutes(deps: CurationRouteDeps) {
  const app = new Hono<AuthEnv>();

  const buildPool = (db: Database) =>
    listOpenCurationFlags(db, POOL_LIMIT).map((f) =>
      flagToCase(f, deps.describeTarget(f.targetKind, f.targetId)),
    );

  app.get('/round', (c) => {
    requireCurator(c);
    return c.json({ cases: assembleRound(buildPool(getDatabase())) });
  });

  app.get('/count', (c) => {
    requireCurator(c);
    return c.json({ open: countOpenCurationFlags(getDatabase()) });
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
    const flagId = Number(caseId.slice('flag:'.length));
    const flagBacked = caseId.startsWith('flag:') && Number.isInteger(flagId);

    // Rebuilt from the open flags rather than trusting the client's copy: the
    // option's effect is what gets dispatched, so it must come from the server.
    const found = buildPool(db).find((x) => x.id === caseId);
    if (!found) {
      // Gone from the pool because somebody else finished it is a different
      // answer from "no such case", and the UI should say so.
      if (flagBacked && isResolvedCurationFlag(db, flagId)) {
        return c.json({ error: 'This case was already handled' }, 409);
      }
      return c.json({ error: 'Case not found' }, 404);
    }

    const option = found.options.find((o) => o.id === optionId);
    if (!option) return c.json({ error: 'Unknown optionId for this case' }, 400);

    // Every phase-1 case is flag-backed, so applying an option also closes the
    // flag: the decision it recorded has now been made. Resolving happens FIRST
    // and its boolean is the lock — a conditional UPDATE on `resolved_at IS
    // NULL` is the only thing serialising two curators on the same card. Losing
    // that race means the case was already handled: refuse rather than dispatch
    // the mutation (and write the audit row) a second time.
    if (flagBacked) {
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

    return c.json({ ok: true, detail: result.detail });
  });

  return app;
}
