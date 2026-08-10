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
];

export interface WorkflowStep {
  name?: string;
  run?: string;
}

export interface MissingCheck {
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
export function isCovered(command: string, chain: string): boolean {
  const scriptCall = command.match(/bun run (?:--filter \S+ )?([\w:.-]+)/);
  if (scriptCall) return chain.includes(scriptCall[1] ?? '\0');
  if (command.startsWith('bun test')) return chain.includes('test');
  return chain.includes(command);
}

/** Every `ci`-job command the verify chain fails to reach. */
export function missingChecks(
  workflowYaml: string,
  scripts: Record<string, string>,
  job = 'ci',
): MissingCheck[] {
  const chain = verifyChain(scripts);
  const missing: MissingCheck[] = [];
  for (const step of jobSteps(workflowYaml, job)) {
    for (const command of commandsIn(step.run ?? '')) {
      if (ALLOWLIST.some((a) => command.includes(a.match))) continue;
      if (!isCovered(command, chain)) {
        missing.push({ step: step.name ?? '(unnamed step)', command });
      }
    }
  }
  return missing;
}

if (import.meta.main) {
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const { scripts } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  const missing = missingChecks(workflow, scripts);
  if (missing.length > 0) {
    console.error(
      `\nThe \`ci\` job runs ${missing.length} check(s) that \`bun run verify\` does not:\n`,
    );
    for (const m of missing) console.error(`  ✗ ${m.step}\n      ${m.command}`);
    console.error(
      `\nA check CI runs but no local command does is invisible until push — that is how\n` +
        `the web-spec typecheck drifted (see the header of scripts/check-ci-parity.ts).\n` +
        `Add it to the \`verify\` script in package.json, or to ALLOWLIST with a reason.\n`,
    );
    process.exit(1);
  }

  console.log('CI parity: every `ci` job check is reachable from `bun run verify`.');
}
