import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Two properties every workflow keeps (docs/quality-gates.md "Least-privilege
 * tokens and bounded jobs"):
 *
 * - A workflow-level `permissions:` block granting no write. Without one, a job
 *   that declares nothing inherits the repository's default token, which may be
 *   read-write; a job that needs more says so itself, and its block replaces
 *   the default rather than adding to it.
 * - A `timeout-minutes` on every job. The default is 360: a hung SSH, a stuck
 *   emulator or a runaway build holds a runner — and, for deploy.yml, the
 *   single `deploy-host` concurrency slot — for six hours.
 *
 * Parsed, not grepped, so a comment cannot satisfy it; every file in
 * .github/workflows is covered, so a new workflow is held to it too.
 */
type Job = { 'timeout-minutes'?: number; uses?: string };
type Workflow = { permissions?: Record<string, string> | string; jobs: Record<string, Job> };

const dir = join(import.meta.dir, '..', '.github', 'workflows');
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => ({ file: f, wf: parse(readFileSync(join(dir, f), 'utf8')) as Workflow }));

describe('workflow hygiene', () => {
  it('covers every workflow file', () => {
    expect(workflows.map((w) => w.file)).toEqual(
      expect.arrayContaining(['ci.yml', 'deploy.yml', 'pages.yml', 'pr-title.yml']),
    );
  });

  for (const { file, wf } of workflows) {
    it(`${file} defaults the token to read-only`, () => {
      expect(typeof wf.permissions).toBe('object');
      const grants = Object.values(wf.permissions as Record<string, string>);
      expect(grants.length).toBeGreaterThan(0);
      expect(grants.every((g) => g === 'read' || g === 'none')).toBe(true);
    });

    it(`${file} bounds every job with timeout-minutes`, () => {
      for (const [name, job] of Object.entries(wf.jobs)) {
        // A job that calls a reusable workflow cannot carry timeout-minutes;
        // the called workflow's own jobs are bounded, and checked here too.
        if (job.uses) continue;
        const t = job['timeout-minutes'];
        expect({ job: name, bounded: typeof t === 'number' && t > 0 && t < 360 }).toEqual({
          job: name,
          bounded: true,
        });
      }
    });
  }
});
