import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * A compiled copy of a test file is collected by `bun test` like the source
 * (#1426): `typecheck` emits packages/desktop/dist-scripts/*.test.js, which the
 * root scripts did not ignore, so 29 desktop tests ran twice after any typecheck.
 * Every tsconfig `outDir` must therefore be ignored by every root test script.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

const outDirNames = execFileSync('git', ['ls-files', '*tsconfig*.json'], { cwd: repoRoot })
  .toString()
  .split('\n')
  .filter(Boolean)
  .flatMap((f) => [...readFileSync(join(repoRoot, f), 'utf8').matchAll(/"outDir":\s*"([^"]+)"/g)])
  .map((m) => m[1]!.split('/').find((seg) => seg !== '.' && seg !== '..')!);

const scripts = (
  JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const testScripts = ['test', 'test:tdd', 'test:coverage'];

describe('root test scripts ignore build output', () => {
  it('finds the outDirs it guards', () => {
    expect(outDirNames).toContain('dist-scripts');
  });

  it.each(testScripts.flatMap((s) => [...new Set(outDirNames)].map((d) => [s, d])))(
    '%s ignores **/%s/**',
    (script, dir) => {
      expect(scripts[script]).toContain(`--path-ignore-patterns='**/${dir}/**'`);
    },
  );
});
