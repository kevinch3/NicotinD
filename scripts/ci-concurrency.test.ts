import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * `ci.yml` grouped every master push under `ci-${{ github.ref }}`. GitHub holds
 * exactly ONE pending run per group, so a third push evicted the second —
 * `cancel-in-progress: false` (the #360 fix) governs only the *running* member
 * and has no say over the pending one. Four master commits in five days got
 * zero CI run of their own, two of them `fix:` (issue #906).
 *
 * Parsed, not grepped, for the same reason `deploy-concurrency.test.ts` is: a
 * regex over the raw file would be satisfied by a `group:` inside a comment.
 */
const repoRoot = join(import.meta.dir, '..');
interface Step {
  name?: string;
  run?: string;
}
const ci = parse(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as {
  concurrency?: { group?: string; 'cancel-in-progress'?: string | boolean };
  jobs: Record<string, { concurrency?: { group?: string }; steps?: Step[] }>;
};

describe('every master commit gets its own CI run (issue #906)', () => {
  it('keys the master group on the commit, so no push can evict another', () => {
    const group = ci.concurrency?.group;
    expect(group).toBeString();
    // Without `github.sha` in the master arm, all master pushes share one
    // group and the single pending slot silently drops the middle commit.
    expect(group).toContain('github.sha');
  });

  it('still refuses to cancel a running master push (issue #360)', () => {
    // The release job pushes a version-bump commit to master, which must not
    // cancel the very run that produced it.
    expect(String(ci.concurrency?.['cancel-in-progress'])).toContain(
      "github.ref != 'refs/heads/master'",
    );
  });

  it('serializes the release job, which per-commit groups would otherwise run in parallel', () => {
    // Per-SHA workflow groups mean two master merges no longer queue behind
    // each other — which is the point — but two `release` jobs tagging and
    // pushing at once is not. A constant job-level group restores exactly the
    // serialization the shared workflow group used to provide, and nothing else.
    const group = ci.jobs.release?.concurrency?.group;
    expect(group).toBeString();
    expect(group).not.toContain('${{');
  });
});

/**
 * The sidecar change filter enumerates the image's build inputs by hand and
 * omitted `app/` — the directory the Dockerfile `COPY`s (issue #880). An
 * `app/**` edit therefore skipped the very smoke build meant to guard it, and
 * then failed at tag time inside the deploy job that gates the whole release.
 */
describe('the sidecar image filter sees the source the image is built from (issue #880)', () => {
  const filter = ci.jobs.docker?.steps?.find((s) => s.name?.startsWith('Detect analysis-image'));

  it('has a filter step to check', () => {
    expect(filter?.run).toBeString();
  });

  for (const pkg of ['analysis']) {
    it(`treats packages/${pkg}/app/ as a build input`, () => {
      expect(filter?.run).toContain(`packages/${pkg}/app/`);
    });

    it(`treats packages/${pkg}/.dockerignore as a build input`, () => {
      // `context: packages/<pkg>` (the build step) makes it shape what the
      // build even sees. Matched inside THAT package's alternation, so the
      // other package's entry cannot satisfy this.
      expect(filter?.run ?? '').toMatch(new RegExp(`packages/${pkg}/\\([^)]*\\\\.dockerignore`));
    });
  }

  /**
   * Asserting the regex *text* only proves someone typed the path. These run
   * the filter's own extracted patterns against real paths, which is the thing
   * that actually decides whether a 3 GB GPU image gets built.
   */
  describe('behaviour of the extracted patterns', () => {
    const patterns = [...((filter?.run ?? '').matchAll(/grep -qE '([^']+)'/g))].map(
      (m) => new RegExp(m[1]!),
    );
    const [analysis] = patterns;

    const CASES: Array<[string, boolean]> = [
      // path, analysis builds?
      ['packages/analysis/app/rhythm.py', true],
      ['packages/analysis/Dockerfile', true],
      ['packages/analysis/.dockerignore', true],
      ['.github/workflows/ci.yml', true],
      ['.github/workflows/deploy.yml', true],
      // Anchoring: a backup file must not trigger the build.
      ['packages/analysis/pyproject.toml.bak', false],
      ['.github/workflows/ci.yml.orig', false],
      // Ordinary source changes stay cheap.
      ['packages/api/src/services/library-scanner.ts', false],
      ['packages/web/src/app/app.ts', false],
    ];

    it('extracted exactly the one image filter', () => {
      expect(patterns).toHaveLength(1);
    });

    for (const [path, wantAnalysis] of CASES) {
      it(`${path} -> analysis=${wantAnalysis}`, () => {
        expect(analysis!.test(path)).toBe(wantAnalysis);
      });
    }
  });

  it('anchors every alternative, so a stray backup file cannot trigger a 3 GB build', () => {
    // `Dockerfile|pyproject\.toml)$` anchors only the last alternative; a
    // `pyproject.toml.bak` would otherwise match and rebuild the image.
    const alternatives = (filter?.run ?? '').match(/grep -qE '[^']+'/g) ?? [];
    expect(alternatives).toHaveLength(1);
    for (const alt of alternatives) {
      // Every non-directory branch ends in `$`; directory branches end in `/`.
      expect(alt).toMatch(/\)\$/);
    }
  });
});
