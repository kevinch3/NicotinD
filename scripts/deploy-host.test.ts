import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * deploy-host.yml puts one exact version on the host (docs/deployment.md
 * "Rollback"). These are the properties that make it safe to run by hand and
 * from every release, each of which a plausible edit would quietly undo.
 * Parsed, not grepped, so a comment cannot satisfy them.
 */
type Step = { name?: string; run?: string };
type Job = {
  if?: string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  environment?: string;
  steps?: Step[];
};
const root = join(import.meta.dir, '..', '.github', 'workflows');
const host = parse(readFileSync(join(root, 'deploy-host.yml'), 'utf8')) as {
  on: Record<string, { inputs: Record<string, unknown> }>;
  jobs: Record<string, Job>;
};
const release = parse(readFileSync(join(root, 'deploy.yml'), 'utf8')) as {
  concurrency: { group: string };
};
const deploy = host.jobs.deploy!;
const step = (name: string): string => (deploy.steps ?? []).find((s) => s.name === name)?.run ?? '';
const ssh = step('Deploy via SSH');

describe('deploy-host.yml', () => {
  it('is dispatched — by the edge job and by hand for a rollback', () => {
    expect(Object.keys(host.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(host.on.workflow_dispatch!.inputs)).toEqual(
      expect.arrayContaining(['version', 'ref', 'expect_commit', 'force']),
    );
  });

  // An edge build carries the last release's version number, so only its
  // commit identifies it.
  it('accepts edge only together with a commit to verify', () => {
    const v = step('Validate inputs');
    expect(v).toContain('|edge)$');
    expect(v).toContain('version edge needs expect_commit');
  });

  // One pending run per group: sharing deploy.yml's workflow-level group would
  // let a queued edge deploy evict a queued release build.
  it('queues host deploys on their own group, never on the release lane', () => {
    expect(deploy.concurrency?.group).toBeString();
    expect(deploy.concurrency?.group).not.toBe(release.concurrency.group);
    expect(deploy.concurrency?.['cancel-in-progress']).toBe(false);
  });

  // Both inputs are interpolated into a shell command on the host.
  it('validates version and ref before anything interpolates them', () => {
    const names = (deploy.steps ?? []).map((s) => s.name);
    expect(names.indexOf('Validate inputs')).toBe(0);
    const v = step('Validate inputs');
    expect(v).toContain('v[0-9]+\\.[0-9]+\\.[0-9]+');
    expect(v).toContain('[0-9a-f]{40}');
  });

  it('refuses to override a NICOTIND_VERSION pin in .env instead of silently beating it', () => {
    expect(ssh).toContain('^[[:space:]]*NICOTIND_VERSION=');
    expect(ssh.indexOf('NICOTIND_VERSION=" .env')).toBeLessThan(
      ssh.indexOf('export NICOTIND_VERSION='),
    );
  });

  it('snapshots the database after pulling and before replacing the server', () => {
    const pull = ssh.indexOf('xargs -n1 docker pull');
    const snap = ssh.indexOf('pre-deploy-snapshot.ts');
    const up = ssh.indexOf('docker compose up');
    expect(pull).toBeGreaterThan(-1);
    expect(snap).toBeGreaterThan(pull);
    expect(up).toBeGreaterThan(snap);
  });

  // A skipped deploy must never read as a deployed one (#457).
  it('reports a hold in its own job rather than just not deploying', () => {
    expect(deploy.if).toBe("vars.DEPLOY_HOLD != 'true' || inputs.force");
    expect(host.jobs.hold?.if).toBe("vars.DEPLOY_HOLD == 'true' && !inputs.force");
  });

  it('verifies the version, and the build commit when the caller knows it', () => {
    const verify = step('Verify the deploy is serving the version we shipped');
    // The run text escapes its quotes for the remote shell: `\"version\":`.
    expect(verify).toContain('\\"version\\":');
    expect(verify).toContain('\\"commit\\":');
    expect(verify).toContain('inputs.expect_commit');
  });
});
