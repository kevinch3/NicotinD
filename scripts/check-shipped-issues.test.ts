import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  GIT_EXEC_OPTIONS,
  parseIssueRefs,
  shippedCandidates,
} from './check-shipped-issues.js';

/**
 * Issue #257. The distinction these tests pin is the whole point: `Closes #12`
 * in a PR body is an *action* GitHub honours on merge; `(#12)` in a commit
 * subject is a *link* that leaves the issue open forever. The repo used both,
 * which is how six issues (and later five more) shipped while staying open.
 */
describe('parseIssueRefs', () => {
  it('flags the closing keywords GitHub honours', () => {
    for (const kw of ['Closes', 'closes', 'Closed', 'Fixes', 'fix', 'Resolves', 'resolved']) {
      expect(parseIssueRefs(`${kw} #42`), kw).toEqual([{ number: 42, closing: true }]);
    }
  });

  it('treats a bare subject reference as a link, not an action', () => {
    // This is the form that silently leaves work open.
    expect(parseIssueRefs('fix(hunt): rank folders better (#271)')).toEqual([
      { number: 271, closing: false },
    ]);
  });

  it('prefers the closing form when a message contains both', () => {
    const refs = parseIssueRefs('feat(x): thing (#12)\n\nCloses #12');
    expect(refs).toEqual([{ number: 12, closing: true }]);
  });

  it('collects several distinct issues from one message', () => {
    const refs = parseIssueRefs('fix: six bugs (#258 #261 #262)\n\nCloses #258');
    expect(refs.find((r) => r.number === 258)?.closing).toBe(true);
    expect(refs.find((r) => r.number === 261)?.closing).toBe(false);
    expect(refs).toHaveLength(3);
  });

  it('finds nothing in a message with no issue reference', () => {
    expect(parseIssueRefs('chore(release): 0.1.275')).toEqual([]);
  });
});

describe('shippedCandidates', () => {
  const open = [
    { number: 10, title: 'Still open, was referenced' },
    { number: 11, title: 'Still open, never mentioned' },
  ];

  it('reports an open issue a shipped commit referenced', () => {
    const out = shippedCandidates(open, [
      { sha: 'aaa', message: 'feat: thing (#10)' },
      { sha: 'bbb', message: 'chore: unrelated' },
    ]);
    expect(out).toEqual([
      { number: 10, title: 'Still open, was referenced', commits: ['aaa'], anyClosing: false },
    ]);
  });

  /**
   * The loudest case: a closing keyword that did NOT close means it lived only
   * in a commit body, never the PR body — exactly the #257 failure mode.
   */
  it('marks an issue whose commit used a closing keyword yet is still open', () => {
    const out = shippedCandidates(open, [{ sha: 'ccc', message: 'fix: x\n\nCloses #10' }]);
    expect(out[0].anyClosing).toBe(true);
  });

  it('ignores references to issues that are already closed', () => {
    // #99 is not in the open list — the common case after a correct merge.
    expect(shippedCandidates(open, [{ sha: 'ddd', message: 'fix: y (#99)' }])).toEqual([]);
  });

  it('collects every commit that touched one issue', () => {
    const out = shippedCandidates(open, [
      { sha: 'aaa', message: 'part one (#10)' },
      { sha: 'bbb', message: 'part two (#10)' },
    ]);
    expect(out[0].commits).toEqual(['aaa', 'bbb']);
  });

  it('sorts by issue number so the report is stable across runs', () => {
    const many = [
      { number: 30, title: 'c' },
      { number: 10, title: 'a' },
      { number: 20, title: 'b' },
    ];
    const out = shippedCandidates(many, [{ sha: 'x', message: '(#30) (#10) (#20)' }]);
    expect(out.map((c) => c.number)).toEqual([10, 20, 30]);
  });
});

/**
 * `--all` is a documented mode of this script, and it threw `ENOBUFS` on this
 * repo instead of reporting: whole-history `git log --format=%H%B` is ~1.3 MB,
 * past `execFileSync`'s 1 MB default. The report that exists to keep the open
 * list honest could not read the history it audits.
 *
 * The payload here is synthetic on purpose. Asserting against the repo's own
 * history would pass vacuously under a shallow CI checkout — the false
 * denominator this repo's gates are written to avoid.
 */
describe('GIT_EXEC_OPTIONS', () => {
  const BYTES = 4 * 1024 * 1024;
  const emit = ['-e', `process.stdout.write('x'.repeat(${BYTES}))`];

  it('is the constraint: the execFileSync default cannot carry this much output', () => {
    expect(() => execFileSync('bun', emit, { encoding: 'utf8' })).toThrow(/ENOBUFS/);
  });

  it('reads subprocess output past the 1 MB execFileSync default', () => {
    expect(execFileSync('bun', emit, GIT_EXEC_OPTIONS)).toHaveLength(BYTES);
  });
});
