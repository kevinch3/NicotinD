/**
 * ESLint rule `nicotind/search-matching`: fail when a search surface matches
 * library names with raw SQL instead of the shared folded matcher. Formerly
 * `check:search-matching` (#1316), which scanned every source *line*; the rule
 * reads only string and template literals, so prose can no longer trip it.
 *
 * WHY: `nicotind/shared-helpers` asserts that nobody *re-declares* a shared
 * helper. It cannot see a call site that **bypasses** one. The MCP agent surface
 * matched artists with `name LIKE ? COLLATE NOCASE` (#706), and the Songs tab did
 * the same (#719). SQLite's NOCASE collation is ASCII-only: it folds neither
 * diacritics nor a non-ASCII upper case, so `LIKE '%Americo%'` and even
 * `LIKE '%AMÉRICO%'` both miss `Américo`.
 *
 * This asserts the invariant instead of the symbol: a `LIKE` against a library
 * *name* column must live in the canonical matcher's module or carry a reasoned
 * `ALLOWED` entry. Denominator: `search-matching.test.ts` asserts every source
 * file holding a `LIKE` is one the lint command reaches with this rule on.
 */
import { relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

/** The columns that hold a human-facing name a user or agent searches by. */
export const NAME_COLUMNS = ['name', 'title', 'artist', 'album_name', 'artist_name'];

/** Modules allowed to match a name column in SQL, each with the reason why. */
export const ALLOWED = [
  {
    file: 'packages/api/src/services/search-tokens.ts',
    reason: 'the canonical matcher itself',
  },
];

/**
 * Decide whether one SQL fragment is a *search* over a name column — the thing
 * that must go through the shared folded matcher — or something else that
 * legitimately uses LIKE on a name.
 *
 * The real fragments in this repo, for calibration:
 *
 *   a. `s.title LIKE ? ESCAPE '\\' OR s.artist LIKE ?`   ← a user search: FLAG
 *   b. `name LIKE ? COLLATE NOCASE`                       ← a user search: FLAG
 *   c. `name LIKE '% & %' OR name LIKE '% y %'`           ← compound-artist
 *        detection in enrichment/tasks.ts: a structural pattern over a fixed
 *        literal, nothing to fold. NOT a search.
 *   d. `s.genre LIKE '%cumbia%'`                          ← genre keyword, not
 *        a name column at all.
 *   e. `name NOT LIKE 'sqlite_%'`                         ← sqlite_master, not
 *        a library table.
 *
 * The separating signal is **not** the column — (a), (b) and (c) are all
 * `name`/`title`. It is what the LIKE is compared against: a search binds a
 * bound parameter (`?`) holding text a user typed, while a structural pattern
 * matches a literal the code itself chose. A literal cannot need folding,
 * because the author already knows exactly what they wrote.
 *
 * Deliberately conservative in one direction only: a fragment that pairs a name
 * column with a bound parameter is flagged even if it also contains literals,
 * because that is the shape of every instance of this bug found so far (#706,
 * #719). A false positive costs one allowlist entry with a reason; a false
 * negative is the bug shipping again with a green gate.
 *
 * @param {string} sqlFragment
 * @returns {boolean}
 */
export function isNameSearch(sqlFragment) {
  // Prose is not SQL: several real comments and docblocks in this repo explain
  // the LIKE below them, and flagging those is noise that trains people to
  // ignore the gate. A `*` continuation line inside a block comment carries no
  // `//`, so it needs its own rule.
  if (/^\s*(?:\*|\/\/|\/\*)/.test(sqlFragment)) return false;
  const code = sqlFragment.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '');
  if (!/\bLIKE\b/i.test(code)) return false;
  // `sqlite_master.name` is not a library table — exclude before anything else.
  if (/\bsqlite_master\b|\bsqlite_%/.test(code)) return false;

  // Find each `<column> [NOT] LIKE <operand>` triple and judge it on its own:
  // one line can hold several, and only the name-column-plus-parameter ones
  // matter. The column may be qualified ("s.title"), bare ("name"), or wrapped
  // in a case function ("LOWER(s.genre)") — the radio genre pool uses the last.
  // The right-hand side runs to the end of the operand *expression*, not just
  // its first token: `LIKE '%' || ? || '%'` puts a literal first and the user's
  // text in the `?` behind it, so stopping at the literal would wave through
  // exactly the search this gate exists to catch.
  const LIKE_CLAUSE =
    /(?:\b(?:LOWER|UPPER)\s*\(\s*)?(?:\w+\s*\.\s*)?(\w+)\s*\)?\s+(?:NOT\s+)?LIKE\s+((?:\?|'[^']*'|"[^"]*")(?:\s*\|\|\s*(?:\?|'[^']*'|"[^"]*"))*)/gi;
  let m;
  let sawClause = false;
  while ((m = LIKE_CLAUSE.exec(code)) !== null) {
    sawClause = true;
    const [, column, operand] = m;
    if (!NAME_COLUMNS.includes(column.toLowerCase())) continue;
    // A bound parameter anywhere in the operand carries user text and must be
    // folded. An operand made only of quoted literals is a pattern the code
    // chose, and has nothing to fold.
    if (operand.includes('?')) return true;
  }

  // A `LIKE` we could not parse into a clause is unclassified, not clean. Flag
  // it so the gate fails loudly rather than reporting a denominator it never
  // actually examined — the failure mode docs/quality-gates.md is about. String
  // concatenation (`LIKE ' || ? || '`) lands here on purpose.
  return !sawClause;
}

/** @param {import('eslint').Rule.Node} node */
function insideTemplate(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'TemplateLiteral') return true;
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'A LIKE over a library name column must use the shared folded matcher' },
    schema: [],
  },
  create(context) {
    const file = relative(repoRoot, context.filename).replace(/\\/g, '/');
    if (ALLOWED.some((a) => a.file === file)) return {};
    const sourceCode = context.sourceCode;

    /** @param {import('eslint').Rule.Node} node */
    function visit(node) {
      // The outermost literal carries the whole SQL, `${}` interpolations
      // included; judging a nested one again would report the same line twice.
      if (insideTemplate(node)) return;
      const text = sourceCode.getText(node);
      if (!/\bLIKE\b/.test(text)) return;
      const startLine = node.loc.start.line;
      text.split('\n').forEach((line, i) => {
        if (!/\bLIKE\b/.test(line) || !isNameSearch(line)) return;
        context.report({
          loc: { line: startLine + i, column: 0 },
          message:
            "Name-column search in raw SQL: SQLite's NOCASE folds neither diacritics nor " +
            'non-ASCII case, so "AMÉRICO" misses "Américo". Route it through ' +
            'tokenize/matchesAllTokens (services/search-tokens.ts), or add a reasoned ' +
            'ALLOWED entry in scripts/eslint-rules/search-matching.js.',
        });
      });
    }
    return {
      Literal: (node) => {
        if (typeof node.value === 'string') visit(node);
      },
      TemplateLiteral: visit,
    };
  },
};
