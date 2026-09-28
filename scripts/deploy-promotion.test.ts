import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * The floating image tags (`release`, `vX`) are what every self-hoster pulls,
 * so they move last: after the release's exact `vX.Y.Z` image was pushed,
 * booted from the registry (docker), and scanned (docker-merge). Before this,
 * docker-merge moved all three tags and ran Trivy afterwards, and
 * docker-analysis moved its own `release` in parallel, unverified — a Trivy
 * finding stopped the deploy but not the tag self-hosters pull.
 * docs/deployment.md "Tag semantics".
 *
 * Parsed, not grepped, so a comment cannot satisfy it.
 */
type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; if?: string; steps?: Step[] };

const repoRoot = join(import.meta.dir, '..');
const deploy = parse(readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
};

const needsOf = (job: Job | undefined): string[] =>
  job?.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];

/** Everything a job hands the registry: run scripts plus action inputs. */
const jobText = (job: Job): string =>
  (job.steps ?? []).map((s) => `${s.run ?? ''}\n${JSON.stringify(s.with ?? {})}`).join('\n');

const FLOATING = /:(release|\$major|\$\{major\})\b|\$\{\{\s*env\.IMAGE\s*\}\}:release/;

describe('floating image tags move only after the release image is proven', () => {
  it('only `promote` claims `release` or `vX`', () => {
    for (const [name, job] of Object.entries(deploy.jobs)) {
      if (name === 'promote' || name === 'deploy') continue;
      expect({ name, floating: FLOATING.test(jobText(job)) }).toEqual({ name, floating: false });
    }
    expect(FLOATING.test(jobText(deploy.jobs.promote!))).toBe(true);
  });

  it('promote needs the job that scans the image and the analysis image', () => {
    const scanner = Object.entries(deploy.jobs).find(([, job]) =>
      (job.steps ?? []).some((s) => s.uses?.startsWith('aquasecurity/trivy-action')),
    )?.[0];
    expect(scanner).toBe('docker-merge');
    expect(needsOf(deploy.jobs.promote)).toEqual(
      expect.arrayContaining(['docker-merge', 'docker-analysis']),
    );
  });

  it('docker-merge needs the per-arch job that boots the pushed image', () => {
    expect(needsOf(deploy.jobs['docker-merge'])).toContain('docker');
    const smoke = (deploy.jobs.docker?.steps ?? []).find((s) =>
      s.run?.includes('scripts/smoke-image.sh'),
    );
    expect(smoke?.run).toContain('steps.build.outputs.digest');
  });

  it('deploy waits for promote and deploys that exact version (#457)', () => {
    // Plain `needs` semantics are the #457 guard: a skipped or failed promote
    // skips the deploy rather than redeploying the previous version.
    expect(needsOf(deploy.jobs.deploy)).toEqual(['promote']);
    const job = deploy.jobs.deploy as Job & { uses?: string; with?: Record<string, string> };
    expect(job.if).toBe("github.ref_type == 'tag'");
    expect(job.uses).toBe('./.github/workflows/deploy-host.yml');
    expect(job.with).toEqual({ version: '${{ github.ref_name }}', ref: '${{ github.ref_name }}' });
  });
});
