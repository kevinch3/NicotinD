import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { auditJob, PACKAGING_JOBS } from './check-desktop-publish.js';

const ROOT = resolve(import.meta.dir, '..');

const BUILD = {
  name: 'Package Linux desktop app',
  run: 'bunx electron-builder --linux --publish never -c.extraMetadata.version="${GITHUB_REF_NAME#v}"',
};
const PUBLISH = {
  name: 'Attach the Linux desktop artifacts to the GitHub Release',
  run: 'bun run packages/desktop/scripts/release-artifacts.ts | xargs bun scripts/github-release.ts upload --id "1"',
};
const VERIFY = {
  name: 'Verify the Linux artifacts reached the Release',
  run: 'bun run packages/desktop/scripts/verify-published-assets.ts --label desktop-linux',
};

describe('auditJob', () => {
  it('passes a job that builds, uploads by id and then verifies', () => {
    expect(auditJob('desktop-linux', [{ run: 'bun install' }, BUILD, PUBLISH, VERIFY])).toEqual([]);
  });

  // v0.8.103: the publisher cannot see the draft and publishes a second release.
  it.each([
    'bunx electron-builder --linux --publish always',
    'bunx electron-builder --mac --publish=onTagOrDraft',
    'bunx electron-builder --linux -p always',
    'bunx electron-builder --linux --publish',
  ])('fails electron-builder in a publishing mode: %s', (run) => {
    const errors = auditJob('desktop-linux', [{ run }, PUBLISH, VERIFY]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('lets electron-builder publish');
  });

  it('fails a job that builds but never uploads', () => {
    const errors = auditJob('desktop-linux', [BUILD, VERIFY]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('never uploads');
  });

  it('fails a job that uploads before it builds', () => {
    const errors = auditJob('desktop-linux', [PUBLISH, BUILD, VERIFY]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('BEFORE electron-builder');
  });

  // The #1261 shape exactly: build, publish, done — and green.
  it('fails a job that uploads without verifying', () => {
    const errors = auditJob('desktop-linux', [{ run: 'bun install' }, BUILD, PUBLISH]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('never verifies the artifacts landed');
  });

  it('fails a job that verifies before it uploads', () => {
    const errors = auditJob('desktop-linux', [BUILD, VERIFY, PUBLISH]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('BEFORE');
  });

  it('fails a verify step neutered with continue-on-error', () => {
    const errors = auditJob('desktop-linux', [
      BUILD,
      PUBLISH,
      { ...VERIFY, 'continue-on-error': true },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('continue-on-error');
  });

  it('fails when the verify step points at a script that does not exist', () => {
    const errors = auditJob('desktop-linux', [
      BUILD,
      PUBLISH,
      { run: 'bun run packages/desktop/moved/verify-published-assets.ts' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('does not exist');
  });

  // A renamed or deleted packaging job must not retire the check by accident.
  it('fails a job that no longer builds at all, rather than passing vacuously', () => {
    const errors = auditJob('desktop-linux', [{ run: 'bun install' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no longer runs');
  });
});

describe('deploy.yml as it stands', () => {
  const workflow = parse(readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>;
  };

  it.each(PACKAGING_JOBS)('%s builds, uploads by id and then verifies', (name) => {
    const job = workflow.jobs[name];
    expect(job).toBeDefined();
    expect(auditJob(name, job!.steps ?? [])).toEqual([]);
  });
});
