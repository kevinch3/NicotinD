/**
 * Feed eligibility: the ONE predicate that decides whether a song may be
 * *recommended* — served by radio, drawn for a mosaic tile, picked into a
 * generated playlist, offered as "similar".
 *
 * Scope is feeds only. A listing route (the Songs tab, an album page, search)
 * shows what the library *has*; a feed proposes what the listener has not
 * asked for, and that is where an unvetted track does damage. The two must
 * never share this helper: a listing that hid un-analysed songs would make a
 * fresh download look lost.
 *
 * Two layers, deliberately asymmetric:
 *
 * - **Hard** — never relaxes: the song is not hidden, its album is not hidden,
 *   it has landed, and (when the caller asks) it clears the duration floor.
 *   Radio pools used to check `s.hidden` and forget `library_albums.hidden`;
 *   an album a curator hid kept playing on radio. The helper checks both.
 * - **Readiness** — tier 1 requires the analysis that makes a track scoreable
 *   (bpm and energy present, or permanently failed so it never will be); tier 2
 *   waives it. Callers start at tier 1 and fall back to tier 2 only when tier 1
 *   cannot fill the request — a fresh install or a mid-backfill library keeps
 *   serving, but a library with enough vetted tracks never recommends an
 *   unvetted one. This replaced radio's "pool 4", which reserved seats for
 *   un-analysed tracks unconditionally.
 *
 * `check:feed-eligibility` fails CI for a feed query that bypasses this module.
 */
import { permanentlyFailedClause } from '../enrichment/analysis-failures.js';
import type { FilterSqlFragment } from '../library-filter-sql.js';

export type ReadinessTier = 1 | 2;

export interface FeedEligibilityOpts {
  /** Alias of the `library_songs` row in the outer query. Default `s`. */
  alias?: string;
  /**
   * Alias of an already-joined `library_albums` row. When absent the album
   * check is a correlated `NOT EXISTS`, so the helper never forces a join.
   */
  albumAlias?: string;
  tier: ReadinessTier;
  /** Duration floor in seconds; omitted → no floor (radio passes its own). */
  minDurationSec?: number;
}

/** Tier-1 readiness: the song has been analysed, or analysis has given up on it. */
export function readinessAnalysedSql(alias = 's'): string {
  return (
    `(${alias}.bpm IS NOT NULL OR ${permanentlyFailedClause('bpm', alias)})` +
    ` AND (${alias}.energy IS NOT NULL OR ${permanentlyFailedClause('energy', alias)})`
  );
}

/**
 * WHERE fragments for one feed query. Same `{ wheres, params }` shape as
 * `songFilterWheres`, so callers splice it into an existing predicate list.
 * No bind params are produced today; the slot exists so a per-listener
 * exclusion can add some without changing every call site.
 */
export function feedEligibilityWheres(opts: FeedEligibilityOpts): FilterSqlFragment {
  const s = opts.alias ?? 's';
  const wheres: string[] = [`${s}.hidden = 0`];
  wheres.push(
    opts.albumAlias
      ? `(${opts.albumAlias}.hidden IS NULL OR ${opts.albumAlias}.hidden = 0)`
      : `NOT EXISTS (SELECT 1 FROM library_albums fe_alb WHERE fe_alb.id = ${s}.album_id AND fe_alb.hidden = 1)`,
  );
  wheres.push(`${s}.landed_at IS NOT NULL`);
  if (opts.minDurationSec !== undefined) wheres.push(`${s}.duration >= ${opts.minDurationSec}`);
  if (opts.tier === 1) wheres.push(readinessAnalysedSql(s));
  return { wheres, params: [] };
}

/** The fragments joined, ready to drop after `WHERE` / `AND`. */
export function feedEligibilitySql(opts: FeedEligibilityOpts): string {
  return feedEligibilityWheres(opts).wheres.join(' AND ');
}

export interface FeedEligibilityRow {
  hidden: number | boolean;
  albumHidden?: number | boolean | null;
  landedAt?: number | null;
  duration?: number | null;
  bpm?: number | null;
  energy?: number | null;
  /** Analysis gave up on bpm / energy for this file (the ledger's cap or a terminal answer). */
  bpmFailed?: boolean;
  energyFailed?: boolean;
}

/** TypeScript twin of {@link feedEligibilityWheres}, for in-memory candidates. */
export function isFeedEligible(
  row: FeedEligibilityRow,
  opts: { tier: ReadinessTier; minDurationSec?: number },
): boolean {
  if (row.hidden) return false;
  if (row.albumHidden) return false;
  if (row.landedAt === null) return false;
  if (opts.minDurationSec !== undefined && (row.duration ?? 0) < opts.minDurationSec) return false;
  if (opts.tier === 1) {
    const bpmReady = row.bpm != null || row.bpmFailed === true;
    const energyReady = row.energy != null || row.energyFailed === true;
    if (!bpmReady || !energyReady) return false;
  }
  return true;
}
