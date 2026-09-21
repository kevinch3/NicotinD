/**
 * Fail when a desktop packaging job can publish nothing and still go green.
 *
 *   bun run check:desktop-publish
 *
 * WHY: electron-builder's GitHub publisher declines to upload into a release
 * whose type does not match its `releaseType`, logs `skipped publishing` once
 * per file, and **exits 0**. deploy.yml's `release-notes` job creates the tag's
 * release as published seconds after the tag lands, so the publisher's `draft`
 * default silently dropped every AppImage, deb, dmg and `latest-*.yml` from
 * v0.1.232 to v0.8.39 — ~40 releases, two months, both jobs green (#1261).
 *
 * Two things had to hold for that to stop, and neither is visible from the file
 * it lives in:
 *
 *   1. `packages/desktop/electron-builder.yml` pins `releaseType: release`.
 *      Covered by a unit test next to the config it asserts.
 *   2. Every packaging job checks, *after* publishing, that what it built
 *      actually reached the release. That is a wiring invariant spanning
 *      deploy.yml and packages/desktop/scripts — no unit test sees both ends.
 *
 * This gate is (2). A safety step nobody wired is off: the step can be dropped,
 * renamed, reordered before the upload, or neutered with `continue-on-error`,
 * and every one of those restores the exact silence #1261 shipped in.
 *
 * DENOMINATOR: it fails when it finds FEWER packaging jobs than it expects
 * rather than passing over an empty set. A gate that stops finding its subject
 * is not a gate that passes — that is how a renamed job would retire this
 * check without anyone deciding to.
 *
 * NETWORK-FREE: everything here is read off the repo.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dir, '..');
const WORKFLOW = '.github/workflows/deploy.yml';

/**
 * The packaging jobs that must carry the check. Named rather than discovered so
 * that deleting one is a decision someone makes here, not a silent pass.
 */
export const PACKAGING_JOBS = ['desktop-linux', 'desktop-mac'];

/** The publish step: electron-builder invoked with a publish flag. */
const PUBLISH_STEP = /electron-builder\b[^\n]*--publish/;

/** The backstop step: whatever invokes the verifier. */
const VERIFY_STEP = /verify-published-assets/;

/** The verifier's path, as the workflow spells it, so a move is caught here. */
const VERIFY_SCRIPT = /(\S*verify-published-assets\.ts)/;

type Step = { run?: string; uses?: string; 'continue-on-error'?: boolean | string };
type Job = { steps?: Step[] };

/**
 * Where the publish and verify steps sit in one job's step list.
 *
 * Exported for the unit test: the interesting cases (no verify step, verify
 * before publish, verify neutered) are all orderings that are a nuisance to
 * stage as real workflow files.
 */
export function auditJob(name: string, steps: Step[]): string[] {
  const errors: string[] = [];
  const publishAt = steps.findIndex((s) => PUBLISH_STEP.test(s.run ?? ''));
  const verifyAt = steps.findIndex((s) => VERIFY_STEP.test(s.run ?? ''));

  if (publishAt === -1) {
    errors.push(
      `${WORKFLOW}: job \`${name}\` no longer runs \`electron-builder --publish\`. If desktop ` +
        `packaging moved or was dropped, update PACKAGING_JOBS in this gate deliberately.`,
    );
    return errors;
  }

  if (verifyAt === -1) {
    errors.push(
      `${WORKFLOW}: job \`${name}\` publishes with electron-builder but never verifies the ` +
        `artifacts landed. The publisher exits 0 when it skips every upload (#1261) — add a step ` +
        `running packages/desktop/scripts/verify-published-assets.ts after the publish step.`,
    );
    return errors;
  }

  if (verifyAt < publishAt) {
    errors.push(
      `${WORKFLOW}: job \`${name}\` verifies published artifacts at step ${verifyAt + 1}, BEFORE ` +
        `it publishes at step ${publishAt + 1}. Checking before the upload asserts nothing.`,
    );
  }

  const step = steps[verifyAt]!;
  if (step['continue-on-error'] === true || step['continue-on-error'] === 'true') {
    errors.push(
      `${WORKFLOW}: job \`${name}\`'s verify step is \`continue-on-error\`, which restores the ` +
        `green-with-nothing-published failure this check exists to prevent.`,
    );
  }

  const scriptPath = VERIFY_SCRIPT.exec(step.run ?? '')?.[1];
  if (!scriptPath) {
    errors.push(`${WORKFLOW}: job \`${name}\`'s verify step names no verify-published-assets.ts.`);
  } else if (!existsSync(resolve(ROOT, scriptPath))) {
    errors.push(
      `${WORKFLOW}: job \`${name}\` runs \`${scriptPath}\`, which does not exist. The step would ` +
        `fail the job on every release rather than check it.`,
    );
  }

  return errors;
}

function main(): void {
  const workflow = parse(readFileSync(resolve(ROOT, WORKFLOW), 'utf8')) as {
    jobs?: Record<string, Job>;
  };
  const jobs = workflow.jobs ?? {};
  const errors: string[] = [];

  for (const name of PACKAGING_JOBS) {
    const job = jobs[name];
    if (!job) {
      errors.push(
        `${WORKFLOW}: job \`${name}\` is gone. This gate checked it for publishing silence; ` +
          `removing it from PACKAGING_JOBS has to be a decision, not a rename.`,
      );
      continue;
    }
    errors.push(...auditJob(name, job.steps ?? []));
  }

  console.log(`Checked ${PACKAGING_JOBS.length} desktop packaging job(s) in ${WORKFLOW}.`);

  if (errors.length > 0) {
    console.error(`\n❌ ${errors.length} problem(s):\n`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('✅ Every desktop packaging job verifies its artifacts reached the Release.');
}

if (import.meta.main) main();
