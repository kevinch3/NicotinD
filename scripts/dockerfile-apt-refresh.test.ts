import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #730: the production stage runs `apt-get upgrade` to pick up Debian
 * security updates, but the RUN string never changed — so buildx served the
 * layer from the `type=gha` cache on every release. v0.5.13 and v0.5.14 both
 * shipped an apt layer whose blobs dated to July, and Trivy blocked both
 * deploys on a CVE whose fix had been in the archive for days.
 *
 * The mechanism looked present and measured nothing: the same defect class the
 * "gates assert their own denominator" family is about. The fix is a build arg
 * whose value differs per run, and it only works while BOTH ends stay wired —
 * an `ARG` the workflow stops passing silently restores the bug, because the
 * Dockerfile's own default makes the build succeed. That pairing is what this
 * file asserts; the ARG cannot verify itself.
 */
const ROOT = resolve(import.meta.dir, '..');
const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');
const deployWorkflow = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');

const ARG_NAME = 'APT_REFRESH';

/**
 * The one logical `RUN` that upgrades, rejoined across its `\` continuations.
 * Matching with a loose regex instead spans from an unrelated earlier `RUN` and
 * "finds" the arg in a different instruction entirely — a green assertion about
 * the wrong line, which is the failure mode this whole file exists to prevent.
 */
function aptUpgradeRun(): string {
  const lines = dockerfile.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (current.length === 0 && !line.startsWith('RUN ')) continue;
    current.push(line);
    if (!line.trimEnd().endsWith('\\')) {
      blocks.push(current.join('\n'));
      current = [];
    }
  }
  const matches = blocks.filter((b) => b.includes('apt-get upgrade'));
  // Exactly one, or the premise ("the apt layer") is no longer singular.
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe(`${ARG_NAME} keeps the apt layer out of the build cache (#730)`, () => {
  it('declares the arg in the Dockerfile', () => {
    expect(dockerfile).toMatch(new RegExp(`^ARG ${ARG_NAME}=`, 'm'));
  });

  /**
   * Declaring the ARG is not enough — buildx only invalidates a layer whose
   * *command string* changes, so the value has to be referenced inside the
   * same RUN that upgrades. An ARG declared and never interpolated is a
   * no-op that reads as a fix.
   */
  it('interpolates it inside the RUN that upgrades', () => {
    expect(aptUpgradeRun()).toContain(`\${${ARG_NAME}}`);
  });

  it('is passed by the image build, so the default never takes effect in CI', () => {
    expect(deployWorkflow).toContain(`${ARG_NAME}=\${{ github.run_id }}`);
  });

  /**
   * A constant would compile, pass the two checks above, and restore the bug
   * on the second build. Only a per-run value keeps the layer uncacheable.
   */
  it('passes a per-run value, not a constant', () => {
    const passed = deployWorkflow.match(new RegExp(`${ARG_NAME}=(.+)`))?.[1]?.trim();
    expect(passed).toBeDefined();
    expect(passed).toMatch(/\$\{\{/);
  });

  /**
   * Every step that PUSHES the main image must pass it, not only the release one:
   * the edge build (#1456) read the release's gha cache without it, so it
   * shipped a pre-fix OpenSSL and Trivy (#1462) blocked every edge deploy on
   * 2026-09-30 — #730 again on a path that did not exist when #730 was fixed.
   */
  it.each(pushingMainImageBuilds())('%s passes a per-run value', (_where, block) => {
    expect(block).toMatch(new RegExp(`${ARG_NAME}=\\$\\{\\{ github\\.run_id \\}\\}`));
  });
});

/** Each build-push step that pushes the root or the analysis Dockerfile. */
function pushingMainImageBuilds(): [string, string][] {
  const dir = resolve(ROOT, '.github/workflows');
  const out: [string, string][] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    const steps = readFileSync(resolve(dir, f), 'utf8').split(/\n(?=\s+- )/);
    steps.forEach((step, i) => {
      const buildsMain =
        /docker\/build-push-action/.test(step) &&
        /context: (\.|packages\/analysis)\s*$/m.test(step) &&
        !/^\s+file:/m.test(step);
      const pushes = /push=true|^\s+push: true/m.test(step);
      if (buildsMain && pushes) out.push([`${f} step ${i}`, step]);
    });
  }
  return out;
}

/**
 * The analysis image had no upgrade at all, and the edge job reuses the last
 * release's analysis image when its sources are unchanged: on 2026-09-30 that
 * image (v0.8.105) carried OpenSSL deb13u2 and failed the edge Trivy scan.
 */
describe(`${ARG_NAME} in the analysis image`, () => {
  const analysis = readFileSync(resolve(ROOT, 'packages/analysis/Dockerfile'), 'utf8');
  const upgradeRun = analysis
    .replace(/\\\n/g, ' ')
    .split('\n')
    .find((l) => /^RUN .*apt-get upgrade/.test(l));

  it('declares the arg', () => {
    expect(analysis).toMatch(new RegExp(`^ARG ${ARG_NAME}=`, 'm'));
  });

  it('upgrades inside a RUN that interpolates it', () => {
    expect(upgradeRun).toBeDefined();
    expect(upgradeRun).toContain(`\${${ARG_NAME}}`);
  });
});
