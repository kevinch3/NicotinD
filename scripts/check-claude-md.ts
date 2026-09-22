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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const CLAUDE_MD = join(repoRoot, 'CLAUDE.md');
/**
 * The index root, split out of CLAUDE.md by #934 so it is read on demand rather
 * than paid for on every request, and reduced to a table of contents by #1240.
 * Every file here is checked together: a symbol or link is a claim wherever it
 * is written, and checking only one of them would recreate the blind spot this
 * gate exists to close.
 */
const INDEX_MD = join(repoRoot, 'docs', 'index.md');
/** One file per index section (#1240). */
const INDEX_DIR = join(repoRoot, 'docs', 'index');

/**
 * Section files, discovered rather than listed.
 *
 * Discovery is what makes a new section covered the moment it exists; the
 * both-ways check against the root's table of contents (see `tocSlugs`) is what
 * stops discovery from being a way to add an unreachable one.
 */
export function indexSectionSlugs(dir = INDEX_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** Sections the index root actually links, as `index/<slug>.md`. */
export function tocSlugs(rootMd: string): string[] {
  return [...rootMd.matchAll(/\]\(index\/([^)]+)\.md\)/g)].map((m) => m[1]).sort();
}

/**
 * A section on disk that the root does not link, or a link with no file.
 *
 * Both directions, because they fail differently and both fail silently. An
 * unlinked file takes its whole section out of circulation while every other
 * check here still passes on it — the reader simply never learns it exists. A
 * link with no file is the reverse: the reader is sent somewhere empty.
 */
export function sectionMismatches(rootMd: string, slugs = indexSectionSlugs()): string[] {
  const linked = new Set(tocSlugs(rootMd));
  const onDisk = new Set(slugs);
  return [
    ...[...onDisk]
      .filter((s) => !linked.has(s))
      .map((s) => `docs/index/${s}.md exists but docs/index.md never links it — unreachable.`),
    ...[...linked]
      .filter((s) => !onDisk.has(s))
      .map((s) => `docs/index.md links index/${s}.md, which does not exist.`),
  ];
}

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
 * WHY: CLAUDE.md's own header calls it "an index, kept deliberately small
 * because it loads into every request" — and nothing measured that, so it grew
 * to 186 KB / 2,038 lines. A 2026-08 restructure cut it to 50 KB; by 2026-09 it
 * was back at 59.5 KB, and a three-pass attempt to compress it further measured
 * a floor: the best CORRECT result was -0.9%, while aggressive merging produced
 * 48 invented claims. See docs/measurements/claude-md-compression-2026-09.md.
 *
 * So #934 relocated the index instead of compressing it. Nothing was deleted —
 * the ~155 entries moved to docs/index.md, which is read when a mechanism needs
 * locating rather than on every request. That splits the budget in two:
 *
 *   MAX_CLAUDE_MD_BYTES  the per-request cost. This is the number that matters,
 *                        and the one to defend: every byte is paid on every
 *                        task, including the majority that never open the index.
 *   MAX_INDEX_BYTES      the on-demand index. Generous, because its cost is paid
 *   (gone — see #1240)   only when read — but present, because "nobody pays for
 *                        it" is exactly how the 186 KB happened the first time.
 *                        That second cap no longer exists; the paragraph below
 *                        says why, and MAX_INDEX_SECTION_BYTES replaced it.
 *
 * Neither is a law of nature: raising one is fine, but it should be a commit
 * that says why, which is what an un-measured prose rule never forced. A test
 * asserts CLAUDE.md and every section keep >5,000 bytes of headroom, so a cap
 * can never sit flush against the file it measures — a gate that fires on the
 * next honest addition gets raised reflexively.
 *
 * A SINGLE TOTAL WAS THE WRONG CAP (#1240). It was raised 60,000 → 70,000 on
 * 2026-09-08 for ~48 entries of runway. The index consumed all 10,000 bytes in
 * fourteen days. Measured 2026-09-05 → 2026-09-22: 47,278 → 64,995 bytes and
 * 155 → 205 entries, about 1,040 bytes and 3 entries per day.
 *
 * Neither obvious answer survives those numbers. Raising the total again buys
 * ~10 days. Trimming buys less: claude-md-compression-2026-09.md put 55 agents
 * over three passes on exactly this and found the best CORRECT compression was
 * -0.9% — 585 bytes, thirteen hours of growth — while the aggressive merging
 * that reached -32% invented 48 claims. The index is at its shape, not padded.
 * Its size IS the count of mechanisms this repo has, so capping the total caps
 * how much the repo may do, which is not a thing a docs gate should decide.
 *
 * So the index became one file per section, and the cap became per section.
 * What matters was never the total — it is what a reader pays to locate ONE
 * mechanism, and that went from 65 KB to ~7 KB. The cap's MEANING changes with
 * it: a section over budget has earned a SPLIT, not a trim and not a bigger
 * number. Growth is absorbed by subdivision, which has no ceiling, and each
 * split halves the read cost again. That is the property a single total never
 * had, and it also defuses the 2026-09-07 merge break, where two PRs each
 * trimmed to fit on their own branch and broke master in the sum: they must now
 * collide inside one section, near that section's cap.
 *
 * The total is still REPORTED on every run, because "nobody pays for it" is
 * exactly how CLAUDE.md reached 186 KB — it is simply no longer enforced.
 * MAX_CLAUDE_MD_BYTES is untouched: that is the per-request cost and the number
 * actually worth defending.
 */
export const MAX_ENTRY_CHARS = 440;
export const MAX_CLAUDE_MD_BYTES = 20_000;
/**
 * Per section file. The largest section is ~13 KB, so this is roughly a
 * doubling — and the headroom test keeps it from ever sitting flush.
 */
export const MAX_INDEX_SECTION_BYTES = 24_000;

/**
 * The gate's denominator, and the part that matters most. It is asserted
 * against the index — NOT CLAUDE.md, which now parses ~5 Surfaces entries and
 * would pass vacuously — and against the SUM across sections, not any one file.
 * Per-file it would be meaningless (a small section legitimately holds 8), and
 * summing is what fails loudly if the section walk ever stops finding files.
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
 * Matches ANY `.md` link, not just a `docs/`-prefixed one: after #934 the index
 * lives inside docs/ and writes `[web-ui.md](web-ui.md)`. A `docs/`-only regex
 * stopped stripping those, and the budget immediately began charging entries for
 * their own links again — the exact failure the paragraph below describes.
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
    .replace(/\[[^\]]*\]\([^)]*\.md\)/g, '')
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

/**
 * Every doc a file points at must exist.
 *
 * `base` is the linking file's own directory, because after #934 the two files
 * write the same link differently: CLAUDE.md says `docs/web-ui.md`, and
 * docs/index.md — living inside docs/ — says `web-ui.md`. Resolving both
 * against the repo root would silently mark every relocated link broken.
 */
export function brokenDocLinks(md: string, root = repoRoot, base = '.'): string[] {
  const links = [...md.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
  return [...new Set(links)]
    .filter((l) => !/^https?:/.test(l))
    .filter((l) => !existsSync(join(root, base, l)));
}

function main(): void {
  const claudeMd = readFileSync(CLAUDE_MD, 'utf8');
  const indexMd = readFileSync(INDEX_MD, 'utf8');
  const slugs = indexSectionSlugs();
  const sections = slugs.map((slug) => ({
    slug,
    path: `docs/index/${slug}.md`,
    text: readFileSync(join(INDEX_DIR, `${slug}.md`), 'utf8'),
  }));
  // A symbol is a claim wherever it is written, so every file is ONE corpus for
  // the existence check — splitting the index must not split the gate.
  const both = [claudeMd, indexMd, ...sections.map((s) => s.text)].join('\n');
  const idents = [
    ...new Set(
      backtickedSpans(both)
        .filter(isCheckableIdentifier)
        .map((s) => s.replace(/\(\)$/, '')),
    ),
  ];
  const external = new Set(EXTERNAL_SYMBOLS.keys());
  const missing = idents.filter((i) => !external.has(i) && !existsInRepo(i));
  // Inverted: an "external" symbol that came home means the map is stale.
  const reHomed = [...external].filter((i) => existsInRepo(i));
  // ...and one neither file names any more is dead weight. Checked both ways so
  // the map tracks live claims instead of accumulating like an allowlist.
  const unusedExternal = [...external].filter((i) => !idents.includes(i));
  // Each file's links resolve against its own directory (see brokenDocLinks).
  const brokenLinks = [
    ...brokenDocLinks(claudeMd, repoRoot).map((l) => `CLAUDE.md -> ${l}`),
    ...brokenDocLinks(indexMd, repoRoot, 'docs').map((l) => `docs/index.md -> docs/${l}`),
    ...sections.flatMap(({ path, text }) =>
      brokenDocLinks(text, repoRoot, 'docs/index').map((l) => `${path} -> docs/index/${l}`),
    ),
  ];
  const unreachable = sectionMismatches(indexMd, slugs);

  const claudeEntries = indexEntries(claudeMd);
  // The root still carries the "Proposed, NOT built" entry above its contents
  // table, so it counts as index content, not only as a table of contents.
  const indexEntriesList = [
    ...indexEntries(indexMd).map((e) => ({ ...e, file: 'docs/index.md' })),
    ...sections.flatMap(({ path, text }) => indexEntries(text).map((e) => ({ ...e, file: path }))),
  ];
  const claudeBytes = Buffer.byteLength(claudeMd, 'utf8');
  const sectionBytes = sections.map((s) => ({
    ...s,
    bytes: Buffer.byteLength(s.text, 'utf8'),
  }));
  const indexBytes =
    Buffer.byteLength(indexMd, 'utf8') + sectionBytes.reduce((n, s) => n + s.bytes, 0);
  // The per-entry cap applies wherever an entry is written; the denominator
  // check applies to the index as a whole (see MIN_PLAUSIBLE_ENTRIES).
  const oversized = [
    ...claudeEntries.map((e) => ({ ...e, file: 'CLAUDE.md' })),
    ...indexEntriesList,
  ].filter((e) => e.chars > MAX_ENTRY_CHARS);
  const unreadable = indexEntriesList.length < MIN_PLAUSIBLE_ENTRIES;
  const fatSections = sectionBytes.filter((s) => s.bytes > MAX_INDEX_SECTION_BYTES);
  const overBudget = claudeBytes > MAX_CLAUDE_MD_BYTES || fatSections.length > 0;

  if (process.argv.includes('--list')) {
    console.log(`Checked ${idents.length} identifiers:`);
    for (const i of idents.sort()) console.log(`  ${existsInRepo(i) ? '\u2713' : '\u2717'} ${i}`);
    console.log('');
  }

  // Always report the size denominator, pass or fail: a budget nobody sees is a
  // budget nobody notices approaching.
  const median = indexEntriesList.length
    ? [...indexEntriesList].sort((a, b) => a.chars - b.chars)[
        Math.floor(indexEntriesList.length / 2)
      ].chars
    : 0;
  const maxChars = indexEntriesList.reduce((m, e) => Math.max(m, e.chars), 0);
  const widest = sectionBytes.reduce((m, s) => Math.max(m, s.bytes), 0);
  const sizeLine =
    `CLAUDE.md (paid every request): ${claudeBytes.toLocaleString()} / ` +
    `${MAX_CLAUDE_MD_BYTES.toLocaleString()} bytes ` +
    `(${Math.round((claudeBytes / MAX_CLAUDE_MD_BYTES) * 100)}% of budget).\n` +
    // The total is reported and NOT enforced (see the SIZE BUDGET note): what a
    // reader actually pays is the widest section, which is what has a cap.
    `docs/index: ${sections.length} sections, ${indexEntriesList.length} entries, ` +
    `${indexBytes.toLocaleString()} bytes total (unenforced).\n` +
    `  widest section ${widest.toLocaleString()} / ` +
    `${MAX_INDEX_SECTION_BYTES.toLocaleString()} bytes; ` +
    `entry median ${median} chars, max ${maxChars}/${MAX_ENTRY_CHARS}.`;

  if (
    !missing.length &&
    !brokenLinks.length &&
    !reHomed.length &&
    !unusedExternal.length &&
    !oversized.length &&
    !unreadable &&
    !unreachable.length &&
    !overBudget
  ) {
    console.log(
      `CLAUDE.md + docs/index: ${idents.length} identifiers checked, all present ` +
        `(${external.size} owned by the addon repo). No broken doc links.`,
    );
    console.log(sizeLine);
    return;
  }
  console.error(`\n${sizeLine}`);

  if (missing.length) {
    console.error(
      `\nThe index names ${missing.length} symbol(s) that exist nowhere in the repo:\n`,
    );
    for (const m of missing) console.error(`  \u2717 ${m}`);
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
      console.error(`  \u2717 ${r}  (EXTERNAL_SYMBOLS says: ${EXTERNAL_SYMBOLS.get(r)})`);
    console.error(
      '\nRemove them from EXTERNAL_SYMBOLS in scripts/check-claude-md.ts — the map\n' +
        'exists to point readers at another repo, and pointing away from code that\n' +
        'is right here is the same wrong turn it was written to prevent.',
    );
  }
  if (unusedExternal.length) {
    console.error(
      `\n${unusedExternal.length} EXTERNAL_SYMBOLS entr(y/ies) the index no longer names:\n`,
    );
    for (const u of unusedExternal) console.error(`  \u2717 ${u}`);
    console.error('\nDrop them from the map — it should hold live claims, not history.');
  }
  if (brokenLinks.length) {
    console.error(`\nThe index links to ${brokenLinks.length} missing doc(s):\n`);
    for (const l of brokenLinks) console.error(`  \u2717 ${l}`);
  }
  if (unreadable) {
    console.error(
      `\nOnly ${indexEntriesList.length} index entries parsed across ` +
        `${sections.length} section file(s) (expected at least ${MIN_PLAUSIBLE_ENTRIES}).\n\n` +
        'This is the gate failing to READ the index, not the index being small. The entry\n' +
        'format changed out from under indexEntries(), so every size check below it just\n' +
        'passed on nothing. Fix the parser (or the format), never the threshold.',
    );
  }
  if (oversized.length) {
    console.error(`\n${oversized.length} index entr(y/ies) over ${MAX_ENTRY_CHARS} characters:\n`);
    for (const e of oversized) console.error(`  \u2717 ${e.chars}  ${e.file}:${e.line}  ${e.name}`);
    console.error(
      '\nAn entry says WHAT a thing is, names the symbols you would grep for, and links\n' +
        'the doc. Rationale, incident history and measurements belong in that doc.',
    );
  }
  if (overBudget) {
    if (claudeBytes > MAX_CLAUDE_MD_BYTES)
      console.error(
        `\nCLAUDE.md is ${claudeBytes.toLocaleString()} bytes, over its ` +
          `${MAX_CLAUDE_MD_BYTES.toLocaleString()}-byte budget.\n\n` +
          'This is the per-request cost, so it is the one to defend. Detail belongs in\n' +
          'docs/index.md or the linked doc, not here.',
      );
    for (const s of fatSections)
      console.error(
        `\n${s.path} is ${s.bytes.toLocaleString()} bytes, over the ` +
          `${MAX_INDEX_SECTION_BYTES.toLocaleString()}-byte section budget.\n\n` +
          'SPLIT IT — do not trim it, and do not raise the number. This section has grown\n' +
          'enough to be two: pick a boundary, move half into a new docs/index/<slug>.md,\n' +
          'and add it to the table in docs/index.md. That halves what a reader pays to\n' +
          'locate one mechanism, which is the cost this budget is actually about.\n\n' +
          'Trimming is the answer that was measured and found wanting: the best CORRECT\n' +
          'compression of this index was -0.9%, about thirteen hours of its growth.',
      );
  }
  if (unreachable.length) {
    console.error(`\n${unreachable.length} index section(s) out of step with the contents:\n`);
    for (const u of unreachable) console.error(`  ✗ ${u}`);
    console.error(
      '\nThe table in docs/index.md is the only way a reader finds a section, so a file\n' +
        'missing from it is a file nobody opens — every other check here still passes on\n' +
        'it. Checked both ways so neither half can drift.',
    );
  }
  process.exit(1);
}

if (import.meta.main) main();
