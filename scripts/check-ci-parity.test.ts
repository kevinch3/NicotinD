import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GATE_JOBS,
  commandsIn,
  gateJobsNotBlockingRelease,
  isCovered,
  jobSteps,
  missingChecks,
  verifyChain,
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
  release:
    needs: [ci, web-test, storybook, e2e]
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
    expect(isCovered('bun test packages/api/src scripts', 'bun run test')).toBe(true);
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

  it('leaves `e2e` alone — `bun run e2e` is deliberately not in `verify`', () => {
    expect(GATE_JOBS).not.toContain('e2e');
    const missed = GATE_JOBS.flatMap((job) => missingChecks(WORKFLOW, SCRIPTS, job));
    expect(missed.some((m) => m.command.includes('@nicotind/e2e test'))).toBe(false);
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
    const dropped = WORKFLOW.replace('needs: [ci, web-test, storybook, e2e]', 'needs: [ci, e2e]');
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
