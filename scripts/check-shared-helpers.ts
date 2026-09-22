/**
 * Fail when a shared helper is re-implemented locally instead of imported.
 *
 *   bun run check:shared-helpers
 *
 * WHY: `expandHome` was copy-pasted into 32 files, and one copy drifted to
 *
 *     return p.startsWith('~') ? join(HOME, p.slice(1)) : '';
 *                                                        ^^ should be `p`
 *
 * returning an **empty string for every absolute path**. That copy lived in
 * `check-fragments.ts`, which CLAUDE.md documents as a CLI gate — so the gate
 * had never once run in Docker (`NICOTIND_DATA_DIR=/data/nicotind` collapsed to
 * `''`, and the script exited with a plausible-looking "Database not found").
 *
 * What made it expensive is the shape of the failure, not the duplication: the
 * broken copy took the `~` branch under a developer's default `~/.nicotind` and
 * worked perfectly. It was only reachable with an absolute path — i.e. only in
 * production. Consolidating the copies (issue #306) fixes today; this gate is
 * what stops copy #33.
 *
 * A gate rather than a report (unlike check-shipped-issues.ts): re-declaring a
 * helper that already exists in `@nicotind/core` is never the intended thing, so
 * there is no false-positive class to cry wolf with. If a local definition ever
 * *is* wanted, the fix is to give it a different name — two functions with one
 * name and two behaviours is the exact bug this prevents.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { Glob } from 'bun';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

export interface SharedHelper {
  /** Exported name that must not be re-declared elsewhere. */
  name: string;
  /** Repo-relative module that legitimately declares it. */
  canonical: string;
}

/**
 * Helpers that exist once and are imported everywhere. Add an entry when you
 * extract a helper that was previously duplicated — that is the moment the
 * duplication is most likely to grow back.
 */
export const SHARED_HELPERS: SharedHelper[] = [
  { name: 'expandHome', canonical: 'packages/core/src/utils/expand-home.ts' },
  { name: 'timeAgo', canonical: 'packages/web/src/app/lib/relative-time.ts' },
  // "Which tab is this?" existed twice under one `nicotind_tab_id` key —
  // PresenceService's private copy and, when the playback device id became
  // per-tab (#882), a second read-or-mint of the same key. Two writers to one
  // storage key is the drift: the heartbeat and the cast target would name
  // different tabs. Registered so copy #3 fails CI.
  { name: 'resolveTabId', canonical: 'packages/web/src/app/lib/device-id.ts' },
  { name: 'profileIdOf', canonical: 'packages/web/src/app/lib/device-id.ts' },
  // "Which devices can I send audio to?" was the phone popover's private
  // computed until the TV needed the same answer in a different shape (#1128).
  // Two pickers with two copies of the offerable/sibling rules disagree only
  // when someone is holding both devices at once — the worst place to find out.
  { name: 'otherDevicesFor', canonical: 'packages/web/src/app/lib/device-list.ts' },
  // The Storybook gates were two scripts sharing ~50 duplicated lines — the static
  // server, the story enumeration, the iframe URL — until they were merged into one
  // traversal. Registered at the moment of extraction, which is when a copy is most
  // likely to reappear. (`serve` is deliberately not listed: too generic a name to
  // assert on repo-wide.)
  // "Is this file library content?" existed six times with six different
  // memberships. library-disk-audit walked disk with a set lacking .wma while
  // the scanner indexed it, so every .wma row reported as `missing_file` — a
  // finding whose obvious remediation deletes a row for a file that is present
  // (#845). Registered so copy #7 fails CI instead of lying in a report.
  // `AUDIO_EXTS` was the second name for this concept and is retired, not
  // listed: a registry entry must name something the canonical module actually
  // exports, and reviving the alias to satisfy that would recreate the drift.
  { name: 'AUDIO_EXTENSIONS', canonical: 'packages/core/src/audio-extensions.ts' },
  { name: 'ID3_EXTS', canonical: 'packages/core/src/audio-extensions.ts' },
  { name: 'VORBIS_EXTS', canonical: 'packages/core/src/audio-extensions.ts' },
  // "What ffmpeg args encode this format?" was declared twice: the streaming
  // table here, and the same Opus tuple written out inline in the library
  // conversion path. The two paths could drift without anything noticing,
  // because nothing compared them — the reversible path stayed configurable
  // while the irreversible one hardcoded what it did (#1256). `library-format.ts`
  // now builds its encode args from this table; registered so copy #3 fails CI.
  // Note the gate matches the NAME: it cannot see an inline array literal, which
  // is why deleting the original duplicate was manual work, not something this
  // caught.
  { name: 'FORMAT_ARGS', canonical: 'packages/api/src/services/transcode.ts' },
  // The library's own format table, separate from FORMAT_ARGS on purpose:
  // streaming output is ephemeral and untagged, library output is permanent,
  // tagged and re-scanned, so `aac` is a valid streaming format and not a valid
  // library one. Two tables that look alike are exactly what gets merged by a
  // well-meaning refactor.
  { name: 'LIBRARY_FORMATS', canonical: 'packages/api/src/services/library-format.ts' },
  { name: 'readStories', canonical: 'packages/e2e/scripts/lib/storybook-runner.mjs' },
  { name: 'visitStories', canonical: 'packages/e2e/scripts/lib/storybook-runner.mjs' },
  { name: 'storyUrl', canonical: 'packages/e2e/scripts/lib/storybook-runner.mjs' },
  // AcoustID identify helpers, extracted from routes/download-review.ts and
  // candidate-sources.ts when the track-info sheet gained identify — the
  // review inbox and the library routes must share one implementation.
  { name: 'identifyPlugin', canonical: 'packages/api/src/services/identify.ts' },
  { name: 'identifyOne', canonical: 'packages/api/src/services/identify.ts' },
  { name: 'computeIdentifyAvailable', canonical: 'packages/api/src/services/identify.ts' },
  // Failure-kind → i18n key for identify outcomes (#414 taxonomy), extracted
  // from the metadata-fix modal so the track-info sheet can't drift on copy.
  { name: 'identifyFailureKey', canonical: 'packages/web/src/app/lib/identify-failure.ts' },
  // "Which albums did this job land in?" — extracted from the acquire-lane
  // projection when the unified feed needed the same answer to name its cards.
  { name: 'jobDestinationAlbums', canonical: 'packages/api/src/services/job-destinations.ts' },
  // The Downloads-card title chain, shared by the API read model and the web
  // adapter so the two can never disagree about what a download is called.
  { name: 'downloadTitleFor', canonical: 'packages/core/src/utils/download-title.ts' },
  { name: 'isGenericFolderName', canonical: 'packages/core/src/utils/folder-name.ts' },
  // "Is this the same recording?" — the radio path needed the tuple that
  // `repointPlaylistsBeforePrune` and the admin /duplicates route had each
  // already re-invented locally, so it is registered on arrival rather than
  // after a third copy appears (issue #660).
  { name: 'recordingKey', canonical: 'packages/api/src/services/recording-identity.ts' },
  // Free-space probing. Three byte-identical copies existed — the library
  // import, the migration backup and GET /api/system/disk — and the type was
  // already being imported across module boundaries from whichever file
  // happened to declare it, which is the shape that precedes a fourth. The
  // whole-library transcode was that fourth caller (#1021).
  { name: 'freeBytes', canonical: 'packages/api/src/services/disk-space.ts' },
  { name: 'checkHeadroom', canonical: 'packages/api/src/services/disk-space.ts' },
  // The drag-reorder splice, extracted from PlayerService.moveInQueue when the
  // track-info sheet's genre chips became the second reorderable list (#684) —
  // registered at extraction, before a third surface copies it again.
  { name: 'moveInList', canonical: 'packages/web/src/app/lib/move-in-list.ts' },
  // The "pause polling while the tab is hidden" loop. ServiceReview and
  // DownloadReview each carried a byte-identical copy of it; TransferService
  // had none, which is how a backgrounded tab came to be ~75% of all traffic
  // reaching the public edge (#717). Registered at extraction, with four
  // callers already on it.
  { name: 'createVisibilityPoller', canonical: 'packages/web/src/app/lib/visibility-poller.ts' },
  // The normalizer family. Three separate ASCII-only strips standing in for
  // Unicode folding shipped as three separate bugs (#662 discography's local
  // `normalizeTitle`, #706 the MCP surface, #715 `normalizeName`), each deleting
  // characters it was supposed to fold. Registered so a fourth copy cannot
  // appear — though note this gate only catches a *re-declaration*: bypassing
  // the helper with inline SQL is what `check:search-matching` covers.
  { name: 'normalizeTitle', canonical: 'packages/addon-sdk/src/title-match.ts' },
  { name: 'fold', canonical: 'packages/addon-sdk/src/hunt-queries.ts' },
  { name: 'tokenize', canonical: 'packages/api/src/services/search-tokens.ts' },
  { name: 'matchesAllTokens', canonical: 'packages/api/src/services/search-tokens.ts' },
  // LRC parsing + the render-time offset, lifted out of the web app when the
  // API needed the same parse (the health detector asks whether an LRC overruns
  // its own file; the MCP read tool reports where its timings sit). The thing a
  // second copy would get wrong is the sign: the spec's `[offset:+N]` means
  // *sooner* while a stored offset means *later*, so two parsers would drift
  // into shifting the same lyrics in opposite directions. Registered at
  // extraction, which is when a copy is most likely to grow back.
  { name: 'parseLrc', canonical: 'packages/core/src/lrc.ts' },
  { name: 'parseLrcDetailed', canonical: 'packages/core/src/lrc.ts' },
  { name: 'applyLyricsOffset', canonical: 'packages/core/src/lrc.ts' },
  { name: 'findActiveLine', canonical: 'packages/core/src/lrc.ts' },
];

export interface HelperViolation {
  file: string;
  name: string;
  line: number;
}

/**
 * Find local declarations of a shared helper.
 *
 * Matches the two forms a copy actually takes — `function foo(` and
 * `const foo = ` — anchored to the start of a line (optionally after `export`),
 * so a call, an import, or a mention in a comment never trips it.
 */
export function findLocalDeclarations(
  source: string,
  name: string,
): Array<{ line: number; text: string }> {
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*[=:])`,
  );
  const out: Array<{ line: number; text: string }> = [];
  source.split('\n').forEach((text, i) => {
    if (pattern.test(text)) out.push({ line: i + 1, text: text.trim() });
  });
  return out;
}

async function* concatScans(globs: Glob[], cwd: string): AsyncGenerator<string> {
  for (const glob of globs) {
    for await (const rel of glob.scan({ cwd })) yield rel;
  }
}

async function main(): Promise<void> {
  const violations: HelperViolation[] = [];
  // Two patterns: package sources, plus the `scripts/` dirs where build/CI helpers
  // live (the Storybook gate runner is `.mjs` and sits outside any `src` tree).
  const globs = [new Glob('packages/*/src/**/*.ts'), new Glob('packages/*/scripts/**/*.{ts,mjs}')];
  const seen = new Set<string>();

  for await (const rel of concatScans(globs, repoRoot)) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (rel.includes('node_modules') || rel.includes('/dist/')) continue;
    let source: string;
    try {
      source = readFileSync(resolve(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    for (const helper of SHARED_HELPERS) {
      // The canonical module is where it's supposed to live; its test may
      // legitimately build fixtures around the same name.
      const normalized = relative(repoRoot, resolve(repoRoot, rel));
      if (normalized === helper.canonical) continue;
      if (!source.includes(helper.name)) continue;
      for (const hit of findLocalDeclarations(source, helper.name)) {
        violations.push({ file: normalized, name: helper.name, line: hit.line });
      }
    }
  }

  if (violations.length > 0) {
    console.error('Shared helpers re-implemented locally:\n');
    for (const v of violations) {
      const canonical = SHARED_HELPERS.find((h) => h.name === v.name)!.canonical;
      console.error(`  ${v.file}:${v.line}  declares \`${v.name}\``);
      console.error(`    → import it from the canonical module instead (${canonical}).\n`);
    }
    console.error('A duplicated helper drifts silently — see issue #301, where one copy returned');
    console.error("'' for every absolute path and a documented CLI gate never ran in Docker.");
    process.exit(1);
  }

  console.log(
    `Shared helpers: ${SHARED_HELPERS.length} checked, no local re-implementations found.`,
  );
}

if (import.meta.main) await main();
