import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #453: the About page's AGPL §13 offer points at the commit the running
 * bundle was built from, and that sha reaches the bundle only through a build
 * arg the web-builder stage forwards to `ng build --define`.
 *
 * Both ends have to stay wired, and neither can verify the other: the
 * Dockerfile's own `ARG` default makes a build succeed with no sha at all, so a
 * workflow that stops passing one produces a green deploy whose source offer
 * silently degrades to the repository root. Same shape as `APT_REFRESH`
 * (#730) — a mechanism that looks present and stamps nothing.
 */
const ROOT = resolve(import.meta.dir, '..');
const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');
const deployWorkflow = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');

const ARG_NAME = 'NICOTIND_BUILD_COMMIT';

/**
 * The one logical `RUN` that builds the web bundle, rejoined across its `\`
 * continuations — a loose regex spans neighbouring instructions and "finds" the
 * arg in the wrong one (see the same helper in dockerfile-apt-refresh.test.ts).
 */
function webBuildRun(): string {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of dockerfile.split('\n')) {
    if (current.length === 0 && !line.startsWith('RUN ')) continue;
    current.push(line);
    if (!line.trimEnd().endsWith('\\')) {
      blocks.push(current.join('\n'));
      current = [];
    }
  }
  const matches = blocks.filter((b) => b.includes('packages/web && bun run build'));
  // Exactly one, or "the web build layer" is no longer a single thing.
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe(`${ARG_NAME} stamps the web bundle (#453)`, () => {
  it('declares the arg in the Dockerfile', () => {
    expect(dockerfile).toMatch(new RegExp(`^ARG ${ARG_NAME}=`, 'm'));
  });

  /** Declared and never interpolated is a no-op that reads as a fix. */
  it('passes it to the build that produces the bundle', () => {
    const run = webBuildRun();
    expect(run).toContain(`$${ARG_NAME}`);
    // esbuild's --define needs the value quoted as JSON; printf supplies those
    // quotes without backslashes the Dockerfile parser would also claim.
    expect(run).toContain('--define');
    expect(run).toMatch(/printf '"%s"'/);
  });

  it('is passed by the image build, so the ARG default never takes effect in CI', () => {
    // Read the `build-args:` blocks rather than the whole file: an arg named in
    // a comment somewhere else would satisfy a file-wide `toContain`, and a
    // failure would print 800 lines of workflow instead of the one block.
    const buildArgs = [...deployWorkflow.matchAll(/^ {10}build-args: \|\n((?: {12}\S.*\n)+)/gm)].map(
      (m) => m[1]!,
    );
    expect(buildArgs.length).toBeGreaterThan(0);
    expect(buildArgs.join('')).toContain(`${ARG_NAME}=\${{ github.sha }}`);
  });
});
