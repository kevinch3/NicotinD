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
const BUMPING_TYPES = ['feat', 'fix', 'perf'];

export interface ReleaseDecision {
  needed: boolean;
  reason: string;
}

/**
 * @param subjects  full commit messages (subject + body) since the last tag,
 *                  newest first — `git log --format=%B <tag>..HEAD`
 * @param tipIsTag  whether the last tag points at HEAD itself
 */
export function releaseNeeded(subjects: string[], tipIsTag: boolean): ReleaseDecision {
  if (tipIsTag) {
    return { needed: false, reason: 'master tip is already the latest tag — nothing new landed' };
  }
  if (subjects.length === 0) {
    return { needed: false, reason: 'no commits since the latest tag' };
  }
  const bumping = subjects.filter(isBumping);
  if (bumping.length === 0) {
    return {
      needed: false,
      reason: `${subjects.length} commit(s) since the tag, none of a releasing type (${BUMPING_TYPES.join('/')})`,
    };
  }
  return { needed: true, reason: `${bumping.length} releasing commit(s) since the latest tag` };
}

/**
 * A commit bumps if its type is feat/fix/perf, or it is marked breaking — via
 * `!` after the type or a `BREAKING CHANGE:` footer, both of which force a
 * major bump regardless of type.
 */
export function isBumping(message: string): boolean {
  const subject = message.split('\n', 1)[0] ?? '';
  const header = subject.match(/^([a-zA-Z]+)(\([^)]*\))?(!)?:/);
  if (!header) return false;
  const [, type, , breaking] = header;
  if (breaking) return true;
  // The footer form is authoritative even under a non-bumping type.
  if (/^BREAKING[ -]CHANGE:/m.test(message)) return true;
  return BUMPING_TYPES.includes((type ?? '').toLowerCase());
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
  process.exit(decision.needed ? 0 : 1);
}
