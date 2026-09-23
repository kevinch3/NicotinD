/**
 * Fail when a library list query re-derives the song predicate per entity row.
 *
 *   bun run check:library-queries
 *   bun run ./scripts/check-library-queries.ts --fixture correlated   # must exit 1
 *
 * WHY: `bun:sqlite` is synchronous inside a synchronous Hono handler, so a
 * quadratic list query is not a slow page — it is an outage. `/artists?country=`
 * held the single Bun event loop for ~3 minutes and took cover art, the songs
 * tab and the container health check down with it (#1055). Nothing in this
 * process can pre-empt it: Bun exposes neither `sqlite3_interrupt` nor a
 * progress handler, and an `.iterate()` deadline is inert for a plan that ends
 * in `USE TEMP B-TREE FOR ORDER BY` (docs/library-filters.md). The only lever
 * left is the shape, before it ships.
 *
 * #1055 fixed *a* query. This gate asserts the property: for every library list
 * route, built through the real fragment builders across every filter dimension
 * the grammar can express, `library_songs` must be scanned ONCE — inside a
 * non-correlated subquery whose result the entity row is then tested against —
 * never once per entity row.
 *
 * Judged on `EXPLAIN QUERY PLAN` against a schema-only in-memory DB, not the
 * clock: a wall-clock threshold flakes on a loaded box and says nothing about
 * why. The plan's `id`/`parent` columns give the real tree, so the two bad
 * spellings are one rule — a song scan under a `CORRELATED …` ancestor, or one
 * SQLite tagged ` EXISTS` because it is driven by the outer loop.
 *
 * Per docs/quality-gates.md a gate asserts its own denominator, and all three
 * here are derived independently of the check: the routes come from the builder
 * call sites in `routes/library.ts`, the filter dimensions from
 * `LIBRARY_FILTER_PARAM_KEYS`, and a case whose SQL touches `library_songs` but
 * whose plan shows no song scan is a failure, not a pass.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  LIBRARY_FILTER_PARAM_KEYS,
  parseLibraryFilter,
  serializeLibraryFilter,
  type LibraryFilter,
} from '@nicotind/core';
import { applySchema } from '../packages/api/src/db.js';
import {
  albumFilterWheres,
  artistFilterWheres,
  songFilterWheres,
  type FilterSqlFragment,
} from '../packages/api/src/services/library-filter-sql.js';

const repoRoot = resolve(import.meta.dir, '..');
const LIBRARY_ROUTES_FILE = 'packages/api/src/routes/library.ts';

export interface ListRoute {
  /** Route path as mounted under `/api/library`. */
  route: string;
  /** The real fragment builder this route splices in. */
  build: (f: LibraryFilter) => FilterSqlFragment;
  /** The route's own query with the filter clause spliced at `%FILTER%`. */
  sql: string;
}

/**
 * The entity list routes, each wrapping the REAL builder's fragment in its own
 * outer shape. Only the filter half is hand-written nowhere — that is the half
 * the invariant is about; the outer predicates and ORDER BY are here because
 * they are what makes the planner choose (a bare `SELECT *` plans differently).
 * `discoverListRoutes` keeps this list from silently missing a route.
 */
export const LIST_ROUTES: ListRoute[] = [
  {
    route: '/artists',
    build: artistFilterWheres,
    sql: `SELECT id, name FROM library_artists
          WHERE hidden = 0 AND split_compound = 0 AND fragment_of IS NULL
            AND name != 'Various Artists' COLLATE NOCASE%FILTER%
          ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
  },
  {
    route: '/albums',
    build: albumFilterWheres,
    sql: `SELECT id, name FROM library_albums
          WHERE hidden = 0 AND classification = 'album'%FILTER%
          ORDER BY created DESC LIMIT ? OFFSET ?`,
  },
  {
    route: '/singles',
    build: albumFilterWheres,
    sql: `SELECT id, name FROM library_albums
          WHERE hidden = 0 AND classification IN ('single','ep')%FILTER%
          ORDER BY created DESC LIMIT ? OFFSET ?`,
  },
  {
    route: '/compilations',
    build: albumFilterWheres,
    sql: `SELECT id, name FROM library_albums
          WHERE hidden = 0 AND classification = 'compilation'%FILTER%
          ORDER BY created DESC LIMIT ? OFFSET ?`,
  },
];

export interface FilterCase {
  label: string;
  query: Record<string, string | string[]>;
  /** Query-param keys this case vouches for. */
  covers: string[];
}

/** One case per filter dimension, plus the interactions that change the plan. */
export const FILTER_CASES: FilterCase[] = [
  { label: 'bpm range', query: { bpmMin: '120', bpmMax: '130' }, covers: ['bpmMin', 'bpmMax'] },
  { label: 'camelot keys', query: { key: '8A,9A' }, covers: ['key'] },
  { label: 'mood', query: { mood: 'happy,party' }, covers: ['mood'] },
  { label: 'energy bucket', query: { energy: 'high' }, covers: ['energy'] },
  { label: 'danceability buckets', query: { danceability: 'low,mid' }, covers: ['danceability'] },
  { label: 'valence bucket', query: { valence: 'mid' }, covers: ['valence'] },
  { label: 'acousticness bucket', query: { acousticness: 'low' }, covers: ['acousticness'] },
  { label: 'instrumental bucket', query: { instrumental: 'high' }, covers: ['instrumental'] },
  {
    label: 'year range',
    query: { yearMin: '1990', yearMax: '1999' },
    covers: ['yearMin', 'yearMax'],
  },
  { label: 'genres (join table)', query: { genre: ['Rock', 'Jazz'] }, covers: ['genre'] },
  {
    label: 'genres (primary only)',
    query: { genre: ['Rock'], primaryOnly: 'true' },
    covers: ['genre', 'primaryOnly'],
  },
  { label: 'countries', query: { country: 'CL,AR' }, covers: ['country'] },
  // `unknown` is the NOT EXISTS branch, and mixing it with a real code ORs the
  // two — a different subquery each time, so each gets its own plan.
  { label: 'country unknown', query: { country: 'unknown' }, covers: ['country'] },
  { label: 'country mixed', query: { country: 'CL,unknown' }, covers: ['country'] },
  { label: 'starred (entity level)', query: { starred: 'true' }, covers: ['starred'] },
  { label: 'duration range', query: { durMin: '60', durMax: '600' }, covers: ['durMin', 'durMax'] },
  // Entity-level starred alongside a song predicate, and then everything at
  // once: dimensions interact, and the planner is free to reorder.
  {
    label: 'starred + genre',
    query: { starred: 'true', genre: ['Rock'] },
    covers: ['starred', 'genre'],
  },
  {
    label: 'every dimension at once',
    query: {
      bpmMin: '90',
      bpmMax: '180',
      key: '8A',
      mood: 'happy',
      energy: 'high',
      danceability: 'mid',
      valence: 'low',
      acousticness: 'mid',
      instrumental: 'low',
      yearMin: '1970',
      yearMax: '2020',
      genre: ['Rock'],
      country: 'CL,unknown',
      starred: 'true',
      durMin: '30',
      durMax: '900',
    },
    covers: [...LIBRARY_FILTER_PARAM_KEYS].filter((k) => k !== 'licence' && k !== 'primaryOnly'),
  },
];

/** Param keys deliberately not exercised, each with the reason why. */
export const NOT_EXERCISED: Array<{ param: string; reason: string }> = [
  {
    param: 'licence',
    reason:
      'tombstone (#683): the filter was removed, parseLibraryFilter drops the key, and there is no SQL to plan — it survives only so a bookmarked URL can still be cleared',
  },
];

/** The known-bad shapes, used by the gate's own test to prove it can fail. */
export const FIXTURES: Record<string, ListRoute> = {
  correlated: {
    route: '/fixture-correlated',
    // The pre-#1055 spelling: an EXISTS correlated on the entity row, so the
    // matching-song set is re-derived for every artist.
    build: (f) => {
      const song = songFilterWheres({ ...f, starred: undefined }, 'ls');
      if (!song.wheres.length) return { wheres: [], params: [] };
      return {
        wheres: [
          `EXISTS (SELECT 1 FROM library_songs ls WHERE ls.artist_id = library_artists.id AND ls.hidden = 0 AND ${song.wheres.join(' AND ')})`,
        ],
        params: song.params,
      };
    },
    sql: `SELECT id, name FROM library_artists
          WHERE hidden = 0%FILTER%
          ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
  },
};

// ── Plan analysis ──────────────────────────────────────────────────────────

export interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}

/** A plan node that reads `library_songs` (the builders always alias it `ls`). */
const SONG_SCAN = /^(?:SEARCH|SCAN)\s+(?:library_songs|ls)\b/;
const SUBQUERY = /\b(?:LIST|SCALAR)\s+SUBQUERY\b/;
const CORRELATED = /^CORRELATED\b/;

export type SongScanVerdict =
  /** Evaluated once, inside a non-correlated subquery: the required shape. */
  | 'once'
  /** Re-derived per entity row: a CORRELATED ancestor. */
  | 'per-entity-row'
  /** Not inside a once-evaluated subquery — SQLite tagged it ` EXISTS`, or it
   *  sits in the outer loop where the gate cannot vouch for it. */
  | 'outer-loop';

/**
 * Judge every `library_songs` scan in one plan.
 *
 * From the real plans (schema-only DB, no stats), the required shape puts the
 * song scan under a plain `LIST SUBQUERY`:
 *
 *   4   0  SEARCH library_artists USING INDEX idx_library_artists_hidden
 *   12  0  LIST SUBQUERY 8
 *   22  15   SEARCH ls USING INDEX idx_library_songs_hidden      ← once
 *
 * while the quadratic one hoists the song scan into the outer loop, tagged
 * EXISTS, or buries it under a correlated subquery:
 *
 *   11  0  SEARCH library_artists USING INDEX idx_library_artists_hidden
 *   16  0  SEARCH ls EXISTS USING INDEX idx_library_songs_hidden ← per row
 *
 *   4   0  SEARCH library_albums USING INDEX idx_library_albums_grid
 *   10  0  CORRELATED SCALAR SUBQUERY 1
 *   16  10   SEARCH ls USING INDEX idx_library_songs_album_id    ← per row
 *
 * A song scan the gate cannot place inside a non-correlated subquery is
 * unclassified, and unclassified fails: whether a flattened semi-join runs the
 * scan once depends on which table the planner drives, and a gate that guesses
 * "fine" there is the one that waves the next outage through. The cost of being
 * wrong that way is one modeled route and a reason.
 */
export function judgeSongScans(
  rows: PlanRow[],
): Array<{ detail: string; verdict: SongScanVerdict }> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Array<{ detail: string; verdict: SongScanVerdict }> = [];
  for (const row of rows) {
    if (!SONG_SCAN.test(row.detail)) continue;
    let correlated = false;
    let inSubquery = false;
    for (let p = byId.get(row.parent); p; p = byId.get(p.parent)) {
      if (CORRELATED.test(p.detail)) correlated = true;
      if (SUBQUERY.test(p.detail)) inSubquery = true;
    }
    const verdict: SongScanVerdict = correlated
      ? 'per-entity-row'
      : / EXISTS\b/.test(row.detail) || !inSubquery
        ? 'outer-loop'
        : 'once';
    out.push({ detail: row.detail, verdict });
  }
  return out;
}

/** Route paths in library.ts whose handler splices in an entity filter fragment. */
export function discoverListRoutes(source: string): string[] {
  const lines = source.split('\n');
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (!/\b(?:album|artist)FilterWheres\s*\(/.test(line)) return;
    for (let k = i; k >= 0; k--) {
      const m = /app\.(?:get|post)\(\s*'([^']+)'/.exec(lines[k]!);
      if (m) {
        found.push(m[1]!);
        return;
      }
    }
  });
  return [...new Set(found)];
}

export interface Finding {
  route: string;
  label: string;
  reason: string;
  plan: string;
}

export interface Stats {
  plans: number;
  songScans: number;
}

/** Run every (route × filter case) plan and collect what is not evaluated once. */
export function analyze(
  routes: ListRoute[],
  cases: FilterCase[],
): { findings: Finding[]; stats: Stats } {
  const db = new Database(':memory:');
  applySchema(db);
  const findings: Finding[] = [];
  const stats: Stats = { plans: 0, songScans: 0 };

  for (const route of routes) {
    for (const kase of cases) {
      const frag = route.build(parseLibraryFilter(kase.query));
      const clause = frag.wheres.length ? ` AND ${frag.wheres.join(' AND ')}` : '';
      const sql = route.sql.replace('%FILTER%', clause);
      const rows = db
        .query<PlanRow, Array<string | number>>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...frag.params, 100, 0);
      stats.plans++;
      const plan = rows.map((r) => r.detail).join('\n');
      const scans = judgeSongScans(rows);
      stats.songScans += scans.length;
      // A fragment that reads library_songs but plans no song scan means the
      // gate examined nothing for this case — unclassified, not clean.
      if (clause.includes('library_songs') && scans.length === 0) {
        findings.push({
          route: route.route,
          label: kase.label,
          reason: 'the fragment reads library_songs but its plan shows no song scan to judge',
          plan,
        });
        continue;
      }
      for (const scan of scans) {
        if (scan.verdict === 'once') continue;
        findings.push({
          route: route.route,
          label: kase.label,
          reason:
            scan.verdict === 'per-entity-row'
              ? `the song scan sits under a CORRELATED subquery, so it is re-derived per entity row: ${scan.detail}`
              : `the song scan is not inside a once-evaluated subquery, so it runs per entity row: ${scan.detail}`,
          plan,
        });
      }
    }
  }
  return { findings, stats };
}

/** Param keys a case list vouches for, and the ones nothing covers. */
export function coverageGaps(cases: FilterCase[]): { uncovered: string[]; unknown: string[] } {
  const covered = new Set(cases.flatMap((c) => c.covers));
  const keys = new Set(LIBRARY_FILTER_PARAM_KEYS);
  const exempt = new Set(NOT_EXERCISED.map((e) => e.param));
  return {
    uncovered: [...keys].filter((k) => !covered.has(k) && !exempt.has(k)),
    unknown: [...covered].filter((k) => !keys.has(k)),
  };
}

/** Cases the filter grammar drops on the floor — they would plan nothing. */
export function vacuousCases(cases: FilterCase[]): Array<{ label: string; missing: string[] }> {
  const out: Array<{ label: string; missing: string[] }> = [];
  for (const kase of cases) {
    const emitted = new Set(Object.keys(serializeLibraryFilter(parseLibraryFilter(kase.query))));
    const missing = kase.covers.filter((k) => !emitted.has(k));
    if (missing.length) out.push({ label: kase.label, missing });
  }
  return out;
}

async function main(): Promise<void> {
  const fixtureArg = process.argv.indexOf('--fixture');
  const fixture = fixtureArg === -1 ? undefined : process.argv[fixtureArg + 1];
  if (fixture && !FIXTURES[fixture]) {
    console.error(`Unknown fixture "${fixture}" — have: ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(2);
  }
  const routes = fixture ? [...LIST_ROUTES, FIXTURES[fixture]!] : LIST_ROUTES;

  const source = readFileSync(resolve(repoRoot, LIBRARY_ROUTES_FILE), 'utf8');
  const discovered = discoverListRoutes(source);
  const modeled = new Set(LIST_ROUTES.map((r) => r.route));
  const unmodeled = discovered.filter((r) => !modeled.has(r));
  const gone = [...modeled].filter((r) => !discovered.includes(r));

  const { uncovered, unknown } = coverageGaps(FILTER_CASES);
  const vacuous = vacuousCases(FILTER_CASES);
  const { findings, stats } = analyze(routes, FILTER_CASES);

  console.log(
    `Library list queries: ${stats.plans} query plans over ${routes.length} list routes ` +
      `x ${FILTER_CASES.length} filter cases, ${stats.songScans} library_songs scans judged.`,
  );

  let failed = false;
  const fail = (...lines: string[]) => {
    failed = true;
    console.error(`\n${lines.join('\n')}`);
  };

  if (unmodeled.length) {
    fail(
      `List routes in ${LIBRARY_ROUTES_FILE} that this gate does not model: ${unmodeled.join(', ')}.`,
      'Add them to LIST_ROUTES in this file — an unmodeled route is an unmeasured one.',
    );
  }
  if (gone.length) {
    fail(
      `LIST_ROUTES models routes that no longer splice in a filter fragment: ${gone.join(', ')}.`,
      'Remove them, or the denominator counts plans nothing ships.',
    );
  }
  if (uncovered.length) {
    fail(
      `Filter dimensions no case exercises: ${uncovered.join(', ')}.`,
      'Add a case to FILTER_CASES, or a reasoned entry to NOT_EXERCISED.',
    );
  }
  if (unknown.length) {
    fail(
      `FILTER_CASES vouches for params the grammar does not have: ${unknown.join(', ')}.`,
      'A renamed param leaves its dimension unmeasured while the gate still passes.',
    );
  }
  for (const e of NOT_EXERCISED) {
    if (!LIBRARY_FILTER_PARAM_KEYS.includes(e.param)) {
      fail(`NOT_EXERCISED names "${e.param}", which is no longer a filter param — remove it.`);
    }
  }
  for (const v of vacuous) {
    fail(
      `Filter case "${v.label}" is dropped by parseLibraryFilter for: ${v.missing.join(', ')}.`,
      'It plans no SQL for those dimensions, so it measures nothing.',
    );
  }
  if (stats.songScans === 0) {
    fail('No library_songs scan judged at all — the gate is not measuring anything.');
  }
  if (findings.length) {
    failed = true;
    console.error('\nLibrary list queries that do not evaluate the song predicate once:\n');
    for (const f of findings) {
      console.error(`  ${f.route} — ${f.label}`);
      console.error(`    ${f.reason}`);
      console.error(f.plan.replace(/^/gm, '      '));
    }
    console.error(
      '\nThe song predicate reads only the song row, so evaluate it ONCE and test the entity\n' +
        'for membership — `entity.id IN (SELECT … FROM library_songs …)`, which is what\n' +
        'entityFilterWheres (packages/api/src/services/library-filter-sql.ts) emits. No index\n' +
        'fixes the correlated form; the shape is the cost (docs/library-filters.md).',
    );
  }

  if (failed) process.exit(1);
  console.log('Every library list query evaluates the song predicate once.');
}

if (import.meta.main) await main();
