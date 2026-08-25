/**
 * Fail when a search surface matches library names with raw SQL instead of the
 * shared folded matcher.
 *
 *   bun run check:search-matching
 *
 * WHY: `check:shared-helpers` asserts that nobody *re-declares* a shared helper.
 * It cannot see a call site that **bypasses** one. The MCP agent surface matched
 * artists with `name LIKE ? COLLATE NOCASE` (issue #706) — no local copy of
 * `matchesAllTokens` to find, so the gate reported "no local re-implementations
 * found" and exited 0 truthfully while the actual invariant — every search
 * surface matches the same way — went unmeasured. SQLite's NOCASE collation is
 * ASCII-only: it folds neither diacritics nor a non-ASCII upper case, so
 * `LIKE '%Americo%'` and even `LIKE '%AMÉRICO%'` both miss `Américo`.
 *
 * This gate asserts the invariant instead of the symbol: a `LIKE` against a
 * library *name* column must live in the canonical matcher's module or carry a
 * reasoned allowlist entry.
 *
 * Per docs/quality-gates.md, a gate must assert its own denominator: this one
 * prints how many SQL string literals it examined and fails when it cannot
 * classify one, so a version that silently finds nothing cannot pass as clean.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { Glob } from 'bun';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** The columns that hold a human-facing name a user or agent searches by. */
export const NAME_COLUMNS = ['name', 'title', 'artist', 'album_name', 'artist_name'];

/** Modules allowed to match a name column in SQL, each with the reason why. */
export const ALLOWED: Array<{ file: string; reason: string }> = [
  {
    file: 'packages/api/src/services/search-tokens.ts',
    reason: 'the canonical matcher itself',
  },
];

export interface Bypass {
  file: string;
  line: number;
  snippet: string;
}

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
 */
export function isNameSearch(sqlFragment: string): boolean {
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
  let m: RegExpExecArray | null;
  let sawClause = false;
  while ((m = LIKE_CLAUSE.exec(code)) !== null) {
    sawClause = true;
    const [, column, operand] = m;
    if (!NAME_COLUMNS.includes(column!.toLowerCase())) continue;
    // A bound parameter anywhere in the operand carries user text and must be
    // folded. An operand made only of quoted literals is a pattern the code
    // chose, and has nothing to fold.
    if (operand!.includes('?')) return true;
  }

  // A `LIKE` we could not parse into a clause is unclassified, not clean. Flag
  // it so the gate fails loudly rather than reporting a denominator it never
  // actually examined — the failure mode docs/quality-gates.md is about. String
  // concatenation (`LIKE ' || ? || '`) lands here on purpose.
  return !sawClause;
}

async function main(): Promise<void> {
  const found: Bypass[] = [];
  let examined = 0;
  const allowed = new Set(ALLOWED.map((a) => a.file));

  for await (const rel of new Glob('packages/*/src/**/*.ts').scan({ cwd: repoRoot })) {
    if (rel.includes('node_modules') || rel.endsWith('.test.ts')) continue;
    const normalized = relative(repoRoot, resolve(repoRoot, rel));
    if (allowed.has(normalized)) continue;
    let source: string;
    try {
      source = readFileSync(resolve(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    source.split('\n').forEach((text, i) => {
      if (!/\bLIKE\b/.test(text)) return;
      examined++;
      if (isNameSearch(text)) found.push({ file: normalized, line: i + 1, snippet: text.trim() });
    });
  }

  console.log(`Search matching: ${examined} SQL fragments containing LIKE examined.`);
  if (found.length > 0) {
    console.error('\nName-column search done in raw SQL instead of the shared matcher:\n');
    for (const f of found) {
      console.error(`  ${f.file}:${f.line}`);
      console.error(`    ${f.snippet}`);
    }
    console.error("\nSQLite's NOCASE collation is ASCII-only — it folds neither diacritics nor a");
    console.error('non-ASCII upper case, so "Americo" and "AMÉRICO" both miss "Américo".');
    console.error('Route the query through tokenize/matchesAllTokens (services/search-tokens.ts),');
    console.error('or add a reasoned entry to ALLOWED in this file.');
    process.exit(1);
  }
  console.log('No raw name-column search found outside the canonical matcher.');
}

if (import.meta.main) await main();
