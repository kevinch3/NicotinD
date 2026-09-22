#!/usr/bin/env bun
/**
 * Does master's tip actually warrant a release? (issue #755)
 *
 * `commit-and-tag-version` cuts a **patch bump even when nothing since the last
 * tag bumps anything** — so a master push carrying only `chore`/`docs`/`ci`
 * commits produces a version with an empty changelog, and a full multi-arch
 * docker build + deploy for a tree that did not change.
 *
 * That contradicts the repo's own documented contract (CLAUDE.md: `chore`
 * `refactor` `style` `docs` `test` `ci` `build` "does not bump"), and it is what
 * turned a benign concurrency window into two tags: merging #750/#752/#753
 * within a minute left run A publishing v0.5.21 with all three fixes, then run B
 * — whose `git reset --hard FETCH_HEAD` had landed it *on A's `chore(release)`
 * commit* — cutting an empty v0.5.22 moments later.
 *
 * Kept as a tested module rather than more inline workflow bash on purpose: the
 * release step already froze releases for a day once (the orphan-tag incident
 * documented in ci.yml), and shell that can silently exit 0 is exactly how that
 * stayed invisible.
 */

/** Conventional-commit types that bump the version. Mirrors CLAUDE.md's table. */
export const BUMPING_TYPES = ['feat', 'fix', 'perf'];

/** Every type CLAUDE.md's table names, bumping or not. */
export const KNOWN_TYPES = [
  ...BUMPING_TYPES,
  'chore',
  'refactor',
  'style',
  'docs',
  'test',
  'ci',
  'build',
  'revert',
];

export interface ConventionalHeader {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

/**
 * Parse a conventional-commit subject line, or null when it is not one.
 *
 * Exported because `check-pr-title.ts` gates the very thing this file measures:
 * a squash-merge subject comes from the PR title, so the two must agree on what
 * counts as a type down to the last edge case. Importing it is the coupling —
 * a second parser would be free to drift, and the drift would be invisible
 * until releases stopped again.
 */
export function parseConventionalSubject(subject: string): ConventionalHeader | null {
  const m = subject.match(/^([a-zA-Z]+)(\(([^)]*)\))?(!)?: ?(.*)$/);
  if (!m) return null;
  return {
    type: (m[1] ?? '').toLowerCase(),
    scope: m[3] ?? null,
    breaking: m[4] === '!',
    description: (m[5] ?? '').trim(),
  };
}

export interface ReleaseDecision {
  needed: boolean;
  reason: string;
  /**
   * Subjects of commits that do not bump, but whose BODY lists commits that
   * would have. Advisory only — never part of the decision.
   */
  lostBumps: string[];
}

/**
 * A squash merge writes the PR title as the subject and the squashed commits as
 * body bullets, so a PR titled without a type buries every `feat:` it carried
 * where nothing reads it. That is how v0.8.40 came to be the last release while
 * five features sat on master (#1263).
 *
 * The decision deliberately does NOT change: only a subject may bump, because a
 * body can quote a commit message and a release cut from prose is worse than a
 * release not cut. This is the diagnosis printed beside the skip — the freeze
 * was invisible, and a false positive here costs one advisory line.
 */
const SQUASHED_BUMP = new RegExp(
  String.raw`^\s*[*-]\s+(${BUMPING_TYPES.join('|')})(\([^)]*\))?!?:\s`,
  'm',
);

export function lostBumpsIn(messages: string[]): string[] {
  return messages
    .filter((m) => !isBumping(m))
    .filter((m) => SQUASHED_BUMP.test(m.split('\n').slice(1).join('\n')))
    .map((m) => (m.split('\n', 1)[0] ?? '').trim());
}

/**
 * @param subjects  full commit messages (subject + body) since the last tag,
 *                  newest first — `git log --format=%B <tag>..HEAD`
 * @param tipIsTag  whether the last tag points at HEAD itself
 */
export function releaseNeeded(subjects: string[], tipIsTag: boolean): ReleaseDecision {
  if (tipIsTag) {
    return {
      needed: false,
      reason: 'master tip is already the latest tag — nothing new landed',
      lostBumps: [],
    };
  }
  if (subjects.length === 0) {
    return { needed: false, reason: 'no commits since the latest tag', lostBumps: [] };
  }
  const bumping = subjects.filter(isBumping);
  if (bumping.length === 0) {
    return {
      needed: false,
      reason: `${subjects.length} commit(s) since the tag, none of a releasing type (${BUMPING_TYPES.join('/')})`,
      lostBumps: lostBumpsIn(subjects),
    };
  }
  return {
    needed: true,
    reason: `${bumping.length} releasing commit(s) since the latest tag`,
    lostBumps: [],
  };
}

/**
 * A commit bumps if its type is feat/fix/perf, or it is marked breaking — via
 * `!` after the type or a `BREAKING CHANGE:` footer, both of which force a
 * major bump regardless of type.
 */
export function isBumping(message: string): boolean {
  const header = parseConventionalSubject(message.split('\n', 1)[0] ?? '');
  if (!header) return false;
  if (header.breaking) return true;
  // The footer form is authoritative even under a non-bumping type.
  if (/^BREAKING[ -]CHANGE:/m.test(message)) return true;
  return BUMPING_TYPES.includes(header.type);
}

if (import.meta.main) {
  const { $ } = await import('bun');
  // `v*` MUST be interpolated, not written inline: Bun's shell glob-expands a
  // bare `v*` against the working directory, so git never receives the pattern
  // and `describe` reports no tag — which would have made this guard answer
  // "releasing" unconditionally, i.e. a gate that always passes.
  const TAG_GLOB = 'v*';
  const tag = (await $`git describe --tags --abbrev=0 --match ${TAG_GLOB}`.nothrow().text()).trim();
  if (!tag) {
    console.log('release-needed: no tag yet — releasing.');
    process.exit(0);
  }
  const tagSha = (await $`git rev-parse ${`${tag}^{commit}`}`.text()).trim();
  const headSha = (await $`git rev-parse HEAD`.text()).trim();
  // `%B` + a NUL delimiter: a commit body can contain blank lines, so any
  // newline-based split would shred multi-paragraph messages into fake commits
  // and read a stray "fix: …" quoted in a body as a releasing commit.
  const raw = await $`git log --format=%B%x00 ${`${tag}..HEAD`}`.text();
  const messages = raw
    .split('\0')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  const decision = releaseNeeded(messages, tagSha === headSha);
  console.log(
    `release-needed: ${decision.needed ? 'YES' : 'NO'} — ${decision.reason} (last tag ${tag})`,
  );
  // Loud, because the version this skipped is one nobody will come looking for.
  for (const subject of decision.lostBumps) {
    console.log(
      `::warning::"${subject}" does not bump, but its body lists commits that would have — ` +
        'a squash merge whose PR title carried no conventional-commit type. ' +
        'The release it should have cut is not happening. See docs/releasing.md.',
    );
  }
  process.exit(decision.needed ? 0 : 1);
}
