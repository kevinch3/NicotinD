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

/**
 * `:edge` is what the host runs, so it gets the release scan (deploy.yml
 * `docker-merge`) before anything points at it: each arch's pushed digest in
 * `edge-image`, the analysis image in `edge`, both before a tag moves and
 * before the host deploy is dispatched (#1461).
 */
type ScanStep = Step & { uses?: string; with?: Record<string, unknown> };
const deploy = parse(
  readFileSync(join(import.meta.dir, '..', '.github/workflows/deploy.yml'), 'utf8'),
) as { jobs: Record<string, { steps?: ScanStep[] }> };
const isScan = (s: ScanStep) => s.uses?.startsWith('aquasecurity/trivy-action') ?? false;
const steps = (job: string) => (ci.jobs[job]?.steps ?? []) as ScanStep[];

describe('edge images are scanned before they ship (#1461)', () => {
  const release = (deploy.jobs['docker-merge']?.steps ?? []).find(isScan)!;
  const policy = ({ uses, with: w }: ScanStep) => ({
    uses,
    with: { ...w, 'image-ref': undefined },
  });

  it('uses the release scan: same pin, same severity, same ignore-unfixed', () => {
    expect(release).toBeDefined();
    const scans = [...steps('edge-image'), ...steps('edge')].filter(isScan);
    expect(scans).toHaveLength(2);
    for (const scan of scans) expect(policy(scan)).toEqual(policy(release));
  });

  it('scans each arch digest in edge-image, before the digest is handed on', () => {
    const s = steps('edge-image');
    const scan = s.findIndex(isScan);
    expect(String(s[scan]?.with?.['image-ref'])).toContain('steps.build.outputs.digest');
    expect(scan).toBeLessThan(s.findIndex((x) => x.name === 'Export digest'));
  });

  it('scans the analysis image before either edge tag moves or the host deploy is dispatched', () => {
    const s = steps('edge');
    const scan = s.findIndex(isScan);
    expect(s[scan]?.with?.['image-ref']).toBe('${{ steps.analysis-ref.outputs.ref }}');
    const later = s.slice(scan + 1).map((x) => x.run ?? '');
    const before = s
      .slice(0, scan)
      .map((x) => x.run ?? '')
      .join('\n');
    expect(before).not.toContain(':edge"');
    expect(later.some((r) => r.includes('-t "$IMAGE:edge"'))).toBe(true);
    expect(later.some((r) => r.includes('-t "$ANALYSIS:edge"'))).toBe(true);
    expect(later.some((r) => r.includes('gh workflow run deploy-host.yml'))).toBe(true);
    // The rebuilt analysis image is pushed untagged; only the retag names `edge`.
    const build = s.find((x) => x.id === 'analysis-build') as ScanStep | undefined;
    expect(JSON.stringify(build?.with)).not.toContain(':edge');
  });
});
