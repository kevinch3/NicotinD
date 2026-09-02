import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GATE_JOBS,
  commandsIn,
  gateJobsNotBlockingRelease,
  invocationKey,
  isCovered,
  jobSteps,
  missingChecks,
  releaseJobsNotGated,
  verifyChain,
  verifyInvocations,
} from './check-ci-parity.js';

const ROOT = resolve(import.meta.dir, '..');

const WORKFLOW = `
name: CI
jobs:
  ci:
    steps:
      - name: Install dependencies
        run: bun install
      - name: Typecheck
        run: bun run typecheck
      - name: Typecheck (web specs)
        run: bun run --filter @nicotind/web typecheck:spec
      - name: Test
        run: bun test packages/api/src scripts
      - uses: actions/checkout@v4
  web-test:
    steps:
      - name: Test (web)
        run: bun run --filter @nicotind/web test
  storybook:
    steps:
      - name: Storybook gates (render smoke + axe)
        run: bun run gates:storybook
  e2e:
    steps:
      - name: Run e2e
        run: bun run --filter @nicotind/e2e test
  analysis:
    steps:
      - name: Python tests
        run: pytest -q
  separator:
    steps:
      - name: Python tests
        run: pytest -q
  docker:
    steps:
      - name: Build image
        run: docker build .
  desktop-package:
    steps:
      - name: Stage desktop resources
        run: bun run --filter @nicotind/desktop prepare-resources
  release:
    needs: [ci, web-test, storybook, e2e, analysis, separator, docker, desktop-package]
    steps:
      - name: Release
        run: bun run release
`;

const SCRIPTS = {
  typecheck: 'tsc --build && bun run --filter @nicotind/web typecheck:spec',
  test: 'bun test packages src scripts',
  'test:web': 'bun run --filter @nicotind/web test',
  'gates:storybook': 'bun run --filter @nicotind/e2e gates:storybook',
  verify: 'bun run typecheck && bun run test && bun run test:web && bun run gates:storybook',
};

describe('jobSteps', () => {
  it('returns only the named job’s run steps', () => {
    const steps = jobSteps(WORKFLOW, 'ci');
    expect(steps.map((s) => s.name)).toEqual([
      'Install dependencies',
      'Typecheck',
      'Typecheck (web specs)',
      'Test',
    ]);
  });

  it('ignores steps with no `run` (uses: actions)', () => {
    expect(jobSteps(WORKFLOW, 'ci').every((s) => typeof s.run === 'string')).toBe(true);
  });

  it('throws rather than silently passing when the job was renamed', () => {
    // A silent pass here would disable the whole gate, which is the one
    // outcome worse than a false positive.
    expect(() => jobSteps(WORKFLOW, 'nope')).toThrow(/no `nope` job/);
  });
});

describe('verifyChain', () => {
  it('expands one level, so an indirectly-reached script counts as covered', () => {
    // `verify` never names typecheck:spec; `typecheck` does.
    expect(verifyChain(SCRIPTS)).toContain('typecheck:spec');
  });

  it('throws when there is no verify script to compare against', () => {
    expect(() => verifyChain({ test: 'x' })).toThrow(/no `verify` script/);
  });
});

describe('commandsIn', () => {
  it('keeps bun/bunx lines and drops comments and blanks', () => {
    expect(commandsIn('# a comment\n\nbun run lint\necho hi\nbunx playwright install')).toEqual([
      'bun run lint',
      'bunx playwright install',
    ]);
  });
});

describe('isCovered', () => {
  it('matches a script by name regardless of --filter', () => {
    expect(isCovered('bun run --filter @nicotind/web typecheck:spec', 'typecheck:spec')).toBe(true);
  });

  it('does not treat a prefix as the whole script name', () => {
    // `typecheck` in the chain must not satisfy `typecheck:spec`.
    expect(isCovered('bun run --filter @nicotind/web typecheck:spec', 'bun run typecheck')).toBe(
      false,
    );
  });

  it('treats CI’s explicit test paths as covered by the glob-based script', () => {
    // Deliberately loose: CI enumerates the paths the root `test` script covers
    // with a glob, so comparing path sets would fail for reasons that aren't bugs.
    // The chain is what `verifyChain` builds — verify plus the referenced bodies.
    expect(isCovered('bun test packages/api/src scripts', verifyChain(SCRIPTS))).toBe(true);
  });
});

describe('exact invocation matching', () => {
  it('distinguishes a workspace script from the root script of the same name', () => {
    // The bug: `isCovered` pulled out the bare name `test` and asked
    // `chain.includes('test')`, so the ROOT test script vouched for a different
    // package's. Two unrelated commands, one of which never ran locally.
    expect(invocationKey('bun run test')).toBe(':test');
    expect(invocationKey('bun run --filter @nicotind/e2e test')).toBe('@nicotind/e2e:test');
    expect(invocationKey('bun run --filter @nicotind/web build')).toBe('@nicotind/web:build');
  });

  it('follows root scripts transitively but records --filter calls as themselves', () => {
    const reach = verifyInvocations(SCRIPTS);
    expect(reach.has(':typecheck')).toBe(true);
    expect(reach.has('@nicotind/web:typecheck:spec')).toBe(true); // via `typecheck`
    expect(reach.has('@nicotind/e2e:test')).toBe(false); // verify never reaches it
  });

  it('no longer lets the root `test` script cover `@nicotind/e2e test`', () => {
    const reach = verifyInvocations(SCRIPTS);
    expect(isCovered('bun run --filter @nicotind/e2e test', verifyChain(SCRIPTS), reach)).toBe(
      false,
    );
  });

  it('fails a raw command that is merely a PREFIX of a verify command', () => {
    // The silent direction: CI shorter than verify used to pass via substring,
    // so `bun audit` would be "covered" by `bun audit --audit-level=high`.
    const chain = 'bun audit --audit-level=high';
    expect(isCovered('bun audit', chain, new Set())).toBe(false);
    expect(isCovered('bun audit --audit-level=high', chain, new Set())).toBe(true);
  });
});

describe('missingChecks', () => {
  it('passes when verify reaches everything', () => {
    expect(missingChecks(WORKFLOW, SCRIPTS)).toEqual([]);
  });

  /** The exact regression this gate exists for. */
  it('catches a CI step that no local command reaches', () => {
    const withoutSpecCheck = { ...SCRIPTS, typecheck: 'tsc --build' };
    expect(missingChecks(WORKFLOW, withoutSpecCheck)).toEqual([
      {
        job: 'ci',
        step: 'Typecheck (web specs)',
        command: 'bun run --filter @nicotind/web typecheck:spec',
      },
    ]);
  });

  it('ignores allowlisted setup steps', () => {
    expect(missingChecks(WORKFLOW, SCRIPTS).some((m) => m.command.includes('bun install'))).toBe(
      false,
    );
  });

  it('guards gate jobs beyond `ci` — a gate that moved jobs stays covered', () => {
    // Before the `ci` split this returned [] no matter what the other jobs ran.
    // (`web-test` cannot be demonstrated the same way: its `--filter @nicotind/web test`
    // resolves to the root `test` script under the deliberately coarse matcher, so it is
    // covered by `verify` through that name alone.)
    const withoutGates = {
      ...SCRIPTS,
      verify: 'bun run typecheck && bun run test && bun run test:web',
    };
    const missed = GATE_JOBS.flatMap((job) => missingChecks(WORKFLOW, withoutGates, job));
    expect(missed).toEqual([
      {
        job: 'storybook',
        step: 'Storybook gates (render smoke + axe)',
        command: 'bun run gates:storybook',
      },
    ]);
  });

  it('gates `e2e` as a job but allowlists its one command, not the whole job', () => {
    // `bun run e2e` stays out of `verify` (quality gate 2) — but as a named
    // command with a reason, so anything ELSE added to that job is enforced.
    expect(GATE_JOBS).toContain('e2e');
    const missed = GATE_JOBS.flatMap((job) => missingChecks(WORKFLOW, SCRIPTS, job));
    expect(missed.some((m) => m.command.includes('@nicotind/e2e test'))).toBe(false);
  });

  it('catches a NEW command added to a job that used to be excluded wholesale', () => {
    // The point of gating the job rather than skipping it: `prepare-resources` is
    // allowlisted, a second command in the same job is not.
    const withExtra = WORKFLOW.replace(
      '        run: bun run --filter @nicotind/desktop prepare-resources',
      [
        '        run: bun run --filter @nicotind/desktop prepare-resources',
        '      - name: Sneaky',
        '        run: bun run some:new-check',
      ].join('\n'),
    );
    const missed = missingChecks(withExtra, SCRIPTS, 'desktop-package');
    expect(missed.map((m) => m.command)).toEqual(['bun run some:new-check']);
  });
});

describe('releaseJobsNotGated', () => {
  it('passes when every release-gating job is a gate job', () => {
    expect(releaseJobsNotGated(WORKFLOW)).toEqual([]);
  });

  /**
   * The real defect: `desktop-package` was in `release.needs`, ran a command
   * `verify` never runs, and was not a gate job — while the note explaining the
   * exclusions reasoned about `desktop-smoke`, a different, non-gating job.
   */
  it('names a job that gates the release but nothing checks', () => {
    const added = WORKFLOW.replace(
      'needs: [ci, web-test, storybook, e2e, analysis, separator, docker, desktop-package]',
      'needs: [ci, web-test, storybook, e2e, analysis, separator, docker, desktop-package, smuggled]',
    );
    expect(releaseJobsNotGated(added)).toEqual(['smuggled']);
  });
});

describe('gateJobsNotBlockingRelease', () => {
  it('passes when every gate job is in `release`s needs', () => {
    expect(gateJobsNotBlockingRelease(WORKFLOW)).toEqual([]);
  });

  /**
   * The regression this half exists for: splitting a gate out of `ci` and forgetting the
   * `needs` line leaves it advisory — it can fail while the release tag is still cut.
   */
  it('names the gate jobs a release would not wait for', () => {
    const dropped = WORKFLOW.replace(
      'needs: [ci, web-test, storybook, e2e, analysis, separator, docker, desktop-package]',
      'needs: [ci, e2e, analysis, separator, docker, desktop-package]',
    );
    expect(gateJobsNotBlockingRelease(dropped)).toEqual(['web-test', 'storybook']);
  });

  it('throws rather than silently passing when the release job was renamed', () => {
    expect(() => gateJobsNotBlockingRelease('jobs:\n  ci:\n    steps: []\n')).toThrow(
      /no `release` job/,
    );
  });
});

describe('the real repository', () => {
  it('has a verify chain covering every check the gate jobs run', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const { scripts } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(GATE_JOBS.flatMap((job) => missingChecks(workflow, scripts, job))).toEqual([]);
  });

  it('blocks the release on every gate job', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(gateJobsNotBlockingRelease(workflow)).toEqual([]);
  });
});
