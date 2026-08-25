import { describe, expect, it } from 'bun:test';
import { isNameSearch, NAME_COLUMNS } from './check-search-matching.js';

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
