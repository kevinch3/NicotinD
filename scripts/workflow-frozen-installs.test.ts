import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Every workflow `bun install` is `--frozen-lockfile`. A plain install re-resolves
 * any `^` range that drifted from bun.lock, so a freshly published (or hijacked)
 * version would reach CI and the signing jobs unreviewed.
 */
const dir = join(import.meta.dir, '..', '.github', 'workflows');

const runs = readdirSync(dir)
  .filter((f) => f.endsWith('.yml'))
  .flatMap((file) => {
    const doc = parse(readFileSync(join(dir, file), 'utf8')) as {
      jobs?: Record<string, { steps?: { run?: string }[] }>;
    };
    return Object.entries(doc.jobs ?? {}).flatMap(([job, { steps = [] }]) =>
      steps.filter((s) => s.run).map((s) => ({ where: `${file}:${job}`, run: s.run as string })),
    );
  });

describe('workflow installs', () => {
  it('finds the installs it is meant to police', () => {
    expect(runs.filter((r) => /\bbun install\b/.test(r.run)).length).toBeGreaterThan(10);
  });

  it('never runs an unfrozen bun install', () => {
    const offenders = runs.filter((r) =>
      r.run
        .split('\n')
        .some(
          (l) =>
            /\bbun install\b/.test(l) &&
            !l.trim().startsWith('#') &&
            !l.includes('--frozen-lockfile') &&
            !l.includes('::'),
        ),
    );
    expect(offenders.map((o) => o.where)).toEqual([]);
  });
});
