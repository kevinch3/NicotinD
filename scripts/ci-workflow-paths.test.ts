import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * A step with its own `working-directory` cannot reach the repo's `scripts/`
 * by a relative path. The edge job's "Point edge at this commit" ran in
 * `$RUNNER_TEMP/digests`, so `bash scripts/registry-retry.sh` exited 127 after
 * `:edge` moved, and every master run from #1782 on skipped the host deploy.
 */
type Step = { name?: string; run?: string; 'working-directory'?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

const dir = join(import.meta.dir, '..', '.github/workflows');
const RELATIVE_SCRIPT = /(^|[\s"'(=;&|])\.?\/?scripts\//m;

function offenders(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const wf = parse(readFileSync(join(dir, file), 'utf8')) as Workflow;
    for (const [job, def] of Object.entries(wf.jobs ?? {})) {
      for (const step of def.steps ?? []) {
        if (step['working-directory'] && step.run && RELATIVE_SCRIPT.test(step.run)) {
          out.push(`${file} › ${job} › ${step.name ?? '(unnamed)'}`);
        }
      }
    }
  }
  return out;
}

describe('workflow steps reach repo scripts', () => {
  it('never call scripts/ relatively from a step with its own working-directory', () => {
    expect(offenders()).toEqual([]);
  });
});
