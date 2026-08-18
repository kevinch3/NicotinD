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

async function main(): Promise<void> {
  const violations: HelperViolation[] = [];
  const glob = new Glob('packages/*/src/**/*.ts');

  for await (const rel of glob.scan({ cwd: repoRoot })) {
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
