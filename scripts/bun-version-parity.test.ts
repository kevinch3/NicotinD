import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * CI, the desktop package and the prod image must run ONE Bun. Workflows pinned
 * 1.3.11 while the image shipped 1.3.14, and 1.3.11 crashes starting a Worker
 * (#1409): e2e shards died mid-run, and the desktop app ships the packaging
 * job's own binary (`prepare-resources.ts`), so its users ran the crashing one.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

const imageVersions = [
  ...read('Dockerfile').matchAll(/^FROM \S*bun(?:-node)?:(\d+\.\d+\.\d+)/gm),
].map((m) => m[1]);
const workflowPins = readdirSync(join(repoRoot, '.github/workflows'))
  .filter((f) => f.endsWith('.yml'))
  .flatMap((f) =>
    [...read(`.github/workflows/${f}`).matchAll(/^\s*BUN_VERSION:\s*'([^']+)'/gm)].map((m) => [
      f,
      m[1],
    ]),
  );

describe('Bun version parity', () => {
  it('finds the prod image and the workflow pins it compares', () => {
    expect(imageVersions.length).toBeGreaterThanOrEqual(2);
    expect(workflowPins.length).toBeGreaterThanOrEqual(4);
  });

  it('every Dockerfile stage runs the same Bun', () => {
    expect(new Set(imageVersions).size).toBe(1);
  });

  it.each(workflowPins)('%s pins the Bun the prod image ships', (_file, version) => {
    expect(version).toBe(imageVersions[0]);
  });
});
