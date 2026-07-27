/**
 * Run every spec file **on its own** and report the ones that only pass as part
 * of the full suite (issue #307).
 *
 *   bun run check:isolated-specs          # api + web
 *   bun run check:isolated-specs --api    # api only (fast)
 *   bun run check:isolated-specs --web
 *
 * WHY: CI runs the whole suite, so an order-dependent spec is **invisible there
 * by construction**. It only bites someone running one file while iterating —
 * exactly when a red-for-no-reason suite costs the most. One real instance was
 * found by accident (`routes/review.test.ts`: two tests asserted `errors` was
 * empty, while the default `orphanRows` gatherer calls
 * `countOrphanRows(getDatabase())`, which throws unless an earlier file had
 * already called `initDatabase`).
 *
 * NOT wired into the per-PR `ci` job, deliberately. The full sweep measured
 * **1 order-dependent file out of 307**, and re-running 307 separate test
 * processes costs minutes — a poor trade per PR for a once-a-year defect. It is
 * a tool to reach for when a spec behaves oddly alone, or to run periodically.
 *
 * The usual causes are shared global state: `getDatabase()`, module-level caches
 * (the cover negative-cache, the GPU probe cache), and on the web side
 * `providedIn: 'root'` services plus anything persisted to `localStorage`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Recursively collect files matching a suffix, skipping build output. */
export function collectSpecs(root: string, suffix: string, acc: string[] = []): string[] {
  if (!existsSync(root)) return acc;
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.worktrees') continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) collectSpecs(full, suffix, acc);
    else if (entry.endsWith(suffix)) acc.push(full);
  }
  return acc;
}

/** A spec run is "green" when the runner reports no failures. */
export function isGreen(output: string, runner: 'bun' | 'vitest'): boolean {
  return runner === 'bun' ? /^\s*0 fail/m.test(output) : /Tests\s+\d+ passed/.test(output);
}

function runOne(file: string, runner: 'bun' | 'vitest'): boolean {
  const [cmd, args, cwd] =
    runner === 'bun'
      ? (['bun', ['test', file], repoRoot] as const)
      : (['bunx', ['vitest', 'run', file], join(repoRoot, 'packages/web')] as const);
  const res = spawnSync(cmd, [...args], { cwd, encoding: 'utf8' });
  return isGreen(`${res.stdout ?? ''}${res.stderr ?? ''}`, runner);
}

function main(): void {
  const argv = process.argv.slice(2);
  const wantApi = argv.includes('--api') || !argv.includes('--web');
  const wantWeb = argv.includes('--web') || !argv.includes('--api');

  const targets: Array<{ file: string; runner: 'bun' | 'vitest' }> = [];
  if (wantApi) {
    for (const f of collectSpecs(join(repoRoot, 'packages/api/src'), '.test.ts')) {
      targets.push({ file: f, runner: 'bun' });
    }
  }
  if (wantWeb) {
    for (const f of collectSpecs(join(repoRoot, 'packages/web/src'), '.spec.ts')) {
      // vitest resolves relative to packages/web.
      targets.push({ file: f.slice(join(repoRoot, 'packages/web/').length), runner: 'vitest' });
    }
  }

  console.log(`Running ${targets.length} spec file(s) in isolation — this takes minutes.\n`);
  const failures: string[] = [];
  for (const t of targets) {
    if (!runOne(t.file, t.runner)) {
      failures.push(t.file);
      console.log(`  ✗ ${t.file}`);
    }
  }

  if (!failures.length) {
    console.log(`\nAll ${targets.length} spec files pass on their own.`);
    return;
  }
  console.error(`\n${failures.length} of ${targets.length} spec file(s) fail in isolation:\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nUsually shared global state: getDatabase(), a module-level cache, a\n' +
      "providedIn:'root' service, or something persisted to localStorage.",
  );
  process.exit(1);
}

if (import.meta.main) main();
