import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * `release.yml` releases only a tip whose `edge` run succeeded, so a failed
 * edge dispatch holds every release until the next green merge. A manual run
 * may `force` past that one check; a scheduled run never can, and a forced
 * release says so in the job summary (#1461, docs/releasing.md "Forcing a
 * release").
 *
 * Parsed, not grepped, so a comment cannot satisfy it.
 */
type Step = { name?: string; run?: string; env?: Record<string, string> };
const release = parse(
  readFileSync(join(import.meta.dir, '..', '.github/workflows/release.yml'), 'utf8'),
) as {
  on: {
    schedule?: unknown;
    workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> };
  };
  jobs: Record<string, { steps?: Step[] }>;
};
const step = (release.jobs.release?.steps ?? []).find((s) => s.run?.includes('check_name=edge'))!;

describe('a manual release can be forced past the edge check (#1461)', () => {
  it('is a manual input that defaults to off', () => {
    expect(release.on.workflow_dispatch?.inputs?.force).toEqual(
      expect.objectContaining({ type: 'boolean', default: false }),
    );
  });

  it('is honoured only on workflow_dispatch, never on the schedule', () => {
    expect(step.env?.FORCE).toMatch(/github\.event_name == 'workflow_dispatch' && inputs\.force/);
  });

  it('skips only the edge check, and writes the override to the job summary', () => {
    const run = step.run!;
    const forced = run.indexOf('[ "$green" = "0" ] && [ "$FORCE" = "true" ]');
    const held = run.indexOf('elif [ "$green" = "0" ]');
    expect(forced).toBeGreaterThan(-1);
    expect(held).toBeGreaterThan(forced);
    const forcedBranch = run.slice(forced, held);
    expect(forcedBranch).toContain('GITHUB_STEP_SUMMARY');
    expect(forcedBranch).not.toContain('exit');
    // Unforced, a tip without a green edge is still not released.
    expect(run.slice(held, run.indexOf('fi', held))).toContain('exit 0');
    // The rest of the path is untouched: release-needed still gates first.
    expect(run.indexOf('scripts/release-needed.ts')).toBeLessThan(forced);
  });
});
