import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { auditJob, auditPublishJob, PACKAGING_JOBS } from './check-desktop-publish.js';

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

// The publish step as #1631 wires it: the APKs are required, each desktop feed
// rides on its own job's result.
const PUBLISH_RUN =
  'bun scripts/github-release.ts publish --id "1" --tag "$GITHUB_REF_NAME" \\\n' +
  '  --expect "NicotinD-$v.apk,NicotinD-TV-$v.apk" \\\n' +
  '  --feed "latest-linux.yml=${{ needs.desktop-linux.result }}" \\\n' +
  '  --feed "latest-mac.yml=${{ needs.desktop-mac.result }}"';
const IF =
  "!cancelled() && github.ref_type == 'tag' && needs.create-draft.result == 'success' && " +
  "needs.release-notes.result == 'success' && needs.android.result == 'success'";
const publishJob = (over: Record<string, unknown> = {}) => ({
  needs: ['create-draft', 'release-notes', 'android', 'desktop-linux', 'desktop-mac'],
  if: IF,
  steps: [{ run: PUBLISH_RUN }],
  ...over,
});

describe('auditPublishJob', () => {
  it('passes publish-release as #1631 wires it', () => {
    expect(auditPublishJob(publishJob())).toEqual([]);
  });

  // The v0.8.122 shape: the default success() makes every desktop job a gate on
  // the APKs, so a cancelled desktop-mac left F-Droid nothing at the tag.
  it('fails a publish job that no longer runs past a failed desktop job', () => {
    const errors = auditPublishJob(publishJob({ if: "github.ref_type == 'tag'" }));
    expect(errors.some((e) => e.includes('!cancelled()'))).toBe(true);
  });

  it('fails a publish job that stopped requiring android', () => {
    const errors = auditPublishJob(publishJob({ if: "!cancelled() && github.ref_type == 'tag'" }));
    expect(errors.some((e) => e.includes("needs.android.result == 'success'"))).toBe(true);
  });

  it('fails a publish job that requires a desktop job to succeed again', () => {
    const errors = auditPublishJob(
      publishJob({ if: `${IF} && needs.desktop-mac.result == 'success'` }),
    );
    expect(errors.some((e) => e.includes('desktop-mac'))).toBe(true);
  });

  // Without the need, publish can run before the desktop upload finishes.
  it('fails when a packaging job is missing from needs', () => {
    const errors = auditPublishJob(
      publishJob({ needs: ['create-draft', 'release-notes', 'android', 'desktop-linux'] }),
    );
    expect(errors.some((e) => e.includes('desktop-mac'))).toBe(true);
  });

  it('fails when a feed is not passed with its own job result', () => {
    const run = PUBLISH_RUN.replace('needs.desktop-mac.result', 'needs.desktop-linux.result');
    const errors = auditPublishJob(publishJob({ steps: [{ run }] }));
    expect(errors.some((e) => e.includes('latest-mac.yml'))).toBe(true);
  });

  // A feed in --expect is required unconditionally: that is the coupling again.
  it('fails when a desktop feed is required unconditionally', () => {
    const run = PUBLISH_RUN.replace('NicotinD-TV-$v.apk"', 'NicotinD-TV-$v.apk,latest-mac.yml"');
    const errors = auditPublishJob(publishJob({ steps: [{ run }] }));
    expect(errors.some((e) => e.includes('--expect'))).toBe(true);
  });

  it('fails when there is no publish step at all', () => {
    expect(auditPublishJob(publishJob({ steps: [{ run: 'echo hi' }] }))).toHaveLength(1);
  });
});

describe('deploy.yml as it stands', () => {
  const workflow = parse(readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>;
  };

  it('publish-release publishes on the APKs, not on every desktop job', () => {
    const job = workflow.jobs['publish-release'];
    expect(job).toBeDefined();
    expect(auditPublishJob(job as Parameters<typeof auditPublishJob>[0])).toEqual([]);
  });

  it.each(PACKAGING_JOBS)('%s builds, uploads by id and then verifies', (name) => {
    const job = workflow.jobs[name];
    expect(job).toBeDefined();
    expect(auditJob(name, job!.steps ?? [])).toEqual([]);
  });
});
