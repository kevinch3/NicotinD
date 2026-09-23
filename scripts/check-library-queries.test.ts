import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FILTER_CASES,
  FIXTURES,
  LIST_ROUTES,
  NOT_EXERCISED,
  analyze,
  coverageGaps,
  discoverListRoutes,
  judgeSongScans,
  vacuousCases,
  type PlanRow,
} from './check-library-queries.js';

const repoRoot = resolve(import.meta.dir, '..');
const CHECKER = resolve(import.meta.dir, 'check-library-queries.ts');

function rows(...triples: Array<[number, number, string]>): PlanRow[] {
  return triples.map(([id, parent, detail]) => ({ id, parent, detail }));
}

describe('judgeSongScans', () => {
  it('accepts the song scan inside a non-correlated LIST SUBQUERY', () => {
    // The real /artists?country= plan, trimmed to the nodes that matter.
    const plan = rows(
      [4, 0, 'SEARCH library_artists USING INDEX idx_library_artists_hidden (hidden=?)'],
      [12, 0, 'LIST SUBQUERY 8'],
      [14, 12, 'COMPOUND QUERY'],
      [15, 14, 'LEFT-MOST SUBQUERY'],
      [22, 15, 'SEARCH ls USING INDEX idx_library_songs_hidden (hidden=?)'],
      [151, 0, 'USE TEMP B-TREE FOR ORDER BY'],
    );
    expect(judgeSongScans(plan)).toEqual([
      {
        detail: 'SEARCH ls USING INDEX idx_library_songs_hidden (hidden=?)',
        verdict: 'once',
      },
    ]);
  });

  it('flags the pre-#1055 correlated EXISTS, driven by the outer loop', () => {
    const plan = rows(
      [11, 0, 'SEARCH library_artists USING INDEX idx_library_artists_hidden (hidden=?)'],
      [16, 0, 'SEARCH ls EXISTS USING INDEX idx_library_songs_hidden (hidden=?)'],
      [69, 0, 'USE TEMP B-TREE FOR ORDER BY'],
    );
    expect(judgeSongScans(plan).map((s) => s.verdict)).toEqual(['outer-loop']);
  });

  it('flags a song scan buried under a CORRELATED subquery', () => {
    const plan = rows(
      [4, 0, 'SEARCH library_albums USING INDEX idx_library_albums_grid (hidden=?)'],
      [10, 0, 'CORRELATED SCALAR SUBQUERY 1'],
      [16, 10, 'SEARCH ls USING INDEX idx_library_songs_album_id (album_id=?)'],
    );
    expect(judgeSongScans(plan).map((s) => s.verdict)).toEqual(['per-entity-row']);
  });

  it('judges the table name as well as the `ls` alias', () => {
    const plan = rows(
      [4, 0, 'SEARCH library_albums USING INDEX idx_library_albums_grid (hidden=?)'],
      [10, 0, 'CORRELATED SCALAR SUBQUERY 1'],
      [16, 10, 'SCAN library_songs'],
    );
    expect(judgeSongScans(plan).map((s) => s.verdict)).toEqual(['per-entity-row']);
  });

  it('ignores a correlated probe of a table that is not library_songs', () => {
    // The membership subquery's own per-song origin lookup: correlated on `ls`
    // inside a once-evaluated subquery, which is the shape we want.
    const plan = rows(
      [12, 0, 'LIST SUBQUERY 8'],
      [22, 12, 'SEARCH ls USING INDEX idx_library_songs_hidden (hidden=?)'],
      [
        27,
        12,
        'SEARCH lo EXISTS USING INDEX sqlite_autoindex_library_artist_origins_1 (artist_id=?)',
      ],
      [29, 12, 'CORRELATED LIST SUBQUERY 2'],
      [34, 29, 'SEARCH library_song_artists USING COVERING INDEX (song_id=?)'],
    );
    expect(judgeSongScans(plan).map((s) => s.verdict)).toEqual(['once']);
  });
});

describe('the real list queries', () => {
  it('evaluate the song predicate once, across every filter dimension', () => {
    const { findings, stats } = analyze(LIST_ROUTES, FILTER_CASES);
    expect(findings).toEqual([]);
    // Denominator: a run that judged nothing would report no findings too.
    expect(stats.plans).toBe(LIST_ROUTES.length * FILTER_CASES.length);
    expect(stats.songScans).toBeGreaterThan(0);
  });

  it('are every route in library.ts that splices in an entity filter fragment', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/api/src/routes/library.ts'), 'utf8');
    expect(discoverListRoutes(source).sort()).toEqual(LIST_ROUTES.map((r) => r.route).sort());
  });
});

describe('discoverListRoutes', () => {
  it('attributes a builder call to the route it is nested in, not the import', () => {
    const source = [
      "import { albumFilterWheres, artistFilterWheres } from '../services/library-filter-sql.js';",
      "app.get('/artists', (c) => {",
      '  const frag = artistFilterWheres(filter);',
      '});',
      "app.get('/albums', async (c) => {",
      '  const frag = albumFilterWheres(parseLibraryFilter(c.req.queries()));',
      '});',
      "app.get('/songs', (c) => songFilterWheres(filter, 's'));",
    ].join('\n');
    expect(discoverListRoutes(source)).toEqual(['/artists', '/albums']);
  });
});

describe('the gate cannot pass vacuously', () => {
  it('flags the known-bad correlated fixture on every song-level dimension', () => {
    const { findings } = analyze([FIXTURES['correlated']!], FILTER_CASES);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.route === '/fixture-correlated')).toBe(true);
    // Entity-level starred carries no song predicate, so it is the one case
    // with nothing to flag — every other dimension must be caught.
    expect(new Set(findings.map((f) => f.label)).size).toBe(FILTER_CASES.length - 1);
  });

  it('exits non-zero on the fixture and zero on the real queries', () => {
    const run = (args: string[]) =>
      Bun.spawnSync(['bun', 'run', CHECKER, ...args], { cwd: repoRoot }).exitCode;
    expect(run([])).toBe(0);
    expect(run(['--fixture', 'correlated'])).toBe(1);
  });

  it('reports a filter dimension nothing exercises', () => {
    const { uncovered } = coverageGaps(FILTER_CASES.filter((c) => !c.covers.includes('country')));
    expect(uncovered).toEqual(['country']);
    expect(coverageGaps(FILTER_CASES).uncovered).toEqual([]);
  });

  it('reports a case vouching for a param the grammar does not have', () => {
    const { unknown } = coverageGaps([
      ...FILTER_CASES,
      { label: 'typo', query: { bpmMin: '1' }, covers: ['bpmMinimum'] },
    ]);
    expect(unknown).toEqual(['bpmMinimum']);
    expect(coverageGaps(FILTER_CASES).unknown).toEqual([]);
  });

  it('reports a case the filter grammar drops on the floor', () => {
    // The licence tombstone: parsed away, so it would plan no SQL at all.
    expect(
      vacuousCases([
        { label: 'licence', query: { licence: 'public-domain' }, covers: ['licence'] },
      ]),
    ).toEqual([{ label: 'licence', missing: ['licence'] }]);
    expect(vacuousCases(FILTER_CASES)).toEqual([]);
  });

  it('exempts only params that still exist in the grammar', () => {
    expect(NOT_EXERCISED.map((e) => e.param)).toEqual(['licence']);
    for (const e of NOT_EXERCISED) expect(e.reason.length).toBeGreaterThan(20);
  });
});
