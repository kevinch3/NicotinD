import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * GHCR can briefly 404 a manifest it just accepted, so every registry read that
 * follows a push in the edge/release pipelines goes through registry-retry.sh
 * (#1624). These pin both the helper's behaviour and that the reads use it.
 */
const repoRoot = join(import.meta.dir, '..');
const script = join(repoRoot, 'scripts/registry-retry.sh');

/** A command that fails `failures` times, then succeeds; counts its calls. */
function flaky(failures: number): { cmd: string[]; calls: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'registry-retry-'));
  const counter = join(dir, 'n');
  writeFileSync(counter, '0');
  const body = `n=$(($(cat ${counter}) + 1)); echo $n > ${counter}; [ $n -gt ${failures} ]`;
  return { cmd: ['bash', '-c', body], calls: () => Number(readFileSync(counter, 'utf8').trim()) };
}

function run(cmd: string[], attempts = 4) {
  return Bun.spawnSync(['bash', script, ...cmd], {
    env: { ...process.env, REGISTRY_RETRY_ATTEMPTS: String(attempts), REGISTRY_RETRY_DELAY: '0' },
  });
}

describe('registry-retry.sh', () => {
  it('succeeds on the first try without retrying', () => {
    const f = flaky(0);
    expect(run(f.cmd).exitCode).toBe(0);
    expect(f.calls()).toBe(1);
  });

  it('rides out a read-after-write lag', () => {
    const f = flaky(2);
    const r = run(f.cmd);
    expect(r.exitCode).toBe(0);
    expect(f.calls()).toBe(3);
    expect(r.stderr.toString()).toContain('attempt 2/4');
  });

  it('gives up after the bound with the command exit code', () => {
    const f = flaky(99);
    const r = run(f.cmd, 3);
    expect(r.exitCode).toBe(1);
    expect(f.calls()).toBe(3);
    expect(r.stderr.toString()).toContain('failed after 3 attempts');
  });
});

describe('registry reads after a push are retried', () => {
  for (const wf of ['ci.yml', 'deploy.yml']) {
    const yml = readFileSync(join(repoRoot, '.github/workflows', wf), 'utf8');
    it(`${wf}: every docker pull and imagetools inspect goes through the helper`, () => {
      const reads = yml
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => !l.startsWith('#'))
        .filter((l) => /\bdocker pull\b|imagetools inspect\b/.test(l));
      expect(reads.length).toBeGreaterThan(0);
      // A probe inside an `if` decides a branch on absence; retrying it would only
      // slow the "not there" answer, so those are the one allowed exception.
      for (const l of reads.filter((l) => !/^(if|elif) /.test(l))) {
        expect(l).toContain('scripts/registry-retry.sh');
      }
    });
  }
});

describe('edge never moves backward (#1624)', () => {
  const yml = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const edgeJob = yml.slice(yml.indexOf('\n  edge:\n'));

  it('checks the commit :edge carries before moving it', () => {
    const guard = edgeJob.indexOf('id: order');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(edgeJob.indexOf('imagetools create -t "$IMAGE:edge"'));
    expect(edgeJob).toContain('git merge-base --is-ancestor "$GITHUB_SHA" "$current"');
  });

  it('gates both tag moves and the host deploy on it', () => {
    for (const step of [
      'Point edge at this commit',
      'Point the analysis edge at it',
      'Deploy this commit to the host',
    ]) {
      const at = edgeJob.indexOf(`- name: ${step}\n`);
      expect(at).toBeGreaterThan(0);
      const next = edgeJob.slice(at).split('\n')[1];
      expect(next.trim()).toBe("if: steps.order.outputs.skip != 'true'");
    }
  });
});
