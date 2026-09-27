import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * A hold that does not match is not a hold. The CUDA-11 ABI lock was scoped to
 * the pip managers, Renovate reads packages/analysis/pyproject.toml with its
 * `poetry` manager, and the first real run proposed `numpy<3` and cuDNN 9.
 * Holds therefore match by package name, never by manager.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

type Rule = {
  matchPackageNames?: string[];
  matchManagers?: string[];
  allowedVersions?: string;
  enabled?: boolean;
};
const rules = (
  JSON.parse(readFileSync(join(repoRoot, 'renovate.json'), 'utf8')) as { packageRules: Rule[] }
).packageRules;

const holdFor = (name: string): Rule | undefined =>
  rules.find(
    (r) =>
      (r.allowedVersions !== undefined || r.enabled === false) &&
      r.matchPackageNames?.includes(name),
  );

describe('renovate.json holds', () => {
  it('scopes no hold by manager', () => {
    const scoped = rules.filter(
      (r) => (r.allowedVersions !== undefined || r.enabled === false) && r.matchManagers,
    );
    expect(scoped).toEqual([]);
  });

  it.each(['essentia-tensorflow', 'numpy', 'nvidia-**'])(
    'disables the ABI-locked %s outright',
    (name) => {
      expect(holdFor(name)?.enabled).toBe(false);
    },
  );

  it.each([
    ['com.android.tools.build:gradle', '<9'],
    ['gradle', '<9'],
    ['java-jdk', '<22'],
    ['macos', '<26'],
    ['@capacitor/**', '<7'],
  ])('holds %s with Capacitor 6 (%s)', (name, range) => {
    expect(holdFor(name)?.allowedVersions).toBe(range);
  });

  it('keeps linuxserver/lidarr off its 0.8-era 8.x tags', () => {
    expect(holdFor('linuxserver/lidarr')?.allowedVersions).toBe('<8');
  });
});
