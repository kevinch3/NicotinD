/**
 * CLAUDE.md drift checker (issue #255).
 *
 *   bun run scripts/check-claude-md.ts          # report + exit 1 on drift
 *   bun run scripts/check-claude-md.ts --list   # print every checked identifier
 *
 * WHY: CLAUDE.md is "an index, kept deliberately small because it loads into
 * every request". A code symbol it names that doesn't exist isn't merely stale —
 * it is read as ground truth on every task and sends work down a path that was
 * never there. Two confirmed cases motivated this: the queue bullet named three
 * methods that never existed (`playNextTrack`/`hasTrack`/`shuffleQueue` — really
 * `queueNext`/`removeFromQueue`/`toggleShuffle`), and `playNextAction`/
 * `addToQueueAction` in `track-utils.ts`, which exports neither.
 *
 * Renames are the main source: the code moves, the index doesn't. So is a repo
 * split: phase 4 moved the slskd hunt engine to its own repo and the index kept
 * describing it in the present tense.
 *
 * EXISTENCE MUST BE PROVEN BY CODE, NOT PROSE. This grep excluded CLAUDE.md but
 * not docs/, so a symbol could be "proven" to exist by the very documentation
 * page that made the claim. Measured 2026-08: 15 of 445 identifiers existed
 * nowhere in code and the gate reported zero drift — including `CastController`,
 * for a cast feature that was never built. See docs/quality-gates.md.
 *
 * DESIGN: a heuristic gate that cries wolf gets muted, so this deliberately
 * checks only identifiers that make a *strong* claim — camelCase/PascalCase
 * symbols and `foo()` call forms — and searches the WHOLE repo (`packages/desktop/
 * electron/`, `scripts/`, config JSON and package.json all legitimately host
 * named things). Everything else it sees is reported under `--list` but never
 * fails the build. Deliberate non-code mentions live in ALLOWLIST below.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const CLAUDE_MD = join(repoRoot, 'CLAUDE.md');

/**
 * Identifiers CLAUDE.md names on purpose that are not repo symbols. Each entry
 * needs a reason — an allowlist nobody can audit is just a mute button.
 */
const ALLOWLIST = new Map<string, string>([
  // Config keys owned by other tools' schemas.
  ['dataGroups', 'ngsw-config.json key (Angular service worker schema)'],
  // Deliberate mentions of something that is NOT here — the sentence's point is
  // its absence, so a "missing" verdict would be the gate misreading English.
  [
    'ApiService',
    'CLAUDE.md says "there is no monolithic `ApiService`" — naming the thing that does not exist IS the claim',
  ],
  [
    'SpotdlPlugin',
    'CLAUDE.md says "its former `SpotdlPlugin` was removed in the phase-4 spotdl cutover"',
  ],
]);

/**
 * Symbols CLAUDE.md names that are real, but live in a **different repo**.
 *
 * The phase-4 addon split moved the slskd hunt engine out wholesale. The index
 * kept describing it in the present tense with no hint of where it went, so a
 * reader told that `isBloatedFolder` demotes bloated candidates would search
 * this repo, find nothing, and conclude the doc was lying. It wasn't — every
 * one of these was verified to exist in the addon repo at the path below.
 *
 * The check is **inverted**: an entry that starts existing locally FAILS. A
 * plain allowlist only ever grows and can rot into a mute button; this map
 * cannot, because re-homing a symbol here breaks the build until it is removed.
 *
 * CLAUDE.md must also *say* the addon owns these, or the map and the prose
 * disagree and only the map is checkable.
 */
export const EXTERNAL_SYMBOLS = new Map<string, string>([
  ['AlbumHunterService', 'slskd-addon src/services/album-hunter.service.ts:326'],
  ['isBloatedFolder', 'slskd-addon src/services/album-hunter.service.ts:130'],
  ['searchAndScore', 'slskd-addon src/services/album-hunter.service.ts:337 (method)'],
  ['huntBase', 'slskd-addon src/services/album-hunter.service.ts:363 (method)'],
  ['FallbackHost', 'slskd-addon src/services/album-fallback.service.ts:15'],
  ['isStalled', 'slskd-addon src/services/album-fallback.service.ts:526 (method)'],
  ['stallThresholdMs', 'slskd-addon src/services/album-fallback.service.ts:148'],
  ['TransferPoller', 'slskd-addon src/services/transfer-poller.ts:41'],
]);

/**
 * SIZE BUDGET.
 *
 * WHY: this file's own header calls it "an index, kept deliberately small
 * because it loads into every request" — and nothing measured that, so it grew
 * to 186 KB / 2,038 lines, with a median index entry of ~1,340 characters and
 * the largest at 7,287. The symbol check above proved every *name* in it was
 * real while the file quietly became the detail store `docs/` already was: an
 * audit found 1,316 of its 1,350 backticked facts duplicated in docs/, and only
 * three rationale phrases that lived nowhere else.
 *
 * That is this repo's recurring shape — a gate that answers truthfully about
 * the thing it happens to measure, and is silent about the thing that actually
 * broke (see docs/quality-gates.md, "every gate asserts its own denominator").
 * A prose rule cannot hold here: the cheapest place to record a hard-won
 * rationale is always the file that is guaranteed to be read, so the pressure
 * to inline "just one more paragraph" is constant and one-directional.
 *
 * The caps are set from the measured post-restructure file (139 entries, median
 * prose 234, max 371, 50 KB) with headroom, so they bind on *narrative regrowth*
 * rather than on ordinary editing: ~35 more entries fit under the byte budget,
 * and 440 characters of prose is comfortable for "what it is + the symbols you
 * would grep for" while no narrative fits in it. Deliberately NOT set just above
 * the current value — a gate that fires on the next honest addition gets raised
 * reflexively, and a threshold nobody believes is a threshold nobody enforces.
 * Neither cap is a law of nature: raising one is fine, but it should be a commit
 * that says why, which is exactly what an un-measured prose rule never forced.
 *
 * Raised 60 KB → 65 KB on 2026-08-29, measured at 151 entries / 55.3 KB with
 * median prose 246 and max 387: the growth since the baseline is twelve new
 * index entries, not narrative regrowth, and the old cap fell inside the test's
 * 5 KB headroom floor. ~26 more entries fit again at the current average.
 */
export const MAX_ENTRY_CHARS = 440;
export const MAX_FILE_BYTES = 65_000;

/**
 * The gate's denominator. If entry parsing silently found nothing — a heading
 * convention changed, the bullets became a table — every size check below would
 * pass vacuously. Fewer entries than this means "I could not read this file",
 * not "this file is fine", so main() fails on it.
 */
export const MIN_PLAUSIBLE_ENTRIES = 60;

export interface IndexEntry {
  name: string;
  chars: number;
  line: number;
}

/**
 * Strip the trailing `→ [doc.md](docs/doc.md)` handoffs before measuring.
 *
 * WHY: a link costs ~55 characters, so charging them to the entry budget taxes
 * an entry for citing its sources — and an entry that legitimately spans two
 * docs gets ~110 characters less room to say anything than one that spans one.
 * That is backwards. The links are the entire point of the index; the prose is
 * what regrows. Measured the other way while writing this gate, the binding
 * pressure on the one over-cap entry was to **drop a correct second link**,
 * which is the opposite of what the budget exists to encourage.
 */
export function entryProse(text: string): string {
  return text
    .replace(/\[[^\]]*\]\(docs\/[^)]*\)/g, '')
    .replace(/→\s*[,\s]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every top-level `- ` bullet plus its indented continuation lines.
 *
 * Length is the entry's *prose* (see entryProse) with whitespace collapsed, so
 * neither re-wrapping a line nor adding a doc link can change the verdict — the
 * budget is about how much a reader must take in, not where the newlines fall.
 */
export function indexEntries(md: string): IndexEntry[] {
  const lines = md.split('\n');
  const entries: IndexEntry[] = [];
  let buf: string | null = null;
  let start = 0;

  const flush = () => {
    if (buf === null) return;
    const text = buf.replace(/\s+/g, ' ').trim();
    entries.push({
      name: text.match(/\*\*(.+?)\*\*/)?.[1] ?? text.slice(2, 60),
      chars: entryProse(text).length,
      line: start,
    });
    buf = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('- ')) {
      flush();
      buf = l;
      start = i + 1;
    } else if (buf !== null && /^ {2}\S/.test(l)) {
      buf += ' ' + l.trim();
    } else {
      flush();
    }
  }
  flush();
  return entries;
}

/** Extract every backticked span from the doc. */
function backtickedSpans(md: string): string[] {
  return [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
}

/**
 * Keep only spans making a strong, checkable claim about a repo symbol.
 * A bare lowercase word in backticks is usually prose emphasis or a CLI flag;
 * a camelCase/PascalCase name or a `foo()` call is a claim about code.
 */
export function isCheckableIdentifier(span: string): boolean {
  if (ALLOWLIST.has(span)) return false;
  // Strip a trailing call form so `foo()` checks as `foo`.
  const bare = span.replace(/\(\)$/, '');
  // Reject anything with structure we don't want to reason about: paths,
  // spaces, generics, env vars, globs, versions, HTTP verbs + routes.
  if (/[\s/\\<>{}[\]|,;:="'#$*]/.test(bare)) return false;
  if (bare.includes('.')) return false; // `foo.bar` — member access, checked as its parts elsewhere
  if (bare.length < 4) return false;
  if (/^[A-Z0-9_]+$/.test(bare)) return false; // SCREAMING_CASE = env var / constant convention
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(bare)) return false; // no hyphens/underscores
  // The strong-claim filter: must contain an internal capital (camel/Pascal).
  return /[a-z][A-Z]/.test(bare) || /^[A-Z][a-z]+[A-Z]/.test(bare);
}

/** Does this identifier appear anywhere in the repo (excluding CLAUDE.md)? */
function existsInRepo(ident: string): boolean {
  try {
    const out = execFileSync(
      'git',
      [
        'grep',
        '-l',
        '-w',
        '--',
        ident,
        // Prose is not evidence. Excluding only CLAUDE.md let a symbol be
        // "proven" by the very docs/ page that made the claim, which is how 15
        // symbols from the phase-4 addon split stayed green for months.
        ':!*.md',
        // Nor is this file's own bookkeeping: EXTERNAL_SYMBOLS holds these names
        // as string literals, so without this the map declaring "not here" is
        // itself the proof that it IS here — the same self-reference again.
        ':!scripts/check-claude-md.ts',
        ':!*.lock',
        ':!packages/web/public',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    return out.trim().length > 0;
  } catch {
    return false; // git grep exits 1 on no match
  }
}

/** Every `docs/x.md` the index points at must exist — the index leans on them. */
export function brokenDocLinks(md: string, root = repoRoot): string[] {
  const links = [...md.matchAll(/\]\((docs\/[^)]+\.md)\)/g)].map((m) => m[1]);
  return [...new Set(links)].filter((l) => !existsSync(join(root, l)));
}

function main(): void {
  const md = readFileSync(CLAUDE_MD, 'utf8');
  // Normalise the call form: `foo()` makes a claim about the symbol `foo`.
  const idents = [
    ...new Set(
      backtickedSpans(md)
        .filter(isCheckableIdentifier)
        .map((s) => s.replace(/\(\)$/, '')),
    ),
  ];
  const external = new Set(EXTERNAL_SYMBOLS.keys());
  const missing = idents.filter((i) => !external.has(i) && !existsInRepo(i));
  // Inverted: an "external" symbol that came home means the map is stale.
  const reHomed = [...external].filter((i) => existsInRepo(i));
  // ...and one CLAUDE.md no longer names is dead weight. Checked both ways so
  // the map tracks live claims instead of accumulating like an allowlist.
  const unusedExternal = [...external].filter((i) => !idents.includes(i));
  const brokenLinks = brokenDocLinks(md);

  const entries = indexEntries(md);
  const bytes = Buffer.byteLength(md, 'utf8');
  const oversized = entries.filter((e) => e.chars > MAX_ENTRY_CHARS);
  const unreadable = entries.length < MIN_PLAUSIBLE_ENTRIES;
  const overBudget = bytes > MAX_FILE_BYTES;

  if (process.argv.includes('--list')) {
    console.log(`Checked ${idents.length} identifiers:`);
    for (const i of idents.sort()) console.log(`  ${existsInRepo(i) ? '✓' : '✗'} ${i}`);
    console.log('');
  }

  // Always report the size denominator, pass or fail: a budget nobody sees is a
  // budget nobody notices approaching.
  const median = entries.length
    ? [...entries].sort((a, b) => a.chars - b.chars)[Math.floor(entries.length / 2)].chars
    : 0;
  const sizeLine =
    `CLAUDE.md size: ${bytes.toLocaleString()} / ${MAX_FILE_BYTES.toLocaleString()} bytes ` +
    `(${Math.round((bytes / MAX_FILE_BYTES) * 100)}% of budget), ` +
    `${entries.length} index entries, median ${median} chars, ` +
    `max ${entries.reduce((m, e) => Math.max(m, e.chars), 0)}/${MAX_ENTRY_CHARS}.`;

  if (
    !missing.length &&
    !brokenLinks.length &&
    !reHomed.length &&
    !unusedExternal.length &&
    !oversized.length &&
    !unreadable &&
    !overBudget
  ) {
    console.log(
      `CLAUDE.md: ${idents.length} identifiers checked, all present ` +
        `(${external.size} owned by the addon repo). No broken doc links.`,
    );
    console.log(sizeLine);
    return;
  }
  console.error(`\n${sizeLine}`);

  if (missing.length) {
    console.error(
      `\nCLAUDE.md names ${missing.length} symbol(s) that exist nowhere in the repo:\n`,
    );
    for (const m of missing) console.error(`  ✗ ${m}`);
    console.error(
      '\nUsually a rename the index never followed. Fix the name, or add it to ALLOWLIST\n' +
        'in scripts/check-claude-md.ts with a reason if it is a deliberate non-code mention.',
    );
  }
  if (reHomed.length) {
    console.error(
      `\n${reHomed.length} symbol(s) listed as living in another repo now exist here:\n`,
    );
    for (const r of reHomed)
      console.error(`  ✗ ${r}  (EXTERNAL_SYMBOLS says: ${EXTERNAL_SYMBOLS.get(r)})`);
    console.error(
      '\nRemove them from EXTERNAL_SYMBOLS in scripts/check-claude-md.ts — the map\n' +
        'exists to point readers at another repo, and pointing away from code that\n' +
        'is right here is the same wrong turn it was written to prevent.',
    );
  }
  if (unusedExternal.length) {
    console.error(
      `\n${unusedExternal.length} EXTERNAL_SYMBOLS entr(y/ies) that CLAUDE.md no longer names:\n`,
    );
    for (const u of unusedExternal) console.error(`  ✗ ${u}`);
    console.error('\nDrop them from the map — it should hold live claims, not history.');
  }
  if (brokenLinks.length) {
    console.error(`\nCLAUDE.md links to ${brokenLinks.length} missing doc(s):\n`);
    for (const l of brokenLinks) console.error(`  ✗ ${l}`);
  }
  if (unreadable) {
    console.error(
      `\nOnly ${entries.length} index entries parsed (expected at least ${MIN_PLAUSIBLE_ENTRIES}).\n\n` +
        'This is the gate failing to READ the file, not the file being small. The entry\n' +
        'format changed out from under indexEntries(), so every size check below it just\n' +
        'passed on nothing. Fix the parser (or the format), never the threshold.',
    );
  }
  if (oversized.length) {
    console.error(`\n${oversized.length} index entr(y/ies) over ${MAX_ENTRY_CHARS} characters:\n`);
    for (const e of oversized) console.error(`  ✗ ${e.chars}  L${e.line}  ${e.name}`);
    console.error(
      '\nAn entry says WHAT a thing is, names the symbols you would grep for, and links\n' +
        'the doc. Rationale, incident history and measurements belong in that doc — this\n' +
        'file is paid for on every request, and the doc is only read when relevant.',
    );
  }
  if (overBudget) {
    console.error(
      `\nCLAUDE.md is ${bytes.toLocaleString()} bytes, over the ${MAX_FILE_BYTES.toLocaleString()}-byte budget.\n\n` +
        'Usually this is detail that has drifted back in from docs/. Move it out. If the\n' +
        'index genuinely covers more ground now, raise MAX_FILE_BYTES in a commit that\n' +
        'says why — the point of the budget is that growth is a decision, not a drift.',
    );
  }
  process.exit(1);
}

if (import.meta.main) main();
