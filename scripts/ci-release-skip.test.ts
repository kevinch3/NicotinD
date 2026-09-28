import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * The `chore(release):` commit is validated by the release job BEFORE it is
 * pushed, so CI does not re-run every gate on it (docs/releasing.md "The
 * release commit is checked before it is pushed").
 *
 * Both halves matter. Skipping CI on the release commit without the in-job
 * check would leave the generated F-Droid changelogs — the one file class only
 * that commit produces — checked by nothing; the in-job check without the skip
 * is fourteen jobs of work whose result nothing waits on, because the tag has
 * already started deploy.yml.
 *
 * Parsed, not grepped, so a comment cannot satisfy it.
 */
type Job = { if?: string; steps?: { name?: string; run?: string }[] };

const repoRoot = join(import.meta.dir, '..');
const ci = parse(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
};

// `|| ''`: a pull request has no head_commit, so a missing message must compare
// as not-a-release rather than lean on startsWith(null) semantics.
const SKIP = "!startsWith(github.event.head_commit.message || '', 'chore(release):')";

const release = parse(readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
};

describe('CI skips the release commit, and the release job checks it instead', () => {
  it('every ci.yml job skips a chore(release) push', () => {
    for (const [name, job] of Object.entries(ci.jobs)) {
      expect({ name, if: job.if }).toEqual({ name, if: expect.stringContaining(SKIP) });
    }
  });

  it('the e2e rollup keeps its load-bearing always() (#908)', () => {
    // Without always() the rollup is SKIPPED when a shard fails, so the
    // required `e2e` context never reports its failure (see ci.yml).
    expect(ci.jobs.e2e?.if).toMatch(/^always\(\) && /);
  });

  it('the release step runs check:fdroid after cutting the release and before pushing it', () => {
    const run =
      (release.jobs.release?.steps ?? []).find((s) => s.run?.includes('bun run release'))?.run ??
      '';
    const cut = run.indexOf('bun run release');
    const check = run.indexOf('bun run check:fdroid');
    const push = run.indexOf('git push --atomic');
    expect(cut).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(cut);
    expect(push).toBeGreaterThan(check);
  });

  // release.yml no longer runs inside the CI run of the commit it releases, so
  // it cannot `needs:` the gates. The `edge` job succeeding on the exact tip is
  // the proof instead, and it must be checked before anything is cut.
  it('releases only a tip whose edge run succeeded, checked before the release is cut', () => {
    const run =
      (release.jobs.release?.steps ?? []).find((s) => s.run?.includes('bun run release'))?.run ??
      '';
    const green = run.indexOf('check_name=edge');
    expect(green).toBeGreaterThan(-1);
    expect(green).toBeLessThan(run.search(/^\s*bun run release$/m));
    expect(run).toContain('select(.conclusion == "success")');
  });
});
