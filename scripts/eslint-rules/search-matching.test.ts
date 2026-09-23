import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALLOWED, isNameSearch, NAME_COLUMNS } from './search-matching.js';
import { lintReaches, lintWith, repoRoot, ruleIsOn } from './test-support.js';

describe('isNameSearch — flags a bypass', () => {
  it('flags the MCP surface as it shipped (issue #706)', () => {
    expect(
      isNameSearch(
        "'SELECT id, name FROM library_artists WHERE name LIKE ? COLLATE NOCASE ORDER BY album_count DESC LIMIT ?',",
      ),
    ).toBe(true);
  });

  it('flags the Songs tab as it shipped (issue #719)', () => {
    expect(
      isNameSearch(
        `\`(s.title LIKE ? ESCAPE '\\\\' OR s.artist LIKE ? ESCAPE '\\\\' OR a.name LIKE ? ESCAPE '\\\\') COLLATE NOCASE\`,`,
      ),
    ).toBe(true);
  });

  it('flags a bare title search with no collation at all', () => {
    expect(isNameSearch('WHERE title LIKE ?')).toBe(true);
  });

  it('flags every name column it knows about', () => {
    for (const col of NAME_COLUMNS) {
      expect(isNameSearch(`WHERE ${col} LIKE ?`)).toBe(true);
    }
  });
});

describe('isNameSearch — leaves legitimate LIKEs alone', () => {
  it('ignores a structural pattern over a literal (compound-artist detection)', () => {
    expect(
      isNameSearch(
        `name LIKE '% & %' OR name LIKE '%, %' OR name LIKE '% / %' OR name LIKE '% + %'`,
      ),
    ).toBe(false);
    expect(isNameSearch(`OR name LIKE '% and %' OR name LIKE '% y %' OR name LIKE '% x %'`)).toBe(
      false,
    );
  });

  it('ignores a genre keyword — not a name column', () => {
    expect(isNameSearch(`"(s.genre LIKE '%latin%' OR s.genre LIKE '%cumbia%')"`)).toBe(false);
  });

  it('ignores sqlite_master bookkeeping', () => {
    expect(
      isNameSearch(
        `\`SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'\``,
      ),
    ).toBe(false);
  });

  it('ignores a path/url LIKE', () => {
    expect(isNameSearch('WHERE relative_path LIKE ?')).toBe(false);
    expect(isNameSearch('WHERE url LIKE ?')).toBe(false);
  });

  it('ignores a line that merely mentions LIKE in prose', () => {
    expect(isNameSearch('// Free-text search across song title. LIKE special characters')).toBe(
      false,
    );
  });

  it('ignores a JSDoc continuation line mentioning LIKE', () => {
    // A `*` continuation carries no `//`, so it needs its own rule — three real
    // docblocks in this repo discuss the LIKE below them.
    expect(isNameSearch(' * write plain `s.genre LIKE …`; expandGenreWhere swaps this in')).toBe(
      false,
    );
    expect(
      isNameSearch(
        " * (title/name + artist). This fixes two gaps a single raw `LIKE '%query%'` had:",
      ),
    ).toBe(false);
    expect(
      isNameSearch('/** Longest alphanumeric token in a genre string, for the LIKE-widened pool.'),
    ).toBe(false);
  });

  it('reads the column through a LOWER()/UPPER() wrapper', () => {
    // The radio genre pool concatenates its pattern: `LOWER(s.genre) LIKE '%' ||
    // ? || '%'`. The column is still `genre`, so this is not a name search —
    // but a regex expecting a bare word before LIKE cannot see it and would
    // fall through to the unclassified branch.
    expect(isNameSearch(`WHERE LOWER(s.genre) LIKE '%' || ? || '%' AND s.hidden = 0`)).toBe(false);
  });

  it('still flags a name column read through a LOWER() wrapper', () => {
    expect(isNameSearch(`WHERE LOWER(s.title) LIKE ?`)).toBe(true);
  });
});

describe('isNameSearch — refuses to stay quiet about what it cannot classify', () => {
  it('flags a LIKE it cannot parse into a column/operand clause', () => {
    // Interpolated SQL hides the column from a text scan. Reporting it clean
    // would be the false denominator docs/quality-gates.md warns about.
    expect(isNameSearch('const clause = `${col} LIKE ${bind}`')).toBe(true);
  });

  it('flags a name column whose parameter arrives through concatenation', () => {
    // `LIKE '%' || ? || '%'` puts a literal directly after LIKE, so a check
    // that only looks at the first operand would call this a literal pattern
    // and wave it through — while the user's text is right there in the `?`.
    expect(isNameSearch(`WHERE LOWER(s.title) LIKE '%' || ? || '%'`)).toBe(true);
    expect(isNameSearch(`WHERE name LIKE '%' || ? || '%'`)).toBe(true);
  });
});

const FILE = 'packages/api/src/routes/some-route.ts';
const lines = (code: string, file = FILE) =>
  lintWith('search-matching', code, file).map((m) => m.line);

describe('nicotind/search-matching — the rule', () => {
  it('reports the #706 query where it sits in the source', () => {
    const src = [
      'const q = db.prepare(',
      "  'SELECT id, name FROM library_artists WHERE name LIKE ? COLLATE NOCASE LIMIT ?',",
      ');',
    ].join('\n');
    expect(lines(src)).toEqual([2]);
  });

  it('reports the right line inside a multi-line template literal, once', () => {
    const src = [
      'const where = `',
      '  WHERE s.hidden = 0',
      '  AND (s.title LIKE ? OR s.artist LIKE ?)',
      '  ${inner ? `AND a.name LIKE ?` : ""}',
      '`;',
    ].join('\n');
    expect(lines(src)).toEqual([3, 4]);
  });

  it('ignores the same SQL in a comment, which the line scan it replaced read as code', () => {
    expect(lines('// e.g. WHERE name LIKE ? COLLATE NOCASE\nconst x = 1;')).toEqual([]);
    expect(lines('/* WHERE title LIKE ? */\nconst x = 1;')).toEqual([]);
  });

  it('ignores a structural literal pattern and a non-name column', () => {
    expect(lines("const c = `name LIKE '% & %' OR s.genre LIKE ?`;")).toEqual([]);
  });

  it('exempts the canonical matcher module', () => {
    const [allowed] = ALLOWED;
    expect(lines("const q = 'WHERE name LIKE ?';", allowed!.file)).toEqual([]);
  });
});

// The denominator. A lint rule prints nothing about what it examined, so the set is asserted
// here: every source file that holds a LIKE in code must be one `bun run lint` reaches with the
// rule switched on. A glob or `ignores` change that drops one fails this, not silently the gate.
describe('nicotind/search-matching — what it examines', () => {
  it('is on for every non-test source file that holds a LIKE', async () => {
    const files: string[] = [];
    for await (const rel of new Glob('packages/*/src/**/*.ts').scan({ cwd: repoRoot })) {
      if (rel.includes('node_modules') || rel.endsWith('.test.ts')) continue;
      if (ALLOWED.some((a) => a.file === rel)) continue;
      if (/\bLIKE\b/.test(readFileSync(resolve(repoRoot, rel), 'utf8'))) files.push(rel);
    }
    // 25 SQL fragments across these files when the rule replaced the script (#1316).
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      expect({ file, on: await ruleIsOn('nicotind/search-matching', file) }).toEqual({
        file,
        on: true,
      });
      expect({ file, reached: await lintReaches(file) }).toEqual({ file, reached: true });
    }
  });
});
