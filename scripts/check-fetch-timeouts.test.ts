import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { NOT_OUTBOUND, findFetchSites } from './check-fetch-timeouts.js';

const ROOT = resolve(import.meta.dir, '..');
const sites = (src: string) => findFetchSites(src, 't.ts');

describe('findFetchSites', () => {
  it('flags a fetch with no RequestInit at all', () => {
    expect(sites('await fetch(url);')[0]?.hasSignal).toBe(false);
  });

  it('accepts an inline signal', () => {
    expect(sites('await fetch(url, { signal: AbortSignal.timeout(5000) });')[0]?.hasSignal).toBe(
      true,
    );
  });

  it('accepts a signal alongside a spread', () => {
    expect(sites('await fetch(u, { ...init, signal: s });')[0]?.hasSignal).toBe(true);
  });

  it('rejects an init hidden behind a variable — it cannot be verified here', () => {
    // Not pedantry: `fetch(url, opts)` is exactly how a missing timeout hides.
    expect(sites('await fetch(url, opts);')[0]?.hasSignal).toBe(false);
  });

  it('rejects a spread-only init for the same reason', () => {
    expect(sites('await fetch(url, { ...init });')[0]?.hasSignal).toBe(false);
  });

  /**
   * The shapes that make a grep — or an AST walk keyed on `Identifier === fetch`
   * — miss most of the real call sites. Only the first of these is obvious, and
   * the second is live in LidarrClient.
   */
  it('sees fetch through a parenthesized expression and an alias', () => {
    expect(sites('await (this.fetchFn ?? fetch)(u, { signal: s });')).toHaveLength(1);
    expect(sites('await (globalThis.fetch)(u);')[0]?.hasSignal).toBe(false);
    expect(sites('await fetchFn(u, { signal: s });')[0]?.hasSignal).toBe(true);
  });

  it('ignores callees that mention fetch but are not outbound HTTP', () => {
    for (const [callee] of NOT_OUTBOUND) {
      expect(sites(`await ${callee}(u);`), callee).toHaveLength(0);
    }
  });

  it('every NOT_OUTBOUND entry carries a reason', () => {
    // An allowlist nobody can audit is a mute button.
    for (const [, reason] of NOT_OUTBOUND) expect(reason.length).toBeGreaterThan(20);
  });
});

describe('the real repository', () => {
  it('has no outbound fetch without an abort signal', () => {
    const files = [
      ...new Set(
        execFileSync(
          'git',
          ['ls-files', 'packages/*/src/**/*.ts', 'src/**/*.ts', 'packages/*/src/*.ts', 'src/*.ts'],
          { cwd: ROOT, encoding: 'utf8' },
        )
          .split('\n')
          .filter(Boolean)
          .filter((f) => !f.startsWith('packages/web/'))
          .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts')),
      ),
    ];
    const found = files.flatMap((f) => findFetchSites(readFileSync(resolve(ROOT, f), 'utf8'), f));

    expect(found.filter((s) => !s.hasSignal)).toEqual([]);
    // A floor, so a refactor that stops finding the call sites fails here rather
    // than reporting a confident "all bounded" over an empty set.
    expect(found.length).toBeGreaterThanOrEqual(5);
  });
});
