import { describe, it, expect } from 'bun:test';
import { checkPrTitle } from './check-pr-title.js';
import { KNOWN_TYPES } from './release-needed.js';

describe('checkPrTitle — rule 1, the title is a conventional commit', () => {
  it('accepts every type the release guard knows, with and without a scope', () => {
    for (const type of KNOWN_TYPES) {
      expect(checkPrTitle(`${type}: do a thing`).ok).toBe(true);
      expect(checkPrTitle(`${type}(radio): do a thing`).ok).toBe(true);
    }
  });

  it('accepts a breaking marker', () => {
    expect(checkPrTitle('refactor!: drop the old route').ok).toBe(true);
    expect(checkPrTitle('chore(api)!: rename the column').ok).toBe(true);
  });

  /**
   * The exact title that froze releases: five `feat:` commits squashed under a
   * subject with no type at all, so master gained a commit that bumps nothing
   * and v0.8.40 stayed the latest release (#1263).
   */
  it('rejects the title that actually froze the releases', () => {
    const verdict = checkPrTitle(
      'Radio queue depth: replace batch refill with target-based top-up',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toContain('not a conventional commit');
  });

  it('rejects a prose title, however well written', () => {
    for (const title of [
      'Fix the queue',
      'Update dependencies',
      'WIP',
      'Merge branch master into feature',
    ]) {
      expect(checkPrTitle(title).ok).toBe(false);
    }
  });

  /**
   * "Radio queue depth:" has a colon, which is exactly how a prose title sneaks
   * past a lazy `includes(':')` test. The type must be a single word.
   */
  it('rejects a multi-word prefix before the colon', () => {
    expect(checkPrTitle('Radio queue depth: a thing').ok).toBe(false);
    expect(checkPrTitle('Big fix: a thing').ok).toBe(false);
  });

  it('rejects a type nobody has agreed on', () => {
    const verdict = checkPrTitle('feature(radio): do a thing');
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toContain('Unknown type "feature"');
  });

  it('rejects a type with no description behind it', () => {
    expect(checkPrTitle('feat:').ok).toBe(false);
    expect(checkPrTitle('feat:   ').ok).toBe(false);
  });

  it('is case-insensitive about the type, as the release guard is', () => {
    expect(checkPrTitle('Feat(radio): do a thing').ok).toBe(true);
  });
});

describe('checkPrTitle — rule 2, the title carries the strongest bump on the branch', () => {
  const feat = 'feat(radio): hold the queue at a depth\n\nA body.';
  const fix = 'fix(player): stop the stall';
  const docs = 'docs: explain the thing';

  it('fails a non-bumping title over bumping commits — the squash would drop them', () => {
    const verdict = checkPrTitle('chore: tidy the player up', [feat, docs]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toContain('thrown away');
    expect(verdict.problems[0]).toContain('feat(radio): hold the queue at a depth');
  });

  it('passes a bumping title over bumping commits', () => {
    expect(checkPrTitle('feat(radio): hold the queue at a depth', [feat, docs]).ok).toBe(true);
    expect(checkPrTitle('fix(player): stop the stall', [fix]).ok).toBe(true);
  });

  /** A branch of only docs/chore commits is free to be titled as one. */
  it('leaves a non-bumping title alone when nothing on the branch bumps', () => {
    expect(checkPrTitle('docs: explain the thing', [docs, 'test: add a case']).ok).toBe(true);
    expect(checkPrTitle('refactor(db): rename a column', []).ok).toBe(true);
  });

  /** A breaking title outranks feat/fix, so it must satisfy the rule too. */
  it('accepts a breaking title over bumping commits', () => {
    expect(checkPrTitle('refactor(api)!: drop the route', [feat]).ok).toBe(true);
  });

  it('counts a BREAKING CHANGE footer on a branch commit as a bump', () => {
    const breaking = 'docs: rewrite the guide\n\nBREAKING CHANGE: the flag is gone';
    const verdict = checkPrTitle('docs: rewrite the guide', [breaking]);
    expect(verdict.ok).toBe(false);
  });

  /**
   * Only the subject of each branch commit decides, the same rule the release
   * guard applies — otherwise a PR description quoted in a body would make an
   * honest `docs:` title unmergeable.
   */
  it('ignores a bumping type quoted inside a commit body', () => {
    const quoting = 'docs: record the fix\n\nThis documents "fix(radio): stop the stall".';
    expect(checkPrTitle('docs: record the fix', [quoting]).ok).toBe(true);
  });

  it('reports both problems at once when the title is neither valid nor bumping', () => {
    const verdict = checkPrTitle('Radio queue depth: a thing', [feat]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.length).toBe(2);
  });
});
