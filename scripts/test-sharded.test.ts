import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { discover, parseArgs, shard } from './test-sharded';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const rootTest = (
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts.test!;

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

  // The gate asserts its own denominator: sharding must run exactly the files a
  // single `bun test` with the same arguments would.
  it('finds the same files a single bun test searches', () => {
    const args = rootTest.split(' ').slice(2);
    const plan = parseArgs(args)!;
    const mine = discover(repoRoot, plan.roots, plan.ignores).length;
    const res = Bun.spawnSync(
      [
        'bun',
        'test',
        ...args.map((a) => a.replace(/='(.*)'$/, '=$1')),
        '-t',
        '^no test is named this$',
      ],
      { cwd: repoRoot, stderr: 'pipe', stdout: 'pipe' },
    );
    const searched = /Searched (\d+) files/.exec(res.stderr.toString() + res.stdout.toString());
    expect(searched).not.toBeNull();
    expect(mine).toBe(Number(searched![1]));
  }, 60_000);
});
