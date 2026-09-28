import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * The `edge` job seeds `nicotind-analysis:edge` from the last release's image
 * when packages/analysis has not changed (docs/releasing.md "Edge and
 * releases"). "The last release" must be one whose image exists: v0.8.104's
 * tag was pushed but its Build & Deploy run never started, so the newest tag
 * had no image, the retag failed, and the first edge commit never reached the
 * host.
 *
 * Parsed, not grepped, so a comment cannot satisfy it.
 */
type Step = { name?: string; id?: string; run?: string };
const ci = parse(readFileSync(join(import.meta.dir, '..', '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, { steps?: Step[] }>;
};

describe('edge seeds the analysis image from a release that has one', () => {
  const run = (ci.jobs.edge?.steps ?? []).find((s) => s.id === 'analysis')?.run ?? '';

  it('probes the registry for each candidate tag, rather than trusting the newest tag', () => {
    expect(run).not.toContain('git describe');
    expect(run).toMatch(/for t in \$\(git tag --merged HEAD/);
    expect(run).toContain('imagetools inspect "$ANALYSIS:$t"');
  });

  it('fails loudly when no candidate has an image, instead of seeding from nothing', () => {
    expect(run).toMatch(/if \[ -z "\$prev" \]; then[\s\S]*exit 1/);
  });

  it('diffs against the same release it retags from', () => {
    const pick = run.indexOf('prev="$t"');
    const diff = run.indexOf('git diff --name-only "$prev"..HEAD');
    expect(pick).toBeGreaterThan(-1);
    expect(diff).toBeGreaterThan(pick);
  });
});
