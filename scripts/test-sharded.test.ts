import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { discover, filesRan, parseArgs, shard } from './test-sharded';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const rootTest = (
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts.test!;

describe('filesRan', () => {
  it("reads the file count from bun test's summary, colour codes and all", () => {
    expect(filesRan('\x1b[1mRan 12 tests across 3 files.\x1b[0m [1.2s]')).toBe(3);
    expect(filesRan('Ran 1 test across 1 file. [5ms]')).toBe(1);
    expect(filesRan('no summary')).toBeNull();
  });
});

describe('shard', () => {
  it('deals round-robin, so neighbours in the sorted list land apart', () => {
    expect(shard(['a1', 'a2', 'a3', 'b1', 'b2'], 2)).toEqual([
      ['a1', 'a3', 'b2'],
      ['a2', 'b1'],
    ]);
  });

  it('never makes an empty shard', () => {
    expect(shard(['a'], 8)).toEqual([['a']]);
  });
});

describe('parseArgs', () => {
  it('splits roots, ignores and pass-through flags', () => {
    expect(parseArgs(['scripts', "--path-ignore-patterns='**/dist/**'", '--bail'])).toEqual({
      roots: ['scripts'],
      ignores: ['**/dist/**'],
      passthrough: ['--bail'],
    });
  });

  it('runs a file or a filter unsharded', () => {
    expect(parseArgs(['scripts/test-sharded.test.ts'])).toBeNull();
    expect(parseArgs(['--bail'])).toBeNull();
  });
});

describe('the root test script', () => {
  it('shards', () => {
    expect(rootTest.startsWith('bun scripts/test-sharded.ts ')).toBe(true);
  });

  it('finds every file bun test would collect, and skips what it ignores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-'));
    const touch = (rel: string) => {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), '');
    };
    for (const f of [
      'pkg/a.test.ts',
      'pkg/b_test.js',
      'pkg/c.spec.tsx',
      'pkg/d_spec.mjs',
      'pkg/not-a-test.ts',
      'pkg/dist/e.test.js',
      'pkg/node_modules/x/f.test.ts',
      'web/src/g.spec.ts',
    ])
      touch(f);
    try {
      expect(discover(dir, ['pkg', 'web'], ['**/dist/**', '**/web/src/**'])).toEqual([
        'pkg/a.test.ts',
        'pkg/b_test.js',
        'pkg/c.spec.tsx',
        'pkg/d_spec.mjs',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
