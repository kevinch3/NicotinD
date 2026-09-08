import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * On 2026-09-08 the deploy host's Docker data root hit 0 bytes free (789
 * unpruned images + 3,803 build-cache entries). Nothing noticed: Lidarr's
 * SQLite started failing, its healthcheck went red, and the API would not
 * start. The pre-flight space check made before that deploy had looked at
 * `/var/lib/docker` — which on that host is NOT where Docker stores anything
 * (`DockerRootDir=/mnt/data1tb/docker`, a different filesystem with different
 * free space). A check against the wrong filesystem is worse than no check:
 * it reads green while the volume being written to is full. Issue #1021.
 *
 * Parsed and ordered, not grepped: the guard has to run BEFORE the pull to be
 * a guard at all.
 */
const repoRoot = join(import.meta.dir, '..');
const deploy = parse(readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8')) as {
  jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
};

const deployScript = (): string => {
  const steps = Object.values(deploy.jobs).flatMap((job) => job.steps ?? []);
  const step = steps.find((s) => s.name === 'Deploy via SSH');
  expect(step, 'deploy.yml must still have a "Deploy via SSH" step').toBeDefined();
  return step!.run ?? '';
};

describe('the deploy checks disk headroom before it pulls (issue #1021)', () => {
  it('resolves the real Docker data root instead of assuming /var/lib/docker', () => {
    const run = deployScript();
    expect(run).toContain('DockerRootDir');
    expect(run).not.toContain('df -Pk /var/lib/docker');
  });

  it('runs the check before the first docker pull, not after', () => {
    const run = deployScript();
    const guard = run.indexOf('DockerRootDir');
    const pull = run.indexOf('docker pull');
    expect(guard).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(pull);
  });

  it('fails the deploy rather than warning, and says how to reclaim', () => {
    const run = deployScript();
    // The images are already published by the time this step runs; a warning
    // that scrolls past is how the previous silent failure happened.
    expect(run).toMatch(/::error::[^\n]*disk/i);
    expect(run).toContain('docker builder prune');
  });
});
