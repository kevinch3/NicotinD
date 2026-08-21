/**
 * Fail when the `ci` job runs a check that `bun run verify` does not.
 *
 *   bun run check:ci-parity
 *
 * WHY: `bun run typecheck` covered `tsc --build`, the e2e specs and the Angular
 * templates — but not the **web specs**, which `tsconfig.app.json` excludes and
 * vitest transpiles without type-checking. CI ran that surface as its own step;
 * no local command did. So a spec stub could drift from the type it asserts
 * against, every local gate stayed green, and the failure only appeared after a
 * push.
 *
 * That is a *class* of bug, not one script: any step added to the `ci` job is
 * silently local-unreachable until someone happens to read the workflow. Issues
 * #273 and #376 each fixed one instance by hand (templates, then e2e specs) and
 * a third instance still shipped. This gate is what stops the fourth.
 *
 * The check is deliberately coarse — it asserts each `ci`-job command is
 * *reachable* from the verify chain, not that the two run identically. Exact
 * matching would be brittle (CI enumerates test paths that the root `test`
 * script covers with a glob) and would fail for reasons that are not bugs. What
 * matters is that a human running one command reaches every gate.
 *
 * ALLOWLIST is for steps that genuinely cannot or should not run locally.
 * Adding to it is a decision, not a shortcut: every entry carries a reason, the
 * same discipline as check-claude-md.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dir, '..');

/** Commands the `ci` job runs that `verify` deliberately does not. */
export const ALLOWLIST: Array<{ match: string; reason: string }> = [
  { match: 'bun install', reason: 'environment setup, not a check' },
  { match: 'actionlint', reason: 'lints the workflow files themselves; needs the CI runner' },
  {
    match: 'install:browsers',
    reason:
      'environment setup for the Storybook smoke step, not a check; local runs already have the browser',
  },
  {
    match: '--filter @nicotind/desktop prepare-resources',
    reason:
      'stages a production `bun install` plus platform binaries into the Electron resource tree; minutes long and only meaningful on a packaging runner. The packaged artifact it produces is what `desktop-smoke` then exercises.',
  },
  {
    match: '--filter @nicotind/e2e test',
    reason:
      "CLAUDE.md quality gate 2 keeps `bun run e2e` out of `verify` on purpose — it is its own CI job and takes minutes. Until now this was covered by accident: `isCovered` matched the bare script name `test`, so the ROOT `test` script vouched for a different package's.",
  },
];

/**
 * The jobs whose checks a developer is expected to reach with `bun run verify`.
 *
 * This was a single hardcoded `'ci'` until that job was split — it had grown into the
 * workflow's entire critical path by accumulating the web unit tests and the Storybook
 * catalog gates. Splitting it moved gates into new jobs, and a list is what keeps them
 * covered: a gate that quietly leaves this list is exactly the drift this file exists to
 * catch, only with a job boundary hiding it.
 *
 * It is now **every job in `release.needs`**, enforced both ways (see
 * `releaseJobsNotGated` and `gateJobsNotBlockingRelease`). Excluding whole jobs was the
 * bug: the previous list left out `e2e`, `analysis`, `docker` and `desktop-package`, and
 * the note explaining that named `desktop-smoke` — a DIFFERENT job, `continue-on-error`,
 * which gates nothing — while `desktop-package`, which does gate the release, went
 * unmentioned and ran `prepare-resources` that `verify` never runs.
 *
 * Exclusions are now per-COMMAND, in ALLOWLIST with a reason, so the unit of the decision
 * is the thing that can't run locally rather than the job that happens to contain it.
 * `analysis` and `docker` add nothing to check either way: neither runs a `bun` command.
 */
export const GATE_JOBS = [
  'ci',
  'web-test',
  'storybook',
  'e2e',
  'analysis',
  'docker',
  'desktop-package',
] as const;

/**
 * The job that cuts the release tag. Every gate job must block it, or splitting a gate
 * out silently stops it gating the release — the #457 shape, where a job that did not
 * actually pass still let a deploy through.
 */
export const RELEASE_JOB = 'release';

export interface WorkflowStep {
  name?: string;
  run?: string;
}

export interface MissingCheck {
  job: string;
  step: string;
  command: string;
}

/** The `run:` steps of a named job in a parsed workflow document. */
export function jobSteps(workflowYaml: string, job: string): WorkflowStep[] {
  const workflow = parse(workflowYaml) as { jobs?: Record<string, { steps?: WorkflowStep[] }> };
  const found = workflow.jobs?.[job];
  if (!found) throw new Error(`no \`${job}\` job in the workflow — has it been renamed?`);
  return (found.steps ?? []).filter((s) => typeof s.run === 'string');
}

/**
 * Expand `verify` one level into the bodies of the scripts it calls, so a step
 * reached indirectly (`typecheck` → `typecheck:spec`) counts as covered.
 */
export function verifyChain(scripts: Record<string, string>): string {
  const verify = scripts['verify'];
  if (!verify) throw new Error('package.json has no `verify` script.');
  const referenced = [...verify.matchAll(/bun run ([\w:.-]+)/g)].map((m) => m[1] ?? '');
  return [verify, ...referenced.map((n) => scripts[n] ?? '')].join('\n');
}

/** Reduce a `run:` block to the distinctive command lines worth matching. */
export function commandsIn(run: string): string[] {
  return run
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .filter((l) => l.startsWith('bun ') || l.startsWith('bunx '));
}

/**
 * `bun test <explicit paths>` in CI and the root `test` script's glob are the
 * same gate expressed differently, so match on the runner rather than the
 * literal argument list.
 */
/**
 * Identity of a `bun run` invocation: `<workspace>:<script>`, so the root `test`
 * script and `--filter @nicotind/e2e test` are different things.
 *
 * They were not. The old matcher pulled out the bare script name and asked
 * `chain.includes(name)`, which is a SUBSTRING test on the whole verify chain —
 * so the root `test` script vouched for `@nicotind/e2e test`, and any CI command
 * that happened to be a substring of a verify command passed. The failure is
 * one-directional and the silent direction is the dangerous one: a CI command
 * *shorter* than its verify counterpart passes green while the two have drifted.
 */
export function invocationKey(command: string): string | null {
  const m = command.match(/^bun run (?:--filter (\S+) )?([\w:.-]+)/);
  if (!m) return null;
  return `${m[1] ?? ''}:${m[2]}`;
}

/** Every `bun run` invocation `verify` reaches, transitively through scripts. */
export function verifyInvocations(scripts: Record<string, string>): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<string>();
  // Scan the whole body, not line by line: `verify` is a single `&&`-joined
  // string, so splitting on newlines yields one "command" and only its first
  // invocation would be seen.
  const walk = (body: string): void => {
    for (const m of body.matchAll(/bun run (?:--filter (\S+) )?([\w:.-]+)/g)) {
      const filter = m[1] ?? '';
      const name = m[2] ?? '';
      const key = `${filter}:${name}`;
      keys.add(key);
      if (seen.has(key)) continue;
      seen.add(key);
      // Only a root script has a body here; `--filter` runs a workspace script
      // whose definition lives in that package's own package.json.
      if (!filter) {
        const next = scripts[name];
        if (next) walk(next);
      }
    }
  };
  const verify = scripts['verify'];
  if (!verify) throw new Error('package.json has no `verify` script.');
  walk(verify);
  return keys;
}

export function isCovered(command: string, chain: string, invocations?: Set<string>): boolean {
  const key = invocationKey(command);
  if (key) {
    // Exact identity when we have it; fall back to the old loose check only for
    // callers that predate `invocations` (the unit tests that pass a raw chain).
    return invocations ? invocations.has(key) : chain.includes(key.split(':').pop() ?? '\0');
  }
  // `bun test <paths>` stays deliberately loose: CI enumerates the paths that the
  // root `test` script covers with a glob, so comparing path sets would fail for
  // reasons that are not bugs. This is the one place a proxy is the right answer.
  if (command.startsWith('bun test')) return chain.includes('bun test');
  // Anything else must match a verify command exactly. Substring matching here is
  // what would let a CI `bun audit` pass against a verify `bun audit --audit-level=high`.
  const norm = (c: string) => c.trim().replace(/\s+/g, ' ');
  return chain
    .split('\n')
    .flatMap((l) => l.split('&&'))
    .map(norm)
    .includes(norm(command));
}

/** Every command in `job` that the verify chain fails to reach. */
export function missingChecks(
  workflowYaml: string,
  scripts: Record<string, string>,
  job = 'ci',
): MissingCheck[] {
  const chain = verifyChain(scripts);
  const invocations = verifyInvocations(scripts);
  const missing: MissingCheck[] = [];
  for (const step of jobSteps(workflowYaml, job)) {
    for (const command of commandsIn(step.run ?? '')) {
      if (ALLOWLIST.some((a) => command.includes(a.match))) continue;
      if (!isCovered(command, chain, invocations)) {
        missing.push({ job, step: step.name ?? '(unnamed step)', command });
      }
    }
  }
  return missing;
}

/**
 * Gate jobs that `release` does not list in `needs`.
 *
 * Splitting a gate into its own job is only safe if the release waits for it too;
 * forgetting that line makes the new job advisory and nothing else complains.
 */
/**
 * The inverse of `gateJobsNotBlockingRelease`: a job that gates the release but
 * is not a gate job, so nothing checks that its commands are reachable locally.
 *
 * `desktop-package` was exactly that — in `release.needs`, running
 * `prepare-resources`, which `verify` never runs. The docstring justifying the
 * exclusions reasoned about `desktop-smoke` instead: a DIFFERENT job, marked
 * `continue-on-error`, which gates nothing. Checking both directions means
 * neither list can drift from the other.
 */
export function releaseJobsNotGated(workflowYaml: string): string[] {
  const workflow = parse(workflowYaml) as {
    jobs?: Record<string, { needs?: string[] | string }>;
  };
  const release = workflow.jobs?.[RELEASE_JOB];
  if (!release) throw new Error(`no \`${RELEASE_JOB}\` job in the workflow — has it been renamed?`);
  const raw = release.needs ?? [];
  const needs = Array.isArray(raw) ? raw : [raw];
  return needs.filter((j) => !(GATE_JOBS as readonly string[]).includes(j));
}

export function gateJobsNotBlockingRelease(workflowYaml: string): string[] {
  const workflow = parse(workflowYaml) as {
    jobs?: Record<string, { needs?: string[] | string }>;
  };
  const release = workflow.jobs?.[RELEASE_JOB];
  if (!release) throw new Error(`no \`${RELEASE_JOB}\` job in the workflow — has it been renamed?`);
  const raw = release.needs ?? [];
  const needs = new Set(Array.isArray(raw) ? raw : [raw]);
  return GATE_JOBS.filter((j) => !needs.has(j));
}

if (import.meta.main) {
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const { scripts } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  const missing = GATE_JOBS.flatMap((job) => missingChecks(workflow, scripts, job));
  if (missing.length > 0) {
    console.error(
      `\nThe gate jobs run ${missing.length} check(s) that \`bun run verify\` does not:\n`,
    );
    for (const m of missing) console.error(`  ✗ [${m.job}] ${m.step}\n      ${m.command}`);
    console.error(
      `\nA check CI runs but no local command does is invisible until push — that is how\n` +
        `the web-spec typecheck drifted (see the header of scripts/check-ci-parity.ts).\n` +
        `Add it to the \`verify\` script in package.json, or to ALLOWLIST with a reason.\n`,
    );
    process.exit(1);
  }

  const ungated = releaseJobsNotGated(workflow);
  if (ungated.length > 0) {
    console.error(
      `\n${ungated.length} job(s) gate \`${RELEASE_JOB}\` but are not gate jobs: ${ungated.join(', ')}\n\n` +
        `Nothing checks that their commands are reachable from \`bun run verify\`, so a check\n` +
        `added there is unenforced. Add them to GATE_JOBS (allowlisting any command that\n` +
        `genuinely cannot run locally), or take them out of \`${RELEASE_JOB}\`'s \`needs\`.\n`,
    );
    process.exit(1);
  }

  const unblocking = gateJobsNotBlockingRelease(workflow);
  if (unblocking.length > 0) {
    console.error(
      `\n${unblocking.length} gate job(s) do not block \`${RELEASE_JOB}\`: ${unblocking.join(', ')}\n\n` +
        `A gate that does not gate is advisory. Add it to the \`${RELEASE_JOB}\` job's \`needs\`.\n`,
    );
    process.exit(1);
  }

  console.log(
    `CI parity: every check in ${GATE_JOBS.join(', ')} is reachable from \`bun run verify\`, ` +
      `and all of them block \`${RELEASE_JOB}\`.`,
  );
}
