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
  // Features documented as explicitly proposed, not built.
  ['oauth', 'the OAuth entry says "proposed — not yet implemented"'],
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

  if (process.argv.includes('--list')) {
    console.log(`Checked ${idents.length} identifiers:`);
    for (const i of idents.sort()) console.log(`  ${existsInRepo(i) ? '✓' : '✗'} ${i}`);
    console.log('');
  }

  if (!missing.length && !brokenLinks.length && !reHomed.length && !unusedExternal.length) {
    console.log(
      `CLAUDE.md: ${idents.length} identifiers checked, all present ` +
        `(${external.size} owned by the addon repo). No broken doc links.`,
    );
    return;
  }

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
  process.exit(1);
}

if (import.meta.main) main();
