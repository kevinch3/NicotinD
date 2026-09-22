#!/usr/bin/env bun
/**
 * The PR title IS the release, so make it a conventional commit (#1263).
 *
 *   bun run check:pr-title "feat(radio): hold the queue at a depth"
 *   PR_TITLE="…" PR_COMMITS_FILE=/tmp/subjects bun run check:pr-title
 *
 * WHY: merges here are squashes, and a squash writes the **PR title** as the
 * commit subject. `release-needed.ts` reads subjects — only subjects, on purpose
 * — so a PR titled without a type lands on master as a commit that bumps
 * nothing, no matter what it contains.
 *
 * That is not hypothetical. PR #1263 squash-merged five `feat:` commits under
 * the title *"Radio queue depth: replace batch refill with target-based
 * top-up"*. No type, no bump, no tag, no deploy: v0.8.40 stayed the latest
 * release while the features sat on master, and every CI run was green because
 * nothing was broken — the release simply was not needed, correctly, from a
 * subject that had lost the only evidence it should have been.
 *
 * The husky `commit-msg` hook cannot catch this. It runs on commits made on a
 * developer's machine; a squash merge is performed by GitHub, from a title
 * nothing validates. This gate is the missing half of that hook, and it lives
 * where the title does.
 *
 * TWO RULES, and the second is the one that catches #1263's successor:
 *   1. the title parses as a conventional commit with a known type;
 *   2. if the PR's own commits bump and the title does not, the squash would
 *      throw the bump away — so the title has to carry it.
 *
 * `parseConventionalSubject` and `isBumping` are imported from
 * `release-needed.ts` rather than re-written, because this gate is only worth
 * anything while it agrees with the guard it protects, down to the edge cases.
 */
import {
  KNOWN_TYPES,
  isBumping,
  parseConventionalSubject,
  BUMPING_TYPES,
} from './release-needed.js';

export interface TitleVerdict {
  ok: boolean;
  problems: string[];
}

/**
 * @param title    the pull request title, which a squash merge uses verbatim
 * @param commits  the PR's own commit messages (subject + body), any order
 */
export function checkPrTitle(title: string, commits: string[] = []): TitleVerdict {
  const problems: string[] = [];
  const trimmed = title.trim();
  const header = parseConventionalSubject(trimmed);

  if (!header) {
    problems.push(
      `Title is not a conventional commit: "${trimmed}".\n` +
        `  Expected "<type>(<optional scope>): <description>", e.g. "fix(radio): stop the queue draining".\n` +
        `  Types: ${KNOWN_TYPES.join(', ')}.`,
    );
  } else if (!KNOWN_TYPES.includes(header.type)) {
    problems.push(
      `Unknown type "${header.type}" in title "${trimmed}".\n` +
        `  Types: ${KNOWN_TYPES.join(', ')}.`,
    );
  } else if (header.description.length === 0) {
    problems.push(`Title "${trimmed}" has a type but no description.`);
  }

  // Rule 2. A valid title can still lose the release: `chore: tidy up` over a
  // branch of `feat:` commits squashes to a subject that bumps nothing.
  const bumpingCommits = commits.filter(isBumping);
  if (bumpingCommits.length > 0 && !isBumping(trimmed)) {
    problems.push(
      `The title does not bump the version, but ${bumpingCommits.length} commit(s) on this branch do:\n` +
        bumpingCommits.map((c) => `    ${(c.split('\n', 1)[0] ?? '').trim()}`).join('\n') +
        `\n  A squash merge keeps only the title, so those bumps would be thrown away and no release cut.\n` +
        `  Retitle with the strongest type on the branch (${BUMPING_TYPES.join('/')}, or "!" for breaking).`,
    );
  }

  return { ok: problems.length === 0, problems };
}

if (import.meta.main) {
  const title = process.argv[2] ?? process.env['PR_TITLE'] ?? '';
  if (!title.trim()) {
    console.error('check:pr-title: no title given (argv[2] or $PR_TITLE).');
    process.exit(1);
  }

  // The commits arrive through a file rather than an argument: a commit body is
  // multi-line and arbitrary, and an env var holding one is a quoting accident
  // waiting to happen. NUL-delimited for the same reason `release-needed.ts`
  // uses it — a body can contain blank lines.
  const file = process.env['PR_COMMITS_FILE'];
  let commits: string[] = [];
  if (file) {
    const { file: readFile } = await import('bun');
    commits = (await readFile(file).text())
      .split('\0')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
  }

  const verdict = checkPrTitle(title, commits);
  if (verdict.ok) {
    console.log(`check:pr-title: OK — "${title.trim()}"`);
    process.exit(0);
  }
  console.error('check:pr-title: this title would land on master as-is.\n');
  for (const problem of verdict.problems) console.error(`  ✗ ${problem}\n`);
  console.error('  Edit the PR title, then re-run this check (it re-runs on every title edit).');
  process.exit(1);
}
