import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const isTrivy = (s: ScanStep) => s.uses?.startsWith('aquasecurity/trivy-action') ?? false;
/** The one Trivy step that only decides on a rebuild, and so may not fail the job. */
const REUSED_SCAN_ID = 'analysis-reused-scan';
const isScan = (s: ScanStep) => isTrivy(s) && s.id !== REUSED_SCAN_ID;
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

/**
 * A reused image cannot pick up a fix published after its release, so a CVE fixed
 * since then used to block every edge deploy until someone changed
 * packages/analysis or cut a release (#1477).
 */
describe('a reused analysis image with a newly fixable CVE is rebuilt, not a blocker', () => {
  const s = steps('edge');
  const reused = s.find((x) => x.id === REUSED_SCAN_ID)!;
  const stale = s.find((x) => x.id === 'analysis-stale')!;
  const build = s.find((x) => x.id === 'analysis-build') as ScanStep & { if?: string };
  const strict = s.find(isScan)!;
  const release = (deploy.jobs['docker-merge']?.steps ?? []).find(isScan)!;

  it('looks for the same findings as the strict scan, on the image it would reuse', () => {
    for (const key of ['vuln-type', 'ignore-unfixed', 'severity']) {
      expect(reused.with?.[key]).toEqual(release.with?.[key]);
    }
    expect(reused.uses).toBe(release.uses!);
    expect(reused.with?.['image-ref']).toBe(
      '${{ env.ANALYSIS }}:${{ steps.analysis.outputs.prev }}',
    );
  });

  it('runs before the build it decides on, and the build honours it', () => {
    expect(s.indexOf(reused)).toBeLessThan(s.indexOf(stale));
    expect(s.indexOf(stale)).toBeLessThan(s.indexOf(build));
    expect(build.if).toContain("steps.analysis.outputs.build == 'true'");
    expect(build.if).toContain("steps.analysis-stale.outputs.rebuild == 'true'");
  });

  it('leaves the strict scan as what decides, after any rebuild', () => {
    expect(s.indexOf(build)).toBeLessThan(s.indexOf(strict));
    expect(strict.with?.['exit-code']).toBe(1);
    expect((strict as ScanStep & { if?: string }).if).toBeUndefined();
  });

  const decide = (report: string): { code: number; output: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-stale-'));
    try {
      writeFileSync(join(dir, 'analysis-reused-scan.json'), report);
      const output = join(dir, 'out');
      writeFileSync(output, '');
      const r = Bun.spawnSync(['bash', '-c', stale.run!], {
        cwd: dir,
        env: {
          PATH: process.env.PATH!,
          GITHUB_OUTPUT: output,
          ANALYSIS: 'img',
          PREV: 'v1',
        },
      });
      return { code: r.exitCode, output: readFileSync(output, 'utf8').trim() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('rebuilds on a finding', () => {
    const report = {
      Results: [
        { Vulnerabilities: [{ VulnerabilityID: 'CVE-1' }, { VulnerabilityID: 'CVE-1' }] },
        { Target: 'clean' },
      ],
    };
    expect(decide(JSON.stringify(report))).toEqual({ code: 0, output: 'rebuild=true' });
  });

  it('does not rebuild a clean image, including a report with no Results key', () => {
    expect(decide('{"Results":[{"Target":"x"}]}').output).toBe('rebuild=false');
    expect(decide('{}').output).toBe('rebuild=false');
  });

  it('fails on an unreadable report rather than reading it as clean', () => {
    expect(decide('not json').code).not.toBe(0);
  });
});
