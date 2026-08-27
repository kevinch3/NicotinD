import { describe, it, expect } from 'bun:test';
import { isBumping, releaseNeeded } from './release-needed.js';

describe('isBumping', () => {
  it('accepts the three releasing types', () => {
    expect(isBumping('feat(radio): add a thing')).toBe(true);
    expect(isBumping('fix(acquire): stop doing a thing')).toBe(true);
    expect(isBumping('perf(scan): go faster')).toBe(true);
  });

  it('rejects the types CLAUDE.md documents as non-bumping', () => {
    for (const type of ['chore', 'refactor', 'style', 'docs', 'test', 'ci', 'build']) {
      expect(isBumping(`${type}: something`)).toBe(false);
    }
  });

  it('treats a breaking marker as releasing under any type', () => {
    expect(isBumping('refactor!: drop the old route')).toBe(true);
    expect(isBumping('chore(api)!: rename the column')).toBe(true);
    expect(isBumping('docs: rewrite\n\nBREAKING CHANGE: the flag is gone')).toBe(true);
  });

  it('ignores a non-conventional subject', () => {
    expect(isBumping('Merge pull request #1 from x/y')).toBe(false);
    expect(isBumping('wip')).toBe(false);
  });

  /**
   * A body can quote a commit message — a PR description listing what it fixed,
   * a revert citing the original. Only the SUBJECT decides the type.
   */
  it('reads the type from the subject, not the body', () => {
    expect(isBumping('chore(release): 0.5.21\n\n* fix(acquire): something (#750)')).toBe(false);
  });
});

describe('releaseNeeded (#755)', () => {
  it('declines when the tip is already the latest tag', () => {
    // Run B after `git reset --hard FETCH_HEAD` lands exactly here: on the
    // `chore(release)` commit run A just published.
    const d = releaseNeeded([], true);
    expect(d.needed).toBe(false);
    expect(d.reason).toMatch(/already the latest tag/);
  });

  it('declines when nothing since the tag is of a releasing type', () => {
    const d = releaseNeeded(['docs: update the playbook', 'ci: bump an action'], false);
    expect(d.needed).toBe(false);
    expect(d.reason).toMatch(/none of a releasing type/);
  });

  it('releases when a fix landed', () => {
    expect(releaseNeeded(['docs: notes', 'fix(api): a real bug'], false).needed).toBe(true);
  });

  it('releases on a breaking change under a non-bumping type', () => {
    expect(releaseNeeded(['refactor!: drop v1'], false).needed).toBe(true);
  });

  /**
   * The exact shape of #755: three PRs merge within a minute, run A publishes
   * v0.5.21 covering all three, run B then finds only A's release commit.
   */
  it('declines the second of two racing runs', () => {
    const runA = releaseNeeded(
      ['fix(acquire): a (#750)', 'fix(acquire): b (#752)', 'fix(acquire): c (#753)'],
      false,
    );
    expect(runA.needed).toBe(true);
    const runB = releaseNeeded([], true);
    expect(runB.needed).toBe(false);
  });
});
