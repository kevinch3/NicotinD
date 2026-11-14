/**
 * `bun test` in N sequential processes, so the suite fits a small machine (#1906).
 *
 *   bun scripts/test-sharded.ts <roots…> [--path-ignore-patterns=<glob>…] [bun test flags…]
 *   TEST_SHARDS=1 bun run test        # one process, as before
 *
 * One `bun test` process never hands memory back between files: the whole
 * backend suite peaked at 6.2 GB RSS in one process, against 1.3 GB for its
 * heaviest single file. A fresh process per shard bounds the peak by the
 * shard, and was faster too (4 shards: 2 m 43 s against 4 m 25 s). Files are
 * dealt round-robin from the sorted list, so a family that sorts together (the
 * `library-scanner.*` tests, the heaviest) spreads across shards instead of
 * stacking in one.
 *
 * Arguments naming a file or a test filter (anything that is not a root
 * directory or a flag) run as one plain `bun test`, unsharded.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const DEFAULT_SHARDS = 8;
/** What `bun test` collects: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`. */
const TEST_FILE = /[._](test|spec)\.(c|m)?[jt]sx?$/;

export interface ShardPlan {
  roots: string[];
  ignores: string[];
  passthrough: string[];
}

export function parseArgs(argv: readonly string[]): ShardPlan | null {
  const plan: ShardPlan = { roots: [], ignores: [], passthrough: [] };
  for (const arg of argv) {
    const ignore = /^--path-ignore-patterns=(.+)$/.exec(arg);
    if (ignore) plan.ignores.push(ignore[1]!.replace(/^'(.*)'$/, '$1'));
    else if (arg.startsWith('-')) plan.passthrough.push(arg);
    else if (isDir(arg)) plan.roots.push(arg);
    else return null;
  }
  return plan.roots.length ? plan : null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The test files under `roots` that `bun test` would run, repo-relative and sorted. */
export function discover(
  cwd: string,
  roots: readonly string[],
  ignores: readonly string[],
): string[] {
  const globs = ignores.map((p) => new Bun.Glob(p));
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
      const path = join(dir, entry.name);
      const rel = relative(cwd, path);
      if (entry.isDirectory()) {
        if (!globs.some((g) => g.match(`${rel}/x`))) walk(path);
      } else if (TEST_FILE.test(entry.name) && !globs.some((g) => g.match(rel))) {
        found.push(rel);
      }
    }
  };
  for (const root of roots) walk(resolve(cwd, root));
  return [...new Set(found)].sort();
}

/** Deal files round-robin into at most `n` non-empty shards. */
export function shard<T>(files: readonly T[], n: number): T[][] {
  const count = Math.max(1, Math.min(n, files.length));
  const shards: T[][] = Array.from({ length: count }, () => []);
  files.forEach((f, i) => shards[i % count]!.push(f));
  return shards;
}

function run(args: string[]): number {
  return Bun.spawnSync(['bun', 'test', ...args], { stdio: ['inherit', 'inherit', 'inherit'] })
    .exitCode;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const plan = parseArgs(argv);
  if (!plan) process.exit(run(argv));

  const files = discover(process.cwd(), plan.roots, plan.ignores);
  if (files.length === 0) {
    // A gate that finds nothing to run must say so, not pass (docs/quality-gates.md).
    console.error(`[test] no test files under ${plan.roots.join(' ')}`);
    process.exit(1);
  }
  const n = Number(process.env.TEST_SHARDS) || DEFAULT_SHARDS;
  const shards = shard(files, n);
  const failed: number[] = [];
  shards.forEach((group, i) => {
    console.error(`\n[test] shard ${i + 1}/${shards.length}: ${group.length} files`);
    if (run([...plan.passthrough, ...group.map((f) => `./${f}`)]) !== 0) failed.push(i + 1);
  });
  console.error(
    `\n[test] ${files.length} files in ${shards.length} shards` +
      (failed.length ? ` — FAILED in shard ${failed.join(', ')}` : ' — all passed'),
  );
  process.exit(failed.length ? 1 : 0);
}
