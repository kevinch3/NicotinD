/**
 * Fail when a recommendation feed selects songs without the shared eligibility
 * predicate.
 *
 *   bun run check:feed-eligibility
 *
 * WHY: every feed used to hand-roll `s.hidden = 0 AND s.landed_at IS NOT NULL`
 * — and radio forgot `library_albums.hidden`, so an album a curator hid kept
 * playing on radio while it was gone from every listing. Once "may this song be
 * recommended" has one definition (`services/recommendation/eligibility.ts`),
 * the invariant worth asserting is that no feed answers the question its own
 * way. `check:shared-helpers` cannot see that: a bypass re-declares nothing.
 *
 * A *feed* is a query that proposes songs the listener did not ask for. The
 * separating signal is `ORDER BY RANDOM()` — a listing never samples — plus a
 * short list of modules whose whole purpose is recommendation. A listing route
 * (the Songs tab, an album page, search) is out of scope on purpose: it shows
 * what the library has, and hiding un-analysed songs there would make a fresh
 * download look lost.
 *
 * Per docs/quality-gates.md, a gate must assert its own denominator: it prints
 * how many `library_songs` selects it examined and how many it classified as
 * feeds, and fails on a feed query it cannot vouch for.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { Glob } from 'bun';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Modules that exist to recommend: every song select in them is a feed. */
export const FEED_MODULES: readonly string[] = [
  'packages/api/src/routes/radio.ts',
  'packages/api/src/services/radio-poll-generate.ts',
  'packages/api/src/services/auto-playlists.service.ts',
  'packages/api/src/services/recommendation/',
];

/** Song selects allowed to bypass the predicate, each with the reason why. */
export const ALLOWED: Array<{ file: string; match: string; reason: string }> = [
  {
    file: 'packages/api/src/routes/radio.ts',
    match: 'WHERE s.id = ?',
    reason:
      'a seed lookup by id: the seed is what the listener is already playing, never a recommendation',
  },
  {
    file: 'packages/api/src/routes/radio.ts',
    match: 'SELECT artist_id, title, duration FROM library_songs',
    reason:
      "recording-key lookup for the caller's exclusion list (issue #660) — it removes songs, it never proposes one",
  },
];

/** Interpolations that mark a query as going through the shared predicate. */
const ELIGIBILITY_INTERPOLATION =
  /\$\{[^}]*(?:feedEligibilitySql|feedEligibilityWheres|eligible)\b/;

/** `SELECT ... FROM library_songs` in any spelling this repo uses. */
const SONG_SELECT_SHAPE =
  /FROM\s+library_songs\b|\$\{\s*(?:RADIO_SONG_SELECT|SONG_SELECT|STATION_CENTROID_SELECT)\s*\}/;

export interface TemplateLiteral {
  line: number;
  text: string;
}

/**
 * Every template literal in a TypeScript source, with its start line. Tracks
 * `${ }` nesting so a backtick inside an interpolation does not end the
 * literal early. Good enough for SQL-bearing code; not a TS parser.
 */
export function extractTemplateLiterals(source: string): TemplateLiteral[] {
  const out: TemplateLiteral[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === '\n') line++;
    // Skip line comments and block comments so a backtick in prose is inert.
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (source[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Skip ordinary strings (handles escapes).
      let k = i + 1;
      while (k < n && source[k] !== ch && source[k] !== '\n') {
        if (source[k] === '\\') k++;
        k++;
      }
      i = k + 1;
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      let k = i + 1;
      let depth = 0;
      let text = '';
      while (k < n) {
        const c = source[k]!;
        if (c === '\n') line++;
        if (depth === 0 && c === '\\') {
          text += c + (source[k + 1] ?? '');
          k += 2;
          continue;
        }
        if (depth === 0 && c === '`') break;
        if (c === '$' && source[k + 1] === '{') {
          depth++;
          text += '${';
          k += 2;
          continue;
        }
        if (depth > 0 && c === '{') depth++;
        if (depth > 0 && c === '}') depth--;
        text += c;
        k++;
      }
      out.push({ line: startLine, text });
      i = k + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** The literal with every parenthesised group hollowed out, innermost first. */
export function topLevel(sql: string): string {
  let prev = '';
  let cur = sql;
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/\([^()]*\)/g, ' ');
  }
  return cur;
}

export type Verdict =
  'not-a-song-select' | 'select-fragment' | 'listing' | 'feed-ok' | 'feed-bypass';

/**
 * Judge one template literal. Calibration, from the real fragments:
 *
 *   a. `${RADIO_SONG_SELECT} WHERE s.bpm BETWEEN ? AND ? AND ${eligible} ORDER BY RANDOM()`
 *        → a feed through the predicate: feed-ok
 *   b. `${SONG_SELECT} WHERE s.hidden = 0 AND s.landed_at IS NOT NULL ORDER BY RANDOM() LIMIT ?`
 *        → a feed answering the question itself: feed-bypass
 *   c. `${SONG_SELECT} ${where} LIMIT ? OFFSET ?` in routes/library.ts
 *        → the Songs tab, pages rather than samples: listing
 *   d. `${RADIO_SONG_SELECT} WHERE s.id = ?` in routes/radio.ts
 *        → a seed lookup inside a feed module: feed-bypass unless allowlisted
 *   e. `SELECT s.id, ... FROM library_songs s LEFT JOIN library_albums a ...`
 *        → the RADIO_SONG_SELECT prefix itself, no WHERE: select-fragment
 */
export function classify(literal: string, inFeedModule: boolean): Verdict {
  if (!SONG_SELECT_SHAPE.test(literal)) return 'not-a-song-select';
  const samples = /ORDER\s+BY\s+(?:\([^)]*\),\s*)?RANDOM\s*\(\s*\)/i.test(literal);
  // `RADIO_SONG_SELECT` and friends: a SELECT ... FROM prefix with no WHERE of
  // its own (its correlated subselects have theirs, so look at the top level
  // only). The predicate is judged where the prefix is used, not defined.
  if (!samples && !/\bWHERE\b/i.test(topLevel(literal))) return 'select-fragment';
  if (!samples && !inFeedModule) return 'listing';
  return ELIGIBILITY_INTERPOLATION.test(literal) ? 'feed-ok' : 'feed-bypass';
}

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

async function main(): Promise<void> {
  let selects = 0;
  let feeds = 0;
  const bypasses: Finding[] = [];
  const usedAllow = new Set<number>();

  for await (const rel of new Glob('packages/api/src/**/*.ts').scan({ cwd: repoRoot })) {
    if (rel.includes('node_modules') || rel.endsWith('.test.ts')) continue;
    const file = relative(repoRoot, resolve(repoRoot, rel));
    const source = readFileSync(resolve(repoRoot, rel), 'utf8');
    const inFeedModule = FEED_MODULES.some((m) =>
      m.endsWith('/') ? file.startsWith(m) : file === m,
    );
    for (const lit of extractTemplateLiterals(source)) {
      const verdict = classify(lit.text, inFeedModule);
      if (verdict === 'not-a-song-select' || verdict === 'select-fragment') continue;
      selects++;
      if (verdict === 'listing') continue;
      feeds++;
      if (verdict === 'feed-ok') continue;
      const idx = ALLOWED.findIndex((a) => a.file === file && lit.text.includes(a.match));
      if (idx !== -1) {
        usedAllow.add(idx);
        continue;
      }
      bypasses.push({
        file,
        line: lit.line,
        snippet: lit.text.replace(/\s+/g, ' ').trim().slice(0, 140),
      });
    }
  }

  console.log(
    `Feed eligibility: ${selects} library_songs selects examined, ${feeds} classified as feeds.`,
  );
  const stale = ALLOWED.filter((_, i) => !usedAllow.has(i));
  if (stale.length) {
    console.error('\nAllowlist entries that matched nothing (remove them or fix the match):');
    for (const a of stale) console.error(`  ${a.file} — "${a.match}"`);
    process.exit(1);
  }
  if (bypasses.length) {
    console.error('\nFeed queries that select songs without the shared eligibility predicate:\n');
    for (const b of bypasses) {
      console.error(`  ${b.file}:${b.line}`);
      console.error(`    ${b.snippet}`);
    }
    console.error('\nInterpolate feedEligibilitySql(...) (services/recommendation/eligibility.ts)');
    console.error('into the WHERE, or add a reasoned entry to ALLOWED in this file.');
    process.exit(1);
  }
  if (feeds === 0) {
    console.error('No feed query classified at all — the gate is not measuring anything.');
    process.exit(1);
  }
  console.log('Every recommendation feed goes through the shared eligibility predicate.');
}

if (import.meta.main) await main();
