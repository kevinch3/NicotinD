import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * `deploy.yml` grouped on `github.sha`, which keys by *commit* — two releases
 * are two commits, therefore two groups, therefore no mutual exclusion at all.
 * It only ever deduped re-runs of a single commit. Two releases cut close
 * together (what happens when several PRs land in one sitting) reached the
 * host's `docker compose up -d` concurrently, and both also raced the shared
 * mutable `:release` / `:vX` manifest tags in docker-merge. Issue #768.
 *
 * Parsed, not grepped: a regex over the raw file would pass on a `group:` that
 * appears in a comment, which is exactly the "predicate answering an easier
 * question" shape this repo keeps filing bugs about.
 */
const repoRoot = join(import.meta.dir, '..');
const deploy = parse(readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8')) as {
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, { concurrency?: unknown }>;
};

describe('the deploy lane serializes across releases (issue #768)', () => {
  it('groups on a constant, not on anything that varies per run', () => {
    const group = deploy.concurrency?.group;
    expect(group).toBeString();
    // `github.sha`, `github.ref`, `github.ref_name` and `github.run_id` all
    // differ between two releases, so any of them re-opens the race.
    expect(group).not.toContain('${{');
  });

  it('queues behind a running deploy rather than cancelling it', () => {
    // Abandoning a deploy mid-`up -d` leaves the host half-applied, which is
    // strictly worse than waiting for it.
    expect(deploy.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('serializes the whole workflow, so releases cannot deploy out of order', () => {
    // Serializing only the `deploy` job would let a later tag finish building
    // first, deploy, and then be overwritten by an earlier one still in flight
    // — a downgrade that looks like a green release.
    expect(deploy.concurrency).toBeDefined();
    for (const [name, job] of Object.entries(deploy.jobs)) {
      expect(job.concurrency, `job ${name} must not carry its own group`).toBeUndefined();
    }
  });
});
