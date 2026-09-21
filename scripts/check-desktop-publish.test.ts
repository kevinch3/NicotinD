import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { auditJob, PACKAGING_JOBS } from './check-desktop-publish.js';

const ROOT = resolve(import.meta.dir, '..');

const PUBLISH = {
  name: 'Package + publish Linux desktop app',
  run: 'bunx electron-builder --linux --publish always -c.extraMetadata.version="${GITHUB_REF_NAME#v}"',
};
const VERIFY = {
  name: 'Verify the Linux artifacts reached the Release',
  run: 'bun run packages/desktop/scripts/verify-published-assets.ts --label desktop-linux',
};

describe('auditJob', () => {
  it('passes a job that publishes and then verifies', () => {
    expect(auditJob('desktop-linux', [{ run: 'bun install' }, PUBLISH, VERIFY])).toEqual([]);
  });

  // The #1261 shape exactly: build, publish, done — and green.
  it('fails a job that publishes without verifying', () => {
    const errors = auditJob('desktop-linux', [{ run: 'bun install' }, PUBLISH]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('never verifies the artifacts landed');
  });

  it('fails a job that verifies before it publishes', () => {
    const errors = auditJob('desktop-linux', [VERIFY, PUBLISH]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('BEFORE');
  });

  it('fails a verify step neutered with continue-on-error', () => {
    const errors = auditJob('desktop-linux', [PUBLISH, { ...VERIFY, 'continue-on-error': true }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('continue-on-error');
  });

  it('fails when the verify step points at a script that does not exist', () => {
    const errors = auditJob('desktop-linux', [
      PUBLISH,
      { run: 'bun run packages/desktop/moved/verify-published-assets.ts' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('does not exist');
  });

  // A renamed or deleted packaging job must not retire the check by accident.
  it('fails a job that no longer publishes at all, rather than passing vacuously', () => {
    const errors = auditJob('desktop-linux', [{ run: 'bun install' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no longer runs');
  });
});

describe('deploy.yml as it stands', () => {
  const workflow = parse(readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>;
  };

  it.each(PACKAGING_JOBS)('%s publishes and then verifies', (name) => {
    const job = workflow.jobs[name];
    expect(job).toBeDefined();
    expect(auditJob(name, job!.steps ?? [])).toEqual([]);
  });
});
